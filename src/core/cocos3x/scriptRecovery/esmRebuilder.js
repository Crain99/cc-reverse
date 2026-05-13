'use strict';

const t = require('@babel/types');

/**
 * Layer 2: convert SystemJS execute body + setterBindings into ESM:
 *  - setterBindings → top-level `import { local as imported? } from 'dep'`
 *  - `_export("name", expr)` → `export let name = expr` (or `export default expr`
 *    when name === 'default').
 *  - `_export({ a: x, b: y })` → batch `export let a = x; export let b = y;`
 *    (terser/webcrack often collapse multiple _export calls into one object
 *    literal — common in Cocos's own pipeline modules).
 *  - `_export("default", void 0)` placeholder calls are dropped.
 *  - Removes `"use strict"` directive (ESM is strict by default).
 *
 * The `_export` identifier name comes from `mod.exportParam` (captured by
 * chunkSplitter from the System.register factory's first parameter). After
 * minification this is usually a single letter (`e`, `r`); we fall back to
 * `_export` when the splitter could not capture it (defensive).
 *
 * Relative dep paths ending in `.js`/`.mjs` get the suffix stripped — Cocos
 * 3.8's typescript importer matches the literal string against the .ts file
 * stem and would otherwise report `Module './X.js' not found`.
 */
async function rebuildEsm(ast, mod) {
  if (!ast) return null;
  const program = ast.program;
  const newBody = [];
  const exportName = (mod && mod.exportParam) || '_export';

  for (const setter of mod.setterBindings || []) {
    if (!setter.dep || !setter.bindings.length) continue;
    const specifiers = setter.bindings.map((b) =>
      t.importSpecifier(t.identifier(b.local), t.identifier(b.imported))
    );
    newBody.push(t.importDeclaration(specifiers, t.stringLiteral(normalizeDep(setter.dep))));
  }

  const exported = new Set();
  for (const stmt of program.body) {
    if (t.isDirective(stmt)) continue;

    // Drop placeholder `_export("default", void 0)`.
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: exportName }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0]) &&
      t.isUnaryExpression(stmt.expression.arguments[1], { operator: 'void' })
    ) {
      continue;
    }

    // `_export("name", expr)` — single named export.
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: exportName }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0])
    ) {
      pushExport(newBody, exported, stmt.expression.arguments[0].value, stmt.expression.arguments[1]);
      continue;
    }

    // `_export({ a: x, b: y, ... })` — batch object form. Each property
    // becomes a top-level export. Skip non-string keys.
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: exportName }) &&
      stmt.expression.arguments.length === 1 &&
      t.isObjectExpression(stmt.expression.arguments[0])
    ) {
      for (const prop of stmt.expression.arguments[0].properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const k = t.isIdentifier(prop.key) ? prop.key.name
          : (t.isStringLiteral(prop.key) ? prop.key.value : null);
        if (!k) continue;
        // Object property values may be Expressions (function/identifier/etc).
        // Wrap PatternLiteral in `(…)`-safe expression by trusting babel types.
        if (!t.isExpression(prop.value)) continue;
        pushExport(newBody, exported, k, prop.value);
      }
      continue;
    }

    // `var X = _export("Name", expr)` (or comma-list of declarators) — common
    // in vendor libs where the assigned local doubles as the export. Rewrite
    // each matching declarator to drop the export wrapper, and append a
    // re-export `export { X as Name }`. Non-matching declarators are kept
    // as-is so the var still appears.
    if (t.isVariableDeclaration(stmt)) {
      const renames = [];
      for (const dec of stmt.declarations) {
        const stripped = stripExportCall(dec.init, exportName);
        if (stripped && t.isIdentifier(dec.id)) {
          dec.init = stripped.expr;
          renames.push({ local: dec.id.name, exported: stripped.name });
        }
      }
      newBody.push(stmt);
      for (const r of renames) {
        if (r.exported === 'default') {
          newBody.push(t.exportDefaultDeclaration(t.identifier(r.local)));
        } else if (!exported.has(r.exported)) {
          exported.add(r.exported);
          newBody.push(
            t.exportNamedDeclaration(null, [
              t.exportSpecifier(t.identifier(r.local), t.identifier(r.exported)),
            ])
          );
        }
      }
      continue;
    }

    // `X = _export("Name", expr)` assignment expression statement.
    if (
      t.isExpressionStatement(stmt) &&
      t.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
      t.isIdentifier(stmt.expression.left)
    ) {
      const stripped = stripExportCall(stmt.expression.right, exportName);
      if (stripped) {
        stmt.expression.right = stripped.expr;
        newBody.push(stmt);
        const localName = stmt.expression.left.name;
        if (stripped.name === 'default') {
          newBody.push(t.exportDefaultDeclaration(t.identifier(localName)));
        } else if (!exported.has(stripped.name)) {
          exported.add(stripped.name);
          newBody.push(
            t.exportNamedDeclaration(null, [
              t.exportSpecifier(t.identifier(localName), t.identifier(stripped.name)),
            ])
          );
        }
        continue;
      }
    }

    newBody.push(stmt);
  }

  program.body = newBody;

  // Inject identity shim `function <exportName>(_n, v) { return v; }` if any
  // residual reference to exportName remains (vendor libs use it in nested
  // expression contexts we don't statically rewrite). Skip when the symbol is
  // already shadowed by an import/var declaration in the rebuilt body, or when
  // exportName equals the safe '_export' default (means splitter never picked
  // it up — not a real binding to shim).
  if (mod && mod.exportParam && referencesIdentifier(program, exportName) && !declaresIdentifier(program, exportName)) {
    program.body.unshift(
      t.functionDeclaration(
        t.identifier(exportName),
        [t.identifier('_n'), t.identifier('_v')],
        t.blockStatement([t.returnStatement(t.identifier('_v'))])
      )
    );
  }

  return ast;
}

// Match `_export("Name", expr)` inside arbitrary positions; return { name, expr }
// or null. Only matches the 2-arg string-literal form (object-literal batch is
// always a top-level ExpressionStatement, handled separately).
function stripExportCall(node, exportName) {
  if (!node || !t.isCallExpression(node)) return null;
  if (!t.isIdentifier(node.callee, { name: exportName })) return null;
  if (node.arguments.length !== 2) return null;
  if (!t.isStringLiteral(node.arguments[0])) return null;
  if (!t.isExpression(node.arguments[1])) return null;
  return { name: node.arguments[0].value, expr: node.arguments[1] };
}

function referencesIdentifier(program, name) {
  let found = false;
  function visit(n) {
    if (found || !n || typeof n !== 'object') return;
    if (n.type === 'Identifier' && n.name === name) { found = true; return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === 'object' && v.type) visit(v);
    }
  }
  visit(program);
  return found;
}

function declaresIdentifier(program, name) {
  for (const stmt of program.body) {
    if (t.isImportDeclaration(stmt)) {
      for (const sp of stmt.specifiers) if (sp.local && sp.local.name === name) return true;
    } else if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations) if (t.isIdentifier(d.id, { name })) return true;
    } else if ((t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) && stmt.id && stmt.id.name === name) {
      return true;
    }
  }
  return false;
}

function pushExport(body, exported, name, valueExpr) {
  if (name === 'default') {
    body.push(t.exportDefaultDeclaration(valueExpr));
    return;
  }
  if (!exported.has(name)) {
    exported.add(name);
    body.push(
      t.exportNamedDeclaration(
        t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier(name), valueExpr),
        ]),
        []
      )
    );
  } else {
    body.push(
      t.expressionStatement(
        t.assignmentExpression('=', t.identifier(name), valueExpr)
      )
    );
  }
}

// Strip .js/.mjs/.ts from relative imports; leave bare specifiers ('cc') alone.
// Cocos 3.8's TS importer matches the literal specifier against module paths
// without an extension; `'./X.js'` or `'./X.ts'` would both fail to resolve.
function normalizeDep(dep) {
  if (typeof dep !== 'string') return dep;
  if (!(dep.startsWith('./') || dep.startsWith('../'))) return dep;
  return dep.replace(/\.(m?js|ts)$/i, '');
}

module.exports = { rebuildEsm };
