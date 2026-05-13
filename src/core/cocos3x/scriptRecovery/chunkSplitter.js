'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

/**
 * Split a chunk file (one .js with N System.register(...) calls) into N modules.
 *
 * Each output module has:
 *  - name: derived from the registerId tail (without .ts/.js extension)
 *  - registerId: the original module id string
 *  - deps: array of dep id strings
 *  - setterBindings: [{ dep, bindings: [{local, imported}] }]
 *  - ast: File AST containing only the execute() body
 *  - source: the original chunk text (kept as fallback)
 */
async function splitChunks(chunk) {
  const { name, source, preminified = false } = chunk;
  let ast;
  try {
    ast = parser.parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (err) {
    return [{ name, registerId: null, deps: [], setterBindings: [], exportParam: null, ast: null, source, preminified }];
  }

  const modules = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (
        !(t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: 'System' }) &&
          t.isIdentifier(callee.property, { name: 'register' }))
      ) return;

      const args = p.node.arguments;
      if (args.length < 2) return;

      let registerId = null;
      let depsNode;
      let factory;
      if (t.isStringLiteral(args[0]) && t.isArrayExpression(args[1])) {
        registerId = args[0].value;
        depsNode = args[1];
        factory = args[2];
      } else if (t.isArrayExpression(args[0])) {
        depsNode = args[0];
        factory = args[1];
      } else {
        return;
      }
      if (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory)) return;

      const deps = depsNode.elements
        .filter((el) => t.isStringLiteral(el))
        .map((el) => el.value);

      const modName = deriveModuleName(registerId, name, modules.length);
      // Capture the factory's first parameter name — terser/webcrack rename
      // `_export` to a single letter (e.g. `e`, `r`). esmRebuilder needs this
      // to recognize export calls like `e("BloomType", ...)`.
      const exportParam = (factory.params && factory.params[0] && t.isIdentifier(factory.params[0]))
        ? factory.params[0].name
        : null;
      const result = extractFactoryBody(factory);
      const setterBindings = result.setterBindings.map((s) => ({
        dep: deps[s._index],
        bindings: s.bindings,
      }));
      modules.push({
        name: modName,
        registerId,
        deps,
        setterBindings,
        exportParam,
        ast: result.bodyAst,
        source,
        preminified,
      });
      p.skip();
    },
  });

  if (modules.length === 0) {
    return [{ name, registerId: null, deps: [], setterBindings: [], exportParam: null, ast: null, source, preminified }];
  }
  return modules;
}

function deriveModuleName(registerId, fallback, index) {
  if (registerId) {
    const tail = registerId.split('/').pop() || `mod${index}`;
    return tail.replace(/\.(ts|js|mjs)$/i, '');
  }
  return `${fallback.replace(/\.js$/, '')}_${index}`;
}

function extractFactoryBody(factory) {
  const out = { setterBindings: [], bodyAst: null };
  const ret = factory.body.body.find((s) => t.isReturnStatement(s));
  if (!ret || !t.isObjectExpression(ret.argument)) return out;

  for (const prop of ret.argument.properties) {
    if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
    const key = t.isIdentifier(prop.key) ? prop.key.name : (t.isStringLiteral(prop.key) ? prop.key.value : null);
    if (key === 'setters' && t.isObjectProperty(prop) && t.isArrayExpression(prop.value)) {
      out.setterBindings = parseSetters(prop.value);
    } else if (key === 'execute') {
      const fn = t.isObjectMethod(prop) ? prop : (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value) ? prop.value : null);
      if (fn) {
        const body = t.isObjectMethod(prop) ? prop.body.body : fn.body.body;
        out.bodyAst = t.file(t.program(body));
      }
    }
  }
  return out;
}

function parseSetters(arrayExpr) {
  return arrayExpr.elements.map((fn, i) => {
    if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) {
      return { dep: null, bindings: [], _index: i };
    }
    const param = fn.params[0];
    const paramName = t.isIdentifier(param) ? param.name : null;
    const bindings = [];
    if (paramName) {
      for (const stmt of fn.body.body) {
        if (
          t.isExpressionStatement(stmt) &&
          t.isAssignmentExpression(stmt.expression) &&
          t.isIdentifier(stmt.expression.left) &&
          t.isMemberExpression(stmt.expression.right) &&
          t.isIdentifier(stmt.expression.right.object, { name: paramName })
        ) {
          const local = stmt.expression.left.name;
          const importedNode = stmt.expression.right.property;
          const imported = t.isIdentifier(importedNode) ? importedNode.name : (t.isStringLiteral(importedNode) ? importedNode.value : local);
          bindings.push({ local, imported });
        }
      }
    }
    return { dep: null, bindings, _index: i };
  });
}

module.exports = { splitChunks };
