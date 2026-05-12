'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { parse } = require('@babel/parser');

/**
 * Layer 3: undo TypeScript ES5 helpers (__extends, __decorate) and restore
 * native class + decorator syntax.
 *
 * Implementation note: webcrack's `unminify` pass handles `__extends` (it
 * recognizes the IIFE shape and emits a class). For `__decorate` we run a
 * focused post-pass because webcrack 2.16.x leaves the assignment form alone
 * (it cannot prove decorators are side-effect-free in general). Cocos always
 * uses pure decorator factories so the transform is sound for our domain.
 */
async function restoreClasses(ast, _mod) {
  if (!ast) return null;

  // 1. Hand off to webcrack for __extends collapsing. Webcrack consumes source
  //    text, not AST — we round-trip via generator/parse.
  const before = generate(ast, { compact: false }).code;
  let mid;
  try {
    let webcrackFn;
    try {
      // CommonJS path (webcrack ships dist/index.cjs).
      ({ webcrack: webcrackFn } = require('webcrack'));
    } catch (cjsErr) {
      // Fallback to dynamic ESM import.
      const mod = await import('webcrack');
      webcrackFn = mod.webcrack || (mod.default && mod.default.webcrack);
    }
    if (typeof webcrackFn !== 'function') throw new Error('webcrack not callable');
    const result = await webcrackFn(before, {
      jsx: false,
      mangle: false,
      unminify: true,
      deobfuscate: false,
      unpack: false,
    });
    mid = parse(result.code, {
      sourceType: 'module',
      plugins: ['decorators-legacy', 'classProperties'],
    });
  } catch (_err) {
    // Fail-closed: keep original AST.
    mid = ast;
  }

  // 2. Fold standalone `Class = __decorate([...], Class);` assignments into
  //    `@decorator class Class { ... }` declarations.
  foldDecorate(mid);

  return mid;
}

/**
 * Find statements of the form:
 *   X = __decorate([d1, d2, ...], X);
 * and merge the decorator list into the most recent `class X { ... }` declaration
 * appearing earlier in the same Program. Then remove the standalone assignment.
 */
function foldDecorate(ast) {
  traverse(ast, {
    Program(path) {
      const body = path.node.body;
      const toRemove = [];
      for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        const target = matchDecorateAssign(stmt);
        if (!target) continue;
        const { className, decorators } = target;
        let attached = false;
        for (let j = i - 1; j >= 0; j--) {
          const decl = unwrapClassDecl(body[j]);
          if (decl && t.isClassDeclaration(decl) && decl.id && decl.id.name === className) {
            decl.decorators = (decl.decorators || []).concat(decorators);
            attached = true;
            break;
          }
        }
        if (attached) toRemove.push(i);
      }
      for (let k = toRemove.length - 1; k >= 0; k--) body.splice(toRemove[k], 1);
    },
  });
}

function matchDecorateAssign(stmt) {
  if (!t.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr, { operator: '=' })) return null;
  if (!t.isIdentifier(expr.left)) return null;
  if (!t.isCallExpression(expr.right)) return null;
  if (!t.isIdentifier(expr.right.callee, { name: '__decorate' })) return null;
  const args = expr.right.arguments;
  if (args.length < 2 || !t.isArrayExpression(args[0])) return null;
  if (!t.isIdentifier(args[1]) || args[1].name !== expr.left.name) return null;
  return {
    className: expr.left.name,
    decorators: args[0].elements.filter(Boolean).map((el) => t.decorator(el)),
  };
}

function unwrapClassDecl(stmt) {
  if (t.isClassDeclaration(stmt)) return stmt;
  if (t.isExportNamedDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  if (t.isExportDefaultDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  return null;
}

module.exports = { restoreClasses };
