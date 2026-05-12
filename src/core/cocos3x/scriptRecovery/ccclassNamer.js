'use strict';

/**
 * Layer 4 stub: ccclassNamer.
 * Will extract ccclass names + UUIDs from `_RF.push` calls and decorators.
 * Currently a no-op pass-through.
 */
async function applyCcclassNames(modules, _context) {
  return modules;
}

module.exports = { applyCcclassNames };
