'use strict';

const t = require('@babel/types');

/**
 * Layer 2: convert SystemJS execute body + setterBindings into ESM:
 *  - setterBindings → top-level `import { local as imported? } from 'dep'`
 *  - `_export("name", expr)` → `export let name = expr` (or `export default expr`
 *    when name === 'default').
 *  - `_export("default", void 0)` placeholder calls are dropped.
 *  - Removes `"use strict"` directive (ESM is strict by default).
 */
async function rebuildEsm(ast, mod) {
  if (!ast) return null;
  const program = ast.program;
  const newBody = [];

  for (const setter of mod.setterBindings || []) {
    if (!setter.dep || !setter.bindings.length) continue;
    const specifiers = setter.bindings.map((b) =>
      t.importSpecifier(t.identifier(b.local), t.identifier(b.imported))
    );
    newBody.push(t.importDeclaration(specifiers, t.stringLiteral(setter.dep)));
  }

  const exported = new Set();
  for (const stmt of program.body) {
    if (t.isDirective(stmt)) continue;

    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: '_export' }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0]) &&
      t.isUnaryExpression(stmt.expression.arguments[1], { operator: 'void' })
    ) {
      continue;
    }

    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: '_export' }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0])
    ) {
      const exportName = stmt.expression.arguments[0].value;
      const valueExpr = stmt.expression.arguments[1];
      if (exportName === 'default') {
        newBody.push(t.exportDefaultDeclaration(valueExpr));
      } else {
        if (!exported.has(exportName)) {
          exported.add(exportName);
          newBody.push(
            t.exportNamedDeclaration(
              t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(exportName), valueExpr),
              ]),
              []
            )
          );
        } else {
          newBody.push(
            t.expressionStatement(
              t.assignmentExpression('=', t.identifier(exportName), valueExpr)
            )
          );
        }
      }
      continue;
    }

    newBody.push(stmt);
  }

  program.body = newBody;
  return ast;
}

module.exports = { rebuildEsm };
