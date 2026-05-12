'use strict';

/**
 * Walk a recovered scene/prefab document (an array of "tagged" objects with
 * __type__) and emit { className -> { fieldName -> sample value } }.
 *
 * Used as a diagnostic helper and as a building block for typeInferer.
 */
function indexSceneFields(doc) {
  const out = new Map();
  if (!Array.isArray(doc)) return out;
  for (const node of doc) {
    if (!node || typeof node !== 'object') continue;
    const type = node.__type__;
    if (typeof type !== 'string') continue;
    let bucket = out.get(type);
    if (!bucket) {
      bucket = new Map();
      out.set(type, bucket);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === '__type__' || k === '__id__') continue;
      if (!bucket.has(k)) bucket.set(k, v);
    }
  }
  return out;
}

module.exports = { indexSceneFields };
