'use strict';

/**
 * Layer 5: typeInferer.
 *
 * Walk recovered scenes (context.scenes is an array of scene/prefab documents)
 * and per ccclass, infer field types from observed sample values.
 *
 * Supported value shapes:
 *  - number / string / boolean → scalar TS type
 *  - array → 'any[]' (MVP, no drill-in)
 *  - { __uuid__: string } → resolved via aggregated uuidMap → ccclass name
 *  - { __id__: number } → looked up in current scene → engine type (cc.* stripped)
 *  - else → 'any'
 *
 * Defensive: empty uuidMaps and modules without uuid are tolerated.
 */
async function inferFieldTypes(modules, context = {}) {
  const scenes = (context && context.scenes) || [];

  // Aggregate uuidMap across all modules for cross-module __uuid__ resolution.
  const globalUuidMap = {};
  for (const m of modules) {
    if (m && m.uuidMap) Object.assign(globalUuidMap, m.uuidMap);
  }

  // Aggregate per-class samples across all scenes, retaining the originating
  // scene so {__id__} references can be dereferenced later.
  const classSamples = new Map(); // className -> Map<field, { value, scene }>
  for (const sc of scenes) {
    if (!Array.isArray(sc)) continue;
    for (const node of sc) {
      if (!node || typeof node !== 'object') continue;
      const klass = node.__type__;
      if (typeof klass !== 'string') continue;
      let bucket = classSamples.get(klass);
      if (!bucket) {
        bucket = new Map();
        classSamples.set(klass, bucket);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === '__type__' || k === '__id__') continue;
        if (!bucket.has(k)) bucket.set(k, { value: v, scene: sc });
      }
    }
  }

  for (const mod of modules) {
    mod.fieldTypes = {};
    if (!mod || !mod.ccclassName) continue;
    const fields = classSamples.get(mod.ccclassName);
    if (!fields) continue;
    for (const [k, sample] of fields.entries()) {
      mod.fieldTypes[k] = inferType(sample.value, globalUuidMap, sample.scene);
    }
  }
  return modules;
}

function inferType(v, uuidMap, scene) {
  if (v === null || v === undefined) return 'any';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'any[]';
  if (typeof v === 'object') {
    // {__uuid__} → asset reference. Resolve to a ccclass name when known.
    if (typeof v.__uuid__ === 'string') {
      const hit = uuidMap[v.__uuid__];
      if (hit && hit.className) return hit.className;
      return 'any';
    }
    // {__id__} → in-scene reference. Dereference and read target __type__.
    if (typeof v.__id__ === 'number' && Array.isArray(scene)) {
      const target = scene[v.__id__];
      if (target && typeof target.__type__ === 'string') {
        const tt = target.__type__;
        if (tt.startsWith('cc.')) return tt.slice(3);
        const hit = uuidMap[tt];
        if (hit && hit.className) return hit.className;
        return tt;
      }
      return 'any';
    }
    // Inline {__type__: 'cc.X'} — strip the cc. prefix.
    if (typeof v.__type__ === 'string' && v.__type__.startsWith('cc.')) {
      return v.__type__.slice(3);
    }
  }
  return 'any';
}

module.exports = { inferFieldTypes, inferType };
