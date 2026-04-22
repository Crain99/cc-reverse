/*
 * Reverse of Cocos Creator's IFileData compilation.
 *
 * Converts the runtime tuple
 *
 *   [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks,
 *    instances, instanceTypes, refs, dependObjs, dependKeys, dependUuidIndices]
 *
 * back into the editor's source JSON form:
 *
 *   [ { "__type__": "cc.SceneAsset", "_name": "Main", "scene": {"__id__": 1} },
 *     { "__type__": "cc.Scene", "_children": [{"__id__": 2}], ... },
 *     ... ]
 *
 * This is the inverse of cocos/serialization/deserialize.ts `parseInstances`
 * + `dereference` + `parseResult`. It follows the same mask + class + typed
 * dispatch logic, but emits plain object literals with `{__id__}` / `{__uuid__}`
 * cross-references instead of invoking live constructors.
 *
 * Reference (cocos-engine v3.x, structurally identical to 2.4 bundle output):
 *   cocos/serialization/deserialize.ts `deserializeCCObject`, `ASSIGNMENTS`,
 *   `parseInstances`, `dereference`, `parseResult`.
 */

// ---------------------------------------------------------------------------
// Enum mirrors (must match deserialize.ts)
// ---------------------------------------------------------------------------

const DataTypeID = Object.freeze({
  SimpleType: 0,
  InstanceRef: 1,
  Array_InstanceRef: 2,
  Array_AssetRefByInnerObj: 3,
  Class: 4,
  ValueTypeCreated: 5,
  AssetRefByInnerObj: 6,
  TRS: 7,
  ValueType: 8,
  Array_Class: 9,
  CustomizedClass: 10,
  Dict: 11,
  Array: 12,
});

const File = Object.freeze({
  Version: 0,
  SharedUuids: 1,
  SharedStrings: 2,
  SharedClasses: 3,
  SharedMasks: 4,
  Instances: 5,
  InstanceTypes: 6,
  Refs: 7,
  DependObjs: 8,
  DependKeys: 9,
  DependUuidIndices: 10,
});

// Class-layout offsets: IClass = [name, keys[], propTypeOffset, ...dataTypeIDs]
const CLASS_TYPE = 0;
const CLASS_KEYS = 1;
const CLASS_PROP_TYPE_OFFSET = 2;

// ValueTypeData index → class name (from compiled/builtin-value-type.ts).
const VALUE_TYPE_CONSTRUCTORS = [
  'cc.Vec2',   // 0 → [x, y]
  'cc.Vec3',   // 1 → [x, y, z]
  'cc.Vec4',   // 2 → [x, y, z, w]
  'cc.Quat',   // 3 → [x, y, z, w]
  'cc.Color',  // 4 → [uint32 rgba]
  'cc.Size',   // 5 → [width, height]
  'cc.Rect',   // 6 → [x, y, width, height]
  'cc.Mat4',   // 7 → 16 numbers in m00..m33 order
];

// Refs: triples of (owner, key, target) with a trailing offset indicating the
// boundary where `owner` transitions from an object reference to an instance
// index.
const REFS_RECORD_LEN = 3;
const REFS_OWNER = 0;
const REFS_KEY = 1;
const REFS_TARGET = 2;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Rehydrate an IFileData tuple.
 *
 * @param {any[]} doc
 * @param {object} [options]
 * @param {boolean} [options.inlineRefs=false]  When true, InstanceRef and
 *     cross-references are resolved to nested objects rather than `{__id__}`
 *     markers. Defaults to false (matches the editor's source format).
 * @returns {any[]|null}  Array of source-format objects (root is index 0) or
 *     null if the document doesn't look like an IFileData tuple.
 */
function rehydrateIFileData(doc, options = {}) {
  if (!isIFileDataTuple(doc)) return null;

  const ctx = buildContext(doc);

  // 1) Build each instance. Class-typed instances are dispatched via masks;
  //    Other-typed instances come after and use instanceTypes[] to decide
  //    between CustomizedClass and PrimitiveObjectTypeID.
  parseInstances(ctx);

  // 2) Apply cross-references (refs) last, mutating already-built objects.
  applyRefs(ctx);

  // 3) Resolve asset-ref back-channel: the dependObjs/Keys/UuidIndices
  //    triples assign {__uuid__} markers to the right property on the right
  //    instance object.
  applyAssetRefs(ctx);

  if (options.inlineRefs) {
    inlineInstanceRefs(ctx);
  }

  return ctx.instances.slice();
}

function isIFileDataTuple(doc) {
  if (!Array.isArray(doc) || doc.length < 6) return false;
  if (typeof doc[File.Version] !== 'number') return false;
  return Array.isArray(doc[File.SharedClasses]);
}

// ---------------------------------------------------------------------------
// Context setup
// ---------------------------------------------------------------------------

function buildContext(doc) {
  return {
    version: doc[File.Version],
    sharedUuids: arrayOrEmpty(doc[File.SharedUuids]),
    sharedStrings: arrayOrEmpty(doc[File.SharedStrings]),
    sharedClasses: arrayOrEmpty(doc[File.SharedClasses]),
    sharedMasks: arrayOrEmpty(doc[File.SharedMasks]),
    rawInstances: arrayOrEmpty(doc[File.Instances]),
    instanceTypes: arrayOrEmpty(doc[File.InstanceTypes]),
    refs: doc[File.Refs] || null,
    dependObjs: arrayOrEmpty(doc[File.DependObjs]).slice(),
    dependKeys: arrayOrEmpty(doc[File.DependKeys]).slice(),
    dependUuidIndices: arrayOrEmpty(doc[File.DependUuidIndices]).slice(),
    // Populated by parseInstances:
    instances: [],
    // Deferred back-ref registration: maps refSlotIndex → owner object that
    // should receive a cross-ref once dereference runs.
    pendingOwners: [],
  };
}

function arrayOrEmpty(v) {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Instance construction
// ---------------------------------------------------------------------------

function parseInstances(ctx) {
  const raw = ctx.rawInstances;
  const instanceTypes = ctx.instanceTypes;
  const instanceTypesLen = instanceTypes.length;

  // The last entry may be a RootInfo integer (combines noNativeDep bit +
  // rootIndex). Strip it if present.
  let normalObjectCount = raw.length - instanceTypesLen;
  const tail = raw[raw.length - 1];
  if (typeof tail === 'number') {
    normalObjectCount -= 1;
  }

  // Pre-allocate so InstanceRef values can point ahead.
  ctx.instances = new Array(raw.length);

  // Class-typed instances first.
  for (let i = 0; i < normalObjectCount; i += 1) {
    const entry = raw[i];
    if (Array.isArray(entry)) {
      ctx.instances[i] = deserializeCCObject(ctx, entry);
    } else {
      ctx.instances[i] = entry;
    }
  }

  // Other-typed (CustomizedClass or PrimitiveObjectTypeID).
  let insIdx = normalObjectCount;
  for (let typeIdx = 0; typeIdx < instanceTypesLen; typeIdx += 1, insIdx += 1) {
    const type = instanceTypes[typeIdx];
    const entry = raw[insIdx];
    if (typeof type === 'number' && type >= 0) {
      // CustomizedClass — entry is [classIdx, content]
      const className = classNameAt(ctx, type);
      ctx.instances[insIdx] = {
        __type__: className || 'unknown',
        content: entry,
      };
    } else if (typeof type === 'number') {
      const primitive = ~type;
      const wrapper = { __cc_reverse_wrapper__: true };
      assignByType(ctx, wrapper, 'value', primitive, entry);
      ctx.instances[insIdx] = wrapper.value;
    } else {
      ctx.instances[insIdx] = entry;
    }
  }

  // Trailing RootInfo slot stays as-is (or null if absent).
  if (normalObjectCount + instanceTypesLen < raw.length) {
    ctx.instances[raw.length - 1] = raw[raw.length - 1];
  }
}

/**
 * Convert a single [maskIdx, ...values] entry into a plain `{__type__, ...}`
 * object by combining its mask + class layout.
 */
function deserializeCCObject(ctx, objectData) {
  const maskIdx = objectData[0];
  const mask = ctx.sharedMasks[maskIdx];
  if (!Array.isArray(mask)) return { __cc_reverse__: 'bad-mask', objectData };

  const classIdx = mask[0];
  const klass = ctx.sharedClasses[classIdx];
  const className = extractClassName(klass);
  const keys = extractClassKeys(klass);
  const classTypeOffset = extractPropTypeOffset(klass);
  const maskTypeOffset = mask[mask.length - 1];

  const obj = {};
  if (className) obj.__type__ = className;

  // Simple-typed properties.
  let i = 1;
  for (; i < maskTypeOffset; i += 1) {
    const key = keys[mask[i]];
    if (key != null) obj[key] = objectData[i];
  }

  // Advanced-typed properties.
  for (; i < objectData.length; i += 1) {
    const keyIndex = mask[i];
    const key = keys[keyIndex];
    if (key == null) continue;
    const dataType = klass[keyIndex + classTypeOffset];
    assignByType(ctx, obj, key, dataType, objectData[i]);
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Advanced-type dispatch
// ---------------------------------------------------------------------------

function assignByType(ctx, owner, key, dataType, value) {
  switch (dataType) {
    case DataTypeID.SimpleType:
      owner[key] = value;
      return;
    case DataTypeID.InstanceRef:
      assignInstanceRef(ctx, owner, key, value);
      return;
    case DataTypeID.Array_InstanceRef:
      if (Array.isArray(value)) {
        // Important: use a single shared array so back-ref registration
        // targets the same owner the output references.
        const arr = new Array(value.length);
        for (let i = 0; i < value.length; i += 1) {
          assignInstanceRef(ctx, arr, i, value[i]);
        }
        owner[key] = arr;
      } else {
        owner[key] = value;
      }
      return;
    case DataTypeID.Array_AssetRefByInnerObj:
      // Each element is a depend-obj index — handled when asset refs are
      // applied. Placeholder `null` slots are standard for these.
      if (Array.isArray(value)) {
        const arr = new Array(value.length).fill(null);
        for (let i = 0; i < value.length; i += 1) {
          registerAssetRef(ctx, arr, i, value[i]);
        }
        owner[key] = arr;
      } else {
        owner[key] = value;
      }
      return;
    case DataTypeID.Class:
      // Nested IClassObjectData inline.
      owner[key] = Array.isArray(value) ? deserializeCCObject(ctx, value) : value;
      return;
    case DataTypeID.ValueTypeCreated:
    case DataTypeID.ValueType:
      owner[key] = decodeValueType(value);
      return;
    case DataTypeID.AssetRefByInnerObj:
      // Defer: owner[key] = null until applyAssetRefs fills it in.
      owner[key] = null;
      registerAssetRef(ctx, owner, key, value);
      return;
    case DataTypeID.TRS:
      // Node TRS: 10-number packed Float64 (pos[3], rot[4], scale[3]). Keep
      // as plain array — editor re-normalises.
      owner[key] = Array.isArray(value) ? value.slice() : value;
      return;
    case DataTypeID.Array_Class:
      owner[key] = Array.isArray(value)
        ? value.map(v => (Array.isArray(v) ? deserializeCCObject(ctx, v) : v))
        : value;
      return;
    case DataTypeID.CustomizedClass: {
      // value = [classIdx, content]
      if (Array.isArray(value) && value.length >= 2) {
        const className = classNameAt(ctx, value[0]);
        owner[key] = {
          __type__: className || 'unknown',
          content: value[1],
        };
      } else {
        owner[key] = value;
      }
      return;
    }
    case DataTypeID.Dict:
      owner[key] = decodeDict(ctx, value);
      return;
    case DataTypeID.Array:
      owner[key] = decodeArray(ctx, value);
      return;
    default:
      owner[key] = value;
  }
}

function assignInstanceRef(ctx, owner, key, value) {
  if (typeof value !== 'number') {
    owner[key] = value;
    return;
  }
  if (value >= 0) {
    // Editor source format uses {__id__: n}.
    owner[key] = { __id__: value };
  } else {
    // Back-reference: defer via refs[~value * 3] = owner
    const slot = (~value) * REFS_RECORD_LEN;
    owner[key] = null;
    ctx.pendingOwners[slot] = { owner, key };
  }
}

function registerAssetRef(ctx, owner, key, dependIdx) {
  if (typeof dependIdx !== 'number') return;
  // Mark that depend-obj at `dependIdx` targets this owner[key]. The original
  // runtime just assigns the live object into dependObjs[], but we need to
  // remember the exact (owner, key) tuple for later uuid application.
  if (!ctx.dependAssignments) ctx.dependAssignments = [];
  ctx.dependAssignments[dependIdx] = { owner, key };
}

// ---------------------------------------------------------------------------
// ValueType / Dict / Array helpers
// ---------------------------------------------------------------------------

function decodeValueType(data) {
  if (!Array.isArray(data) || data.length === 0) return data;
  const typeId = data[0];
  const className = VALUE_TYPE_CONSTRUCTORS[typeId];
  if (!className) return data;

  const out = { __type__: className };
  switch (typeId) {
    case 0: // Vec2
      out.x = data[1]; out.y = data[2];
      break;
    case 1: // Vec3
      out.x = data[1]; out.y = data[2]; out.z = data[3];
      break;
    case 2: // Vec4
    case 3: // Quat
      out.x = data[1]; out.y = data[2]; out.z = data[3]; out.w = data[4];
      break;
    case 4: { // Color (uint32 → r,g,b,a)
      const rgba = data[1] >>> 0;
      out.r = (rgba >>> 24) & 0xff;
      out.g = (rgba >>> 16) & 0xff;
      out.b = (rgba >>> 8) & 0xff;
      out.a = rgba & 0xff;
      break;
    }
    case 5: // Size
      out.width = data[1]; out.height = data[2];
      break;
    case 6: // Rect
      out.x = data[1]; out.y = data[2];
      out.width = data[3]; out.height = data[4];
      break;
    case 7: { // Mat4
      for (let i = 0; i < 16; i += 1) {
        out[`m${String(i).padStart(2, '0')}`] = data[1 + i];
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * IDictData layout: [plainJsonObject, key, dataType, value, key, dataType, value, ...].
 * The first element is the dict with simple-typed entries baked in; we merge
 * advanced entries back on top.
 */
function decodeDict(ctx, data) {
  if (!Array.isArray(data)) return data;
  const dict = data[0] && typeof data[0] === 'object' ? { ...data[0] } : {};
  for (let i = 1; i + 2 < data.length; i += 3) {
    const subKey = data[i];
    const subType = data[i + 1];
    const subValue = data[i + 2];
    assignByType(ctx, dict, String(subKey), subType, subValue);
  }
  return dict;
}

/**
 * IArrayData: [items[], ...dataTypesPerItem]. Items are walked and each is
 * reassigned through the type dispatcher.
 */
function decodeArray(ctx, data) {
  if (!Array.isArray(data) || data.length === 0) return data;
  const items = Array.isArray(data[0]) ? data[0].slice() : [];
  for (let i = 0; i < items.length; i += 1) {
    const dataType = data[i + 1];
    if (dataType === DataTypeID.SimpleType || dataType == null) continue;
    assignByType(ctx, items, i, dataType, items[i]);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Cross-references (refs table)
// ---------------------------------------------------------------------------

function applyRefs(ctx) {
  const refs = ctx.refs;
  if (!Array.isArray(refs) || refs.length < 2) return;

  const totalLen = refs.length - 1;
  const ownerBoundary = refs[totalLen] * REFS_RECORD_LEN;
  const strings = ctx.sharedStrings;
  const instances = ctx.instances;

  let i = 0;
  // First region: owner is an object reference stashed by assignInstanceRef.
  for (; i < ownerBoundary; i += REFS_RECORD_LEN) {
    const slot = ctx.pendingOwners[i];
    if (!slot) continue;
    const keyIndex = refs[i + REFS_KEY];
    const targetIdx = refs[i + REFS_TARGET];
    const target = { __id__: targetIdx };
    applyKeyedAssignment(slot.owner, slot.key, keyIndex, target, strings);
  }

  // Second region: owner is an instance index.
  for (; i < totalLen; i += REFS_RECORD_LEN) {
    const ownerIdx = refs[i + REFS_OWNER];
    const keyIndex = refs[i + REFS_KEY];
    const targetIdx = refs[i + REFS_TARGET];
    const owner = instances[ownerIdx];
    if (!owner) continue;
    const target = { __id__: targetIdx };
    applyKeyedAssignment(owner, null, keyIndex, target, strings);
  }
}

function applyKeyedAssignment(owner, primaryKey, keyIndex, target, strings) {
  // keyIndex can be:
  //   >= 0 → index into sharedStrings (property name)
  //   <  0 → ~keyIndex is the array index into the owner array
  if (typeof keyIndex !== 'number') {
    if (primaryKey != null && owner) owner[primaryKey] = target;
    return;
  }
  if (keyIndex >= 0) {
    const name = strings[keyIndex];
    if (name != null) owner[name] = target;
  } else {
    const arrIdx = ~keyIndex;
    owner[arrIdx] = target;
  }
}

// ---------------------------------------------------------------------------
// Asset-ref resolution
// ---------------------------------------------------------------------------

function applyAssetRefs(ctx) {
  const { dependObjs, dependKeys, dependUuidIndices, sharedStrings, sharedUuids, instances } = ctx;
  const assignments = ctx.dependAssignments || [];

  for (let i = 0; i < dependObjs.length; i += 1) {
    let target = null;
    let keyName = null;

    const rawObj = dependObjs[i];
    const rawKey = dependKeys[i];
    const rawUuidIdx = dependUuidIndices[i];

    const uuid = typeof rawUuidIdx === 'number' ? sharedUuids[rawUuidIdx] : rawUuidIdx;
    if (!uuid) continue;

    // Preferred path: AssetRefByInnerObj registered a direct (owner, key).
    const assignment = assignments[i];
    if (assignment) {
      target = assignment.owner;
      keyName = assignment.key;
    } else if (typeof rawObj === 'number') {
      // Runtime stores the OWNING INSTANCE INDEX here; key identifies the
      // property.
      target = instances[rawObj];
      if (typeof rawKey === 'string') keyName = rawKey;
      else if (typeof rawKey === 'number') {
        if (rawKey >= 0) keyName = sharedStrings[rawKey];
        else keyName = ~rawKey; // array index
      }
    } else if (rawObj && typeof rawObj === 'object') {
      target = rawObj;
      keyName = rawKey;
    }

    if (target && keyName != null) {
      if (Array.isArray(target) && typeof keyName === 'number') {
        target[keyName] = { __uuid__: uuid };
      } else {
        target[keyName] = { __uuid__: uuid };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Optional: inline {__id__} refs to their actual objects (not used for source
// format; used for diagnostics / tests).
// ---------------------------------------------------------------------------

function inlineInstanceRefs(ctx) {
  const { instances } = ctx;
  const walk = (node, seen) => {
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        if (node[i] && typeof node[i] === 'object' && '__id__' in node[i]
            && Object.keys(node[i]).length === 1) {
          node[i] = instances[node[i].__id__];
        } else {
          walk(node[i], seen);
        }
      }
      return node;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object' && '__id__' in v && Object.keys(v).length === 1) {
        node[k] = instances[v.__id__];
      } else {
        walk(v, seen);
      }
    }
    return node;
  };
  instances.forEach(o => walk(o, new WeakSet()));
}

// ---------------------------------------------------------------------------
// Class layout extractors
// ---------------------------------------------------------------------------

function classNameAt(ctx, idx) {
  return extractClassName(ctx.sharedClasses[idx]);
}

function extractClassName(def) {
  if (typeof def === 'string') return def;
  if (Array.isArray(def)) {
    const head = def[CLASS_TYPE];
    if (typeof head === 'string') return head;
    // Already-resolved constructor (shouldn't happen on raw JSON).
    return null;
  }
  if (def && typeof def === 'object' && def.name) return String(def.name);
  return null;
}

function extractClassKeys(def) {
  if (Array.isArray(def) && Array.isArray(def[CLASS_KEYS])) return def[CLASS_KEYS];
  return [];
}

function extractPropTypeOffset(def) {
  if (Array.isArray(def) && typeof def[CLASS_PROP_TYPE_OFFSET] === 'number') {
    return def[CLASS_PROP_TYPE_OFFSET];
  }
  return 0;
}

module.exports = {
  rehydrateIFileData,
  DataTypeID,
  File,
  VALUE_TYPE_CONSTRUCTORS,
};
