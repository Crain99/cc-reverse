/*
 * Minimal 3.x IFileData introspection.
 *
 * Full rehydration is a 2000-line port of `cocos/serialization/deserialize-dynamic.ts`.
 * For reverse engineering we only need to answer:
 *   - What is the root class of this asset? (drives which output directory)
 *   - What uuids does it depend on? (so we can follow cross-asset references)
 *   - What is its human-readable name, if any?
 *
 * The data format is the tuple defined at:
 *   cocos/serialization/deserialize.ts  —  enum File { ... }, interface IFileData
 *
 * For the legacy plain-object form (still emitted by 3.0–3.3 for simple assets)
 * we fall back to the 2.x-style `{ __type__, _name, ... }` traversal.
 */

const FILE_FIELD = Object.freeze({
  VERSION: 0,
  SHARED_UUIDS: 1,
  SHARED_STRINGS: 2,
  SHARED_CLASSES: 3,
  SHARED_MASKS: 4,
  INSTANCES: 5,
  INSTANCE_TYPES: 6,
  REFS: 7,
  DEPEND_OBJS: 8,
  DEPEND_KEYS: 9,
  DEPEND_UUID_INDICES: 10,
});

/**
 * Does a value look like the tuple-shaped 3.x IFileData?
 * @param {any} doc
 * @returns {boolean}
 */
function isPackedFileData(doc) {
  if (!Array.isArray(doc)) return false;
  // Must have at least version + shared classes to be meaningful.
  if (doc.length < 6) return false;
  const classes = doc[FILE_FIELD.SHARED_CLASSES];
  return Array.isArray(classes);
}

/**
 * Is this the `IPackedFileData` variant (multi-document)?
 * Shape: { shared..., sections: [IFileData, ...] }
 */
function isMultiPackedFileData(doc) {
  return doc && typeof doc === 'object' && Array.isArray(doc.sections);
}

/**
 * Extract class names from SharedClasses.
 *
 * Each entry is either:
 *   - string: bare class name.
 *   - [ctor, keys[], propTypeOffset, ...dataTypeIDs]
 *   - something else (user-defined type): left as-is.
 *
 * @param {any[]} classes
 * @returns {Array<{ name: string, keys: string[] }>}
 */
function extractClasses(classes) {
  const out = [];
  if (!Array.isArray(classes)) return out;
  for (const entry of classes) {
    if (typeof entry === 'string') {
      out.push({ name: entry, keys: [] });
    } else if (Array.isArray(entry)) {
      const name = typeof entry[0] === 'string' ? entry[0] : null;
      const keys = Array.isArray(entry[1]) ? entry[1].slice() : [];
      out.push({ name, keys });
    } else if (entry && typeof entry === 'object' && entry.name) {
      out.push({ name: String(entry.name), keys: [] });
    } else {
      out.push({ name: null, keys: [] });
    }
  }
  return out;
}

/**
 * Determine the root class for an IFileData. By convention the first entry in
 * `SharedClasses` is the root asset's class.
 *
 * @param {any[]} doc
 * @returns {string|null}
 */
function rootClassName(doc) {
  const classes = extractClasses(doc[FILE_FIELD.SHARED_CLASSES]);
  return classes.length > 0 ? classes[0].name : null;
}

/**
 * Resolve the depend-uuid list. Each index in `DependUuidIndices` points into
 * `SharedUuids`.
 *
 * @param {any[]} doc
 * @returns {string[]}
 */
function dependentUuids(doc) {
  const shared = doc[FILE_FIELD.SHARED_UUIDS];
  const indices = doc[FILE_FIELD.DEPEND_UUID_INDICES];
  if (!Array.isArray(shared) || !Array.isArray(indices)) return [];
  const out = [];
  for (const idx of indices) {
    const u = shared[idx];
    if (u) out.push(u);
  }
  return out;
}

/**
 * Try to find a `_name` value for the root asset by scanning the first
 * instance's simple-values and cross-referencing SharedStrings. This is a
 * best-effort heuristic — the name may be an indirect reference.
 *
 * @param {any[]} doc
 * @returns {string|null}
 */
function extractAssetName(doc) {
  const classes = extractClasses(doc[FILE_FIELD.SHARED_CLASSES]);
  if (classes.length === 0) return null;
  const rootClass = classes[0];
  const nameIdx = rootClass.keys.indexOf('_name');
  if (nameIdx < 0) return null;

  const instances = doc[FILE_FIELD.INSTANCES];
  if (!Array.isArray(instances) || instances.length === 0) return null;

  const strings = doc[FILE_FIELD.SHARED_STRINGS];
  const firstInstance = instances[0];
  if (!Array.isArray(firstInstance)) return null;

  // In IClassObjectData the first value is the mask index, so properties start
  // at offset 1. But the mask may reorder properties, so this is a heuristic.
  // Try each candidate position for a string value.
  const masks = doc[FILE_FIELD.SHARED_MASKS];
  const maskIndex = firstInstance[0];
  if (Array.isArray(masks) && typeof maskIndex === 'number' && masks[maskIndex]) {
    const mask = masks[maskIndex];
    // mask[0] = classIndex, mask[-1] = offsetBetweenSimpleAndAdvanced,
    // mask[1..len-2] = property indices (of rootClass.keys).
    for (let i = 1; i < mask.length - 1; i += 1) {
      if (mask[i] === nameIdx) {
        const val = firstInstance[i];
        if (typeof val === 'string') return val;
        if (typeof val === 'number' && Array.isArray(strings) && strings[val] != null) {
          return String(strings[val]);
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Inspect any 3.x asset document and return a summary suitable for the
 * reverse pipeline. Handles both plain-object and tuple forms.
 *
 * @param {any} doc
 * @returns {{ form: 'plain'|'packed'|'multi-packed'|'unknown',
 *            rootClass: string|null,
 *            name: string|null,
 *            depends: string[] }}
 */
function inspect(doc) {
  if (doc == null) {
    return { form: 'unknown', rootClass: null, name: null, depends: [] };
  }

  if (isPackedFileData(doc)) {
    return {
      form: 'packed',
      rootClass: rootClassName(doc),
      name: extractAssetName(doc),
      depends: dependentUuids(doc),
    };
  }

  if (isMultiPackedFileData(doc)) {
    // Recurse into first section for root-class, union all depends.
    const allDepends = new Set();
    let rootClass = null;
    let name = null;
    for (const section of doc.sections) {
      const info = inspect(section);
      if (!rootClass) rootClass = info.rootClass;
      if (!name) name = info.name;
      info.depends.forEach(d => allDepends.add(d));
    }
    return { form: 'multi-packed', rootClass, name, depends: Array.from(allDepends) };
  }

  // Plain object (legacy 3.0–3.3 form, shares shape with 2.x).
  if (typeof doc === 'object') {
    const rootClass = doc.__type__ || (Array.isArray(doc) && doc[0] && doc[0].__type__) || null;
    const name = doc._name || (Array.isArray(doc) && doc[0] && doc[0]._name) || null;
    const depends = [];
    collectUuids(doc, depends);
    return { form: 'plain', rootClass, name, depends };
  }

  return { form: 'unknown', rootClass: null, name: null, depends: [] };
}

function collectUuids(node, out, seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) collectUuids(item, out, seen);
    return;
  }

  if (typeof node.__uuid__ === 'string') {
    out.push(node.__uuid__);
  }

  for (const key of Object.keys(node)) {
    if (key === '__uuid__') continue;
    collectUuids(node[key], out, seen);
  }
}

module.exports = {
  FILE_FIELD,
  isPackedFileData,
  isMultiPackedFileData,
  rootClassName,
  dependentUuids,
  extractAssetName,
  inspect,
};
