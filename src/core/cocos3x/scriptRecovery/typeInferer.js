'use strict';

/**
 * Layer 5 stub: typeInferer.
 * Will infer field types by scanning recovered scenes/prefabs.
 * Currently a no-op pass-through.
 */
async function inferFieldTypes(modules, _context) {
  return modules;
}

module.exports = { inferFieldTypes };
