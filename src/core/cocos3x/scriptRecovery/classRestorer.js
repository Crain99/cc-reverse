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

  // 2. Fold any leftover `var X = (function(_super){ __extends(X,_super); ... return X; }(Super))`
  //    IIFE that webcrack only stripped parentheses from. This produces a
  //    native ClassDeclaration so step 3 can attach decorators.
  foldExtendsIife(mid);

  // 3. Fold standalone `Class = __decorate([...], Class);` assignments into
  //    `@decorator class Class { ... }` declarations.
  foldDecorate(mid);

  return mid;
}

/**
 * Detect statement-level `var X = (function(_super){ __extends(X,_super); ... return X; }(Super));`
 * (with or without the outer ParenthesizedExpression) and rewrite it to a
 * native `class X extends Super { ... }` declaration.
 *
 * MVP scope (sufficient for the Cocos domain):
 *   - constructor `function X(params){ body }` → `constructor(params){ body }`,
 *     unless the body is a pure super-forwarder (`return _super.apply(this, arguments) || this;`
 *     or `return _super.call(this, ...args) || this;`), in which case constructor is omitted
 *     and the JS engine's default constructor handles forwarding.
 *   - prototype methods `X.prototype.m = function(params){ body }` → `m(params){ body }`.
 *   - prototype non-function fields and static assignments are dropped (rare in
 *     compiled cocos scripts; can be added later if needed).
 */
function foldExtendsIife(ast) {
  traverse(ast, {
    VariableDeclaration(path) {
      // Only handle top-level / block-level `var X = ...;` with a single declarator.
      const decls = path.node.declarations;
      if (decls.length !== 1) return;
      const decl = decls[0];
      if (!t.isIdentifier(decl.id) || !decl.init) return;

      const className = decl.id.name;
      const match = matchExtendsIife(decl.init, className);
      if (!match) return;

      const { superExpr, fnBody } = match;
      const members = buildClassMembers(fnBody, className);
      if (members === null) return; // structure didn't match expectations; skip

      const classDecl = t.classDeclaration(
        t.identifier(className),
        superExpr,
        t.classBody(members),
      );
      // Remove the existing `var X` binding before replacing, otherwise Babel's
      // scope tracker raises "Duplicate declaration" when the new ClassDeclaration
      // tries to register the same name in the same block scope.
      if (path.scope && path.scope.removeBinding) {
        path.scope.removeBinding(className);
      }
      path.replaceWith(classDecl);
    },
  });
}

function unwrapParen(node) {
  while (node && (t.isParenthesizedExpression?.(node) || node.type === 'ParenthesizedExpression')) {
    node = node.expression;
  }
  return node;
}

function matchExtendsIife(initRaw, className) {
  const init = unwrapParen(initRaw);
  if (!t.isCallExpression(init)) return null;
  if (init.arguments.length !== 1) return null;
  const superExpr = init.arguments[0];

  const callee = unwrapParen(init.callee);
  if (!t.isFunctionExpression(callee)) return null;
  if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0], { name: '_super' })) return null;

  const body = callee.body.body;
  if (body.length < 2) return null;

  // First statement: __extends(<className>, _super);
  const first = body[0];
  if (!t.isExpressionStatement(first)) return null;
  const fcall = first.expression;
  if (!t.isCallExpression(fcall)) return null;
  if (!t.isIdentifier(fcall.callee, { name: '__extends' })) return null;
  if (fcall.arguments.length !== 2) return null;
  if (!t.isIdentifier(fcall.arguments[0], { name: className })) return null;
  if (!t.isIdentifier(fcall.arguments[1], { name: '_super' })) return null;

  // Last statement: return <className>;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last)) return null;
  if (!t.isIdentifier(last.argument, { name: className })) return null;

  return { superExpr, fnBody: body };
}

function buildClassMembers(fnBody, className) {
  const members = [];
  // Iterate the IIFE body skipping the leading __extends and trailing return.
  for (let i = 1; i < fnBody.length - 1; i++) {
    const stmt = fnBody[i];

    // Constructor: `function ClassName(params) { body }`
    if (t.isFunctionDeclaration(stmt) && stmt.id && stmt.id.name === className) {
      if (isPureSuperForwarder(stmt.body, stmt.params)) continue; // omit, default ctor suffices
      const ctor = t.classMethod(
        'constructor',
        t.identifier('constructor'),
        stmt.params,
        stmt.body,
      );
      members.push(ctor);
      continue;
    }

    // Prototype assignment: `ClassName.prototype.<name> = <value>;`
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: '=' })) {
      const left = stmt.expression.left;
      const right = stmt.expression.right;
      if (
        t.isMemberExpression(left) &&
        t.isMemberExpression(left.object) &&
        t.isIdentifier(left.object.object, { name: className }) &&
        t.isIdentifier(left.object.property, { name: 'prototype' }) &&
        !left.computed &&
        !left.object.computed &&
        t.isIdentifier(left.property)
      ) {
        if (t.isFunctionExpression(right)) {
          const method = t.classMethod(
            'method',
            t.identifier(left.property.name),
            right.params,
            right.body,
          );
          members.push(method);
        }
        // non-function prototype fields: drop in MVP
        continue;
      }
      // static assignments like `ClassName.foo = ...` — drop in MVP.
    }
    // anything else (helper var decls, etc.) — drop in MVP.
  }
  return members;
}

function isPureSuperForwarder(blockBody, params) {
  const stmts = blockBody.body;
  if (stmts.length !== 1) return false;
  const ret = stmts[0];
  if (!t.isReturnStatement(ret) || !ret.argument) return false;

  // Accept `_super.<call|apply>(...) || this`
  let expr = ret.argument;
  if (t.isLogicalExpression(expr, { operator: '||' }) && t.isThisExpression(expr.right)) {
    expr = expr.left;
  }
  if (!t.isCallExpression(expr)) return false;
  const callee = expr.callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: '_super' }) ||
    !t.isIdentifier(callee.property)
  ) return false;
  const method = callee.property.name;
  if (method !== 'call' && method !== 'apply') return false;

  // First arg must be `this`.
  if (expr.arguments.length < 1 || !t.isThisExpression(expr.arguments[0])) return false;

  // Pure forwarder: `_super.apply(this, arguments)` (params irrelevant) OR
  // `_super.call(this, p1, p2, ...)` matching declared params 1:1.
  if (method === 'apply') {
    return expr.arguments.length === 2 && t.isIdentifier(expr.arguments[1], { name: 'arguments' });
  }
  // call: ensure passed args match declared params positionally.
  const passed = expr.arguments.slice(1);
  if (passed.length !== params.length) return false;
  for (let i = 0; i < passed.length; i++) {
    const p = params[i];
    if (!t.isIdentifier(p) || !t.isIdentifier(passed[i], { name: p.name })) return false;
  }
  return true;
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
