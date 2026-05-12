'use strict';

const t = require('@babel/types');
const traverseMod = require('@babel/traverse');
const traverse = traverseMod.default || traverseMod;

/**
 * Layer 4: extract ccclass name + UUID from cclegacy._RF.push/_RF.push calls
 * and from @ccclass decorator. Strip the _RF push/pop scaffolding.
 */
async function applyCcclassNames(modules, _context) {
  for (const mod of modules) {
    mod.ccclassName = null;
    mod.uuid = null;
    mod.uuidMap = {};
    if (!mod.ast) continue;

    const meta = extractRfPush(mod.ast);
    let ccclassName = meta.className;
    const uuid = meta.uuid;

    if (!ccclassName) ccclassName = extractCcclassDecoratorName(mod.ast);

    if (ccclassName) renameClassId(mod.ast, ccclassName);

    mod.ccclassName = ccclassName || null;
    mod.uuid = uuid || null;
    if (uuid && ccclassName) {
      mod.uuidMap = { [uuid]: { className: ccclassName, moduleName: mod.name } };
    }
  }
  return modules;
}

function extractRfPush(ast) {
  const out = { uuid: null, className: null };
  const toRemove = [];
  traverse(ast, {
    ExpressionStatement(p) {
      const expr = p.node.expression;
      if (!t.isCallExpression(expr)) return;
      const isPush = isRfMember(expr.callee, 'push');
      const isPop = isRfMember(expr.callee, 'pop');
      if (!isPush && !isPop) return;
      if (isPush && expr.arguments.length >= 3) {
        const uuidArg = expr.arguments[1];
        const nameArg = expr.arguments[2];
        if (t.isStringLiteral(uuidArg)) out.uuid = uuidArg.value;
        if (t.isStringLiteral(nameArg)) out.className = nameArg.value;
      }
      toRemove.push(p);
    },
  });
  for (const p of toRemove) p.remove();
  return out;
}

function isRfMember(node, which) {
  if (!t.isMemberExpression(node)) return false;
  if (!t.isIdentifier(node.property, { name: which })) return false;
  const obj = node.object;
  if (t.isIdentifier(obj, { name: '_RF' })) return true;
  if (
    t.isMemberExpression(obj) &&
    t.isIdentifier(obj.property, { name: '_RF' })
  ) return true;
  return false;
}

function extractCcclassDecoratorName(ast) {
  let name = null;
  traverse(ast, {
    ClassDeclaration(p) {
      if (name) return;
      const decorators = p.node.decorators || [];
      for (const dec of decorators) {
        const expr = dec.expression;
        if (!t.isCallExpression(expr)) continue;
        if (!t.isIdentifier(expr.callee, { name: 'ccclass' })) continue;
        const arg = expr.arguments[0];
        if (t.isStringLiteral(arg)) { name = arg.value; return; }
        if (t.isObjectExpression(arg)) {
          const nameProp = arg.properties.find(
            (pr) => t.isObjectProperty(pr) && t.isIdentifier(pr.key, { name: 'name' }) && t.isStringLiteral(pr.value)
          );
          if (nameProp) { name = nameProp.value.value; return; }
        }
      }
    },
  });
  return name;
}

function renameClassId(ast, newName) {
  traverse(ast, {
    ClassDeclaration(p) {
      if (!p.node.id || p.node.id.name === newName) return;
      const oldName = p.node.id.name;
      try {
        p.scope.rename(oldName, newName);
      } catch (_e) {
        // ignore — fallback below sets the id directly
      }
      if (p.node.id && p.node.id.name === oldName) p.node.id.name = newName;
      p.stop();
    },
  });
}

module.exports = { applyCcclassNames };
