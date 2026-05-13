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

    newBody.push(stmt);
  }

  program.body = newBody;
  return ast;
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
