/*
 * Full-file Babel AST fallback for script bundles we cannot slice.
 * More precise than the legacy "any ArrayExpression string" heuristic:
 * only ObjectExpression entries shaped like browserify factories are taken.
 */

const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const generator = require('@babel/generator');
const { logger } = require('../../../utils/logger');

/**
 * @typedef {import('../types').ModuleRecord} ModuleRecord
 */

/**
 * @param {string} code
 * @returns {ModuleRecord[]}
 */
function extractWithAst(code) {
  if (!code || typeof code !== 'string') return [];

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch (err) {
    logger.error('AST fallback: failed to parse script bundle:', err.message || err);
    return [];
  }

  /** @type {ModuleRecord[]} */
  const records = [];
  const seen = new Set();

  const visitObject = (objNode) => {
    if (!objNode || objNode.type !== 'ObjectExpression') return;

    for (const prop of objNode.properties) {
      if (!prop || prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;

      const key = propKeyToString(prop.key, prop.computed);
      if (key == null) continue;

      const val = prop.value;
      if (!val || val.type !== 'ArrayExpression' || !val.elements || val.elements.length === 0) {
        continue;
      }

      const factory = val.elements[0];
      if (!factory || (factory.type !== 'FunctionExpression' && factory.type !== 'ArrowFunctionExpression')) {
        continue;
      }

      // Prefer classic CJS factory (require, module, exports)
      if (!factory.body || factory.body.type !== 'BlockStatement') continue;

      let deps = {};
      if (val.elements[1] && val.elements[1].type === 'ObjectExpression') {
        deps = objectExpressionToDeps(val.elements[1]);
      }

      // Generate body source (without outer braces)
      const bodyCode = generator.default(factory.body, { compact: false, comments: true }).code;
      let source = bodyCode;
      if (source.startsWith('{') && source.endsWith('}')) {
        source = source.slice(1, -1);
      }

      // Deduplicate by id — first wins
      if (seen.has(key)) continue;
      seen.add(key);

      const paramNames = (factory.params || []).map((p) => {
        if (!p) return null;
        if (p.type === 'Identifier') return p.name;
        return null;
      });

      records.push({
        id: key,
        source,
        deps,
        requireName: paramNames[0] || 'require',
        moduleName: paramNames[1] || 'module',
        exportsName: paramNames[2] || 'exports',
        uuid: null,
        format: 'unknown',
        outPath: null,
        rawKey: key,
        offset: factory.start || 0,
      });
    }
  };

  // Prefer CallExpression args that look like the modules map.
  traverse.default(ast, {
    CallExpression(path) {
      for (const arg of path.node.arguments || []) {
        if (arg && arg.type === 'ObjectExpression' && isModulesObject(arg)) {
          visitObject(arg);
        }
      }
    },
    // Also accept top-level assignment of a modules object
    AssignmentExpression(path) {
      const right = path.node.right;
      if (right && right.type === 'ObjectExpression' && isModulesObject(right)) {
        visitObject(right);
      }
    },
  });

  // Last resort: any object with enough factory-shaped props
  if (records.length === 0) {
    traverse.default(ast, {
      ObjectExpression(path) {
        if (isModulesObject(path.node)) {
          visitObject(path.node);
          // don't walk deeper into factories
          path.skip();
        }
      },
    });
  }

  if (global.verbose) {
    logger.debug(`AST fallback: recovered ${records.length} modules`);
  }

  return records;
}

function isModulesObject(objNode) {
  if (!objNode || objNode.type !== 'ObjectExpression') return false;
  let factoryCount = 0;
  for (const prop of objNode.properties || []) {
    if (!prop || (prop.type !== 'ObjectProperty' && prop.type !== 'Property')) continue;
    const val = prop.value;
    if (!val || val.type !== 'ArrayExpression' || !val.elements || !val.elements[0]) continue;
    const fn = val.elements[0];
    if (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression') {
      factoryCount += 1;
      if (factoryCount >= 1) return true;
    }
  }
  return false;
}

function propKeyToString(key, computed) {
  if (!key) return null;
  if (key.type === 'Identifier' && !computed) return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  if (key.type === 'Literal') return String(key.value);
  return null;
}

function objectExpressionToDeps(objNode) {
  const deps = {};
  for (const prop of objNode.properties || []) {
    if (!prop || (prop.type !== 'ObjectProperty' && prop.type !== 'Property')) continue;
    const k = propKeyToString(prop.key, prop.computed);
    if (k == null) continue;
    const v = prop.value;
    if (!v) continue;
    if (v.type === 'StringLiteral' || v.type === 'NumericLiteral' || v.type === 'Literal') {
      deps[k] = String(v.value);
    } else if (v.type === 'Identifier') {
      deps[k] = v.name;
    }
  }
  return deps;
}

module.exports = { extractWithAst };
