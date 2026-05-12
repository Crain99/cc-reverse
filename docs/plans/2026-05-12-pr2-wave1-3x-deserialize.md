# PR 2 — Wave 1 3.x Deserialization Completion

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the four remaining gaps in 3.x asset deserialization — CCON v2 (notepack) decoder, full IPackedFileData rehydrate, TypedArray DataTypeID coverage in `rehydrate.js`, and cross-bundle redirect resolution. Add validate gates that prove the new paths work on the zqndtz golden sample.

**Architecture:** Four independent units bolted onto the existing infrastructure laid down in PR 1.
- **R5 CCON v2** lives in `src/core/cocos3x/notepack.js` (a small notepack/msgpack decoder) and slots into `decodeCcon()` so v2 returns a real `document` instead of `rawJson`. We hand-roll the subset of msgpack actually emitted by Cocos rather than pull a 50 KB dep.
- **R6 IPackedFileData** moves from "skip and write raw" (`tryRehydrate` returns `null` for `{sections:[]}`) to "rehydrate each section by splicing it onto the shared header" — code path already prototyped in `extractPackSection`, just needs to be invoked from `tryRehydrate`.
- **R7 TypedArray** adds the missing `DataTypeID.TypedArray` (=13 in current cocos-engine) plus its companion array form to `rehydrate.assignByType`. Edge cases: zero-length arrays, mixed numeric types.
- **R8 Cross-bundle redirect** resolves `cfg.redirect[uuid] -> depBundleName` at unpack time so a missing import file in bundle A is fetched from bundle B (the engine does this transparently at runtime).

Each unit is gated by a unit test (synthetic fixture), then verified by a validate gate that runs against zqndtz's actual output.

**Tech Stack:** Node 14+, vitest 1.x (ESM imports), `Buffer`, `fs/promises`. No new runtime deps.

---

## Pre-flight

You are working in `/Users/lcf/code/cc-reverse/.worktrees/pr2-wave1-3x-deserialize` on branch `feature/pr2-wave1-3x-deserialize` (already created from `main` after PR 1 merge).

**Test files use ESM `import` syntax** — vitest 1.x rejects `require('vitest')`. Source files remain CJS (`module.exports`).

`npm test` baseline before any changes: 16 passed.

---

## Task 1: R5 — CCON v2 (notepack) decoder

**Files:**
- Create: `src/core/cocos3x/notepack.js`
- Modify: `src/core/cocos3x/ccon.js` (call notepack decoder when version === 2)
- Create: `test/unit/notepack.test.js`
- Create: `test/unit/ccon.v2.test.js`

### Subtask 1.1: notepack subset decoder

Cocos's `serialize-ccon.ts` uses `@cocos/notepack-lite`, which is msgpack with one extension: it flips the byte order for `bin8/16/32` lengths to be big-endian (matches the spec) but uses little-endian for everything else cocos cares about (it doesn't — msgpack is strictly big-endian). For our purposes we implement strict msgpack big-endian per https://github.com/msgpack/msgpack/blob/master/spec.md and validate against fixtures.

**Step 1: Write failing tests**

`test/unit/notepack.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { decodeNotepack } from '../../src/core/cocos3x/notepack.js';

describe('decodeNotepack — primitives', () => {
  it('positive fixint', () => {
    expect(decodeNotepack(Buffer.from([0x00]))).toBe(0);
    expect(decodeNotepack(Buffer.from([0x7f]))).toBe(127);
  });
  it('negative fixint', () => {
    expect(decodeNotepack(Buffer.from([0xff]))).toBe(-1);
    expect(decodeNotepack(Buffer.from([0xe0]))).toBe(-32);
  });
  it('uint8/16/32', () => {
    expect(decodeNotepack(Buffer.from([0xcc, 0xff]))).toBe(255);
    expect(decodeNotepack(Buffer.from([0xcd, 0x01, 0x00]))).toBe(256);
    expect(decodeNotepack(Buffer.from([0xce, 0x00, 0x01, 0x00, 0x00]))).toBe(65536);
  });
  it('int8/16/32', () => {
    expect(decodeNotepack(Buffer.from([0xd0, 0x80]))).toBe(-128);
    expect(decodeNotepack(Buffer.from([0xd1, 0x80, 0x00]))).toBe(-32768);
  });
  it('float32 / float64', () => {
    const f32 = Buffer.alloc(5); f32[0] = 0xca; f32.writeFloatBE(1.5, 1);
    expect(decodeNotepack(f32)).toBeCloseTo(1.5);
    const f64 = Buffer.alloc(9); f64[0] = 0xcb; f64.writeDoubleBE(Math.PI, 1);
    expect(decodeNotepack(f64)).toBeCloseTo(Math.PI);
  });
  it('nil / true / false', () => {
    expect(decodeNotepack(Buffer.from([0xc0]))).toBeNull();
    expect(decodeNotepack(Buffer.from([0xc2]))).toBe(false);
    expect(decodeNotepack(Buffer.from([0xc3]))).toBe(true);
  });
  it('fixstr', () => {
    const buf = Buffer.concat([Buffer.from([0xa3]), Buffer.from('foo')]);
    expect(decodeNotepack(buf)).toBe('foo');
  });
  it('str8/16/32', () => {
    const s = 'x'.repeat(40);
    const buf = Buffer.concat([Buffer.from([0xd9, s.length]), Buffer.from(s)]);
    expect(decodeNotepack(buf)).toBe(s);
  });
});

describe('decodeNotepack — collections', () => {
  it('fixarray', () => {
    expect(decodeNotepack(Buffer.from([0x93, 0x01, 0x02, 0x03]))).toEqual([1, 2, 3]);
  });
  it('array16', () => {
    const arr = new Array(20).fill(0).map((_, i) => i);
    const head = Buffer.from([0xdc, 0x00, 20]);
    const body = Buffer.concat(arr.map(n => Buffer.from([n])));
    expect(decodeNotepack(Buffer.concat([head, body]))).toEqual(arr);
  });
  it('fixmap', () => {
    // {"a": 1, "b": 2}
    const buf = Buffer.from([
      0x82,
      0xa1, 0x61, 0x01,
      0xa1, 0x62, 0x02,
    ]);
    expect(decodeNotepack(buf)).toEqual({ a: 1, b: 2 });
  });
  it('nested', () => {
    // [{"k": [1, "x"]}]
    const buf = Buffer.from([
      0x91,
      0x81,
      0xa1, 0x6b,
      0x92, 0x01, 0xa1, 0x78,
    ]);
    expect(decodeNotepack(buf)).toEqual([{ k: [1, 'x'] }]);
  });
});

describe('decodeNotepack — bin', () => {
  it('bin8 returns Buffer', () => {
    const data = Buffer.from([1, 2, 3, 4, 5]);
    const buf = Buffer.concat([Buffer.from([0xc4, 5]), data]);
    const out = decodeNotepack(buf);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(data)).toBe(true);
  });
});

describe('decodeNotepack — errors', () => {
  it('throws on unknown opcode', () => {
    expect(() => decodeNotepack(Buffer.from([0xc1]))).toThrow();
  });
  it('throws on truncated input', () => {
    expect(() => decodeNotepack(Buffer.from([0xa3, 0x66]))).toThrow();
  });
});
```

**Step 2: Run, expect failure (module missing).**

`npm test -- notepack` → import error.

**Step 3: Implement.**

`src/core/cocos3x/notepack.js`:
```js
/*
 * Minimal msgpack decoder used to read CCON v2 bodies.
 *
 * Implements the subset Cocos Creator's serialize-ccon.ts emits via
 * @cocos/notepack-lite. Reading is strictly big-endian per the msgpack spec.
 * https://github.com/msgpack/msgpack/blob/master/spec.md
 *
 * Not handled (errors loudly): ext types, timestamp, str32 over 2GB.
 */

function decodeNotepack(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('decodeNotepack: expected Buffer');
  const r = { buf, off: 0 };
  const out = readValue(r);
  return out;
}

function readValue(r) {
  if (r.off >= r.buf.length) throw new Error('notepack: unexpected EOF');
  const b = r.buf[r.off++];
  if (b <= 0x7f) return b;                       // positive fixint
  if (b >= 0xe0) return b - 0x100;               // negative fixint
  if (b >= 0xa0 && b <= 0xbf) return readStr(r, b - 0xa0);   // fixstr
  if (b >= 0x90 && b <= 0x9f) return readArr(r, b - 0x90);   // fixarray
  if (b >= 0x80 && b <= 0x8f) return readMap(r, b - 0x80);   // fixmap

  switch (b) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBin(r, readU8(r));
    case 0xc5: return readBin(r, readU16(r));
    case 0xc6: return readBin(r, readU32(r));
    case 0xca: { const v = r.buf.readFloatBE(r.off); r.off += 4; return v; }
    case 0xcb: { const v = r.buf.readDoubleBE(r.off); r.off += 8; return v; }
    case 0xcc: return readU8(r);
    case 0xcd: return readU16(r);
    case 0xce: return readU32(r);
    case 0xcf: return readU64(r);
    case 0xd0: { const v = r.buf.readInt8(r.off); r.off += 1; return v; }
    case 0xd1: { const v = r.buf.readInt16BE(r.off); r.off += 2; return v; }
    case 0xd2: { const v = r.buf.readInt32BE(r.off); r.off += 4; return v; }
    case 0xd3: return readI64(r);
    case 0xd9: return readStr(r, readU8(r));
    case 0xda: return readStr(r, readU16(r));
    case 0xdb: return readStr(r, readU32(r));
    case 0xdc: return readArr(r, readU16(r));
    case 0xdd: return readArr(r, readU32(r));
    case 0xde: return readMap(r, readU16(r));
    case 0xdf: return readMap(r, readU32(r));
    default:
      throw new Error(`notepack: unsupported opcode 0x${b.toString(16)} at offset ${r.off - 1}`);
  }
}

function readU8(r)  { ensure(r, 1); const v = r.buf.readUInt8(r.off);    r.off += 1; return v; }
function readU16(r) { ensure(r, 2); const v = r.buf.readUInt16BE(r.off); r.off += 2; return v; }
function readU32(r) { ensure(r, 4); const v = r.buf.readUInt32BE(r.off); r.off += 4; return v; }
function readU64(r) { ensure(r, 8); const v = Number(r.buf.readBigUInt64BE(r.off)); r.off += 8; return v; }
function readI64(r) { ensure(r, 8); const v = Number(r.buf.readBigInt64BE(r.off));  r.off += 8; return v; }

function readStr(r, n) {
  ensure(r, n);
  const s = r.buf.toString('utf-8', r.off, r.off + n);
  r.off += n;
  return s;
}
function readBin(r, n) {
  ensure(r, n);
  const slice = Buffer.from(r.buf.subarray(r.off, r.off + n));
  r.off += n;
  return slice;
}
function readArr(r, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readValue(r);
  return out;
}
function readMap(r, n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = readValue(r);
    const v = readValue(r);
    out[String(k)] = v;
  }
  return out;
}
function ensure(r, n) {
  if (r.off + n > r.buf.length) throw new Error(`notepack: unexpected EOF (need ${n} bytes at ${r.off})`);
}

module.exports = { decodeNotepack };
```

**Step 4: `npm test -- notepack` → all green.**

### Subtask 1.2: Wire into ccon.js

**Step 5: Test for v2 decoding.**

`test/unit/ccon.v2.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { decodeCcon } from '../../src/core/cocos3x/ccon.js';

function makeCconV2(notepackBody) {
  // magic=CCON, version=2, totalByteLength, jsonLen=notepack.length, body, no chunks.
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x4E4F4343, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(16 + notepackBody.length, 8);
  head.writeUInt32LE(notepackBody.length, 12);
  return Buffer.concat([head, notepackBody]);
}

describe('decodeCcon v2', () => {
  it('decodes notepack body into document', () => {
    // notepack for [1, "two", true]
    const body = Buffer.from([0x93, 0x01, 0xa3, 0x74, 0x77, 0x6f, 0xc3]);
    const out = decodeCcon(makeCconV2(body));
    expect(out.version).toBe(2);
    expect(out.document).toEqual([1, 'two', true]);
    expect(out.rawJson).toBeUndefined();
  });

  it('keeps rawJson + does not throw on undecodable body', () => {
    // 0xc1 is reserved/unsupported in our decoder.
    const body = Buffer.from([0xc1]);
    const out = decodeCcon(makeCconV2(body));
    expect(out.version).toBe(2);
    expect(out.document).toBeUndefined();
    expect(Buffer.isBuffer(out.rawJson)).toBe(true);
  });
});
```

**Step 6: Modify `ccon.js`.**

Replace the `if (version === 1) { ... }` block (and the result-building tail) with:
```js
const { decodeNotepack } = require('./notepack');
// ...
let document = null;
let rawJson = null;
if (version === 1) {
  document = JSON.parse(rawJsonBuf.toString('utf-8'));
} else if (version === 2) {
  try {
    document = decodeNotepack(rawJsonBuf);
  } catch {
    rawJson = rawJsonBuf;
  }
} else {
  rawJson = rawJsonBuf;
}

const result = { version, chunks };
if (document !== null) result.document = document;
if (rawJson !== null) result.rawJson = rawJson;
return result;
```

(Variable rename: the existing code calls the slice `rawJson`. Rename the local to `rawJsonBuf` to avoid shadow conflict.)

**Step 7: `npm test` → all green (was 16, now ≥18).**

**Step 8: Commit.**

```
feat(3x): CCON v2 (notepack) decoder (R5)

- Adds src/core/cocos3x/notepack.js (msgpack subset decoder, no deps)
- decodeCcon() now produces a real .document for version==2 files
- Falls back to rawJson on undecodable bodies (no throw)
```

---

## Task 2: R6 — IPackedFileData full rehydrate

**Files:**
- Modify: `src/core/cocos3x/rehydrate.js` (export multi-section rehydrate)
- Modify: `src/core/cocos3x/engine3x.js` (`tryRehydrate` no longer skips IPackedFileData)
- Create: `test/unit/rehydrate.packed.test.js`

The current code at `engine3x.js:599-609` returns `null` for IPackedFileData; the splicing logic already exists at `extractPackSection` (594-596) but is only called for the single-asset pack-index path. We need a function that takes a full IPackedFileData and emits a rehydrated array of sections (one per asset), each in the same source-format shape rehydrate currently produces for a standalone IFileData.

**Step 1: Failing test.**

`test/unit/rehydrate.packed.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { rehydrateIPackedFileData } from '../../src/core/cocos3x/rehydrate.js';

describe('rehydrateIPackedFileData', () => {
  it('returns null on non-packed input', () => {
    expect(rehydrateIPackedFileData(null)).toBeNull();
    expect(rehydrateIPackedFileData([])).toBeNull();
    expect(rehydrateIPackedFileData([1, 2, 3])).toBeNull();
  });

  it('rehydrates each section against the shared header', () => {
    // Synthetic IPackedFileData with two sections.
    // sharedClasses: [['cc.Foo', ['_name', 'value'], 2, 0, 0]]
    // shared header: [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections[]]
    // section: [instances, instanceTypes, refs, dependObjs, dependKeys, dependUuidIndices]
    // Each section has one instance: [maskIdx=0, _name="A", value=1]
    const packed = {
      sections: [
        [ [[0, 'A', 1]], 0, null, [], [], [] ],
        [ [[0, 'B', 2]], 0, null, [], [], [] ],
      ],
      // Plain-object form (some 3.x emitters use this; we still want to detect it).
    };
    // Plain-object form requires a different parse path. Use the array form instead:
    const arrForm = [
      1,                                                  // version
      [],                                                 // sharedUuids
      [],                                                 // sharedStrings
      [['cc.Foo', ['_name', 'value'], 2, 0, 0]],          // sharedClasses
      [[0, 0, 1, 3]],                                     // sharedMasks: classIdx=0, prop indices, maskTypeOffset=3
      [
        [ [[0, 'A', 1]], 0, null, [], [], [] ],
        [ [[0, 'B', 2]], 0, null, [], [], [] ],
      ],
    ];
    const out = rehydrateIPackedFileData(arrForm);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toMatchObject({ __type__: 'cc.Foo', _name: 'A', value: 1 });
    expect(out[1][0]).toMatchObject({ __type__: 'cc.Foo', _name: 'B', value: 2 });
  });
});
```

**Step 2: Run, expect failure (export missing).**

**Step 3: Implement in `rehydrate.js`.**

After `rehydrateIFileData` add:
```js
/**
 * Rehydrate an IPackedFileData (a multi-section pack) by splicing the shared
 * header onto each section to form a standalone IFileData and rehydrating that.
 *
 * Accepts both forms:
 *   - Array form: [version, sharedUuids, sharedStrings, sharedClasses,
 *                  sharedMasks, sections[]]
 *   - Object form: { sections: [...], plus shared* keys (rare 3.0–3.2) }
 *
 * @param {any} doc
 * @returns {Array<any[]>|null} array of rehydrated source-format arrays (one per
 *   section), or null if the input doesn't look like a pack.
 */
function rehydrateIPackedFileData(doc) {
  if (doc == null) return null;

  let version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections;

  if (Array.isArray(doc) && doc.length >= 6 && Array.isArray(doc[5])) {
    [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections] = doc;
  } else if (doc && typeof doc === 'object' && Array.isArray(doc.sections)) {
    version = doc.version ?? 1;
    sharedUuids = doc.sharedUuids || doc[File.SharedUuids] || [];
    sharedStrings = doc.sharedStrings || doc[File.SharedStrings] || [];
    sharedClasses = doc.sharedClasses || doc[File.SharedClasses] || [];
    sharedMasks = doc.sharedMasks || doc[File.SharedMasks] || [];
    sections = doc.sections;
  } else {
    return null;
  }

  if (!Array.isArray(sections) || !Array.isArray(sharedClasses)) return null;

  const out = [];
  for (const section of sections) {
    if (!Array.isArray(section)) { out.push(null); continue; }
    const standalone = [
      version,
      sharedUuids,
      sharedStrings,
      sharedClasses,
      sharedMasks,
      section[0] || [],   // instances
      section[1] || 0,    // instanceTypes
      section[2] || null, // refs
      section[3] || [],   // dependObjs
      section[4] || [],   // dependKeys
      section[5] || [],   // dependUuidIndices
    ];
    out.push(rehydrateIFileData(standalone));
  }
  return out;
}

module.exports = {
  rehydrateIFileData,
  rehydrateIPackedFileData,
  DataTypeID,
  File,
  VALUE_TYPE_CONSTRUCTORS,
};
```

**Step 4: Wire `engine3x.tryRehydrate`.**

Change the IPackedFileData skip (`engine3x.js:602-604`) to delegate:
```js
function tryRehydrate(doc) {
  try {
    if (doc && typeof doc === 'object' && Array.isArray(doc.sections)) {
      const sections = rehydrateIPackedFileData(doc);
      return sections; // array form, written as-is
    }
    if (Array.isArray(doc) && doc.length >= 6 && Array.isArray(doc[5]) && Array.isArray(doc[5][0])
        && Array.isArray(doc[5][0][0])) {
      // Heuristic: array-form pack — sections live at [5] and each section is itself
      // a length-6 array.
      const sections = rehydrateIPackedFileData(doc);
      if (sections) return sections;
    }
    if (!Array.isArray(doc) || doc.length < 6) return null;
    return rehydrateIFileData(doc);
  } catch {
    return null;
  }
}
```

Add the import at the top of `engine3x.js`:
```js
const { rehydrateIFileData, rehydrateIPackedFileData } = require('./rehydrate');
```

**Step 5: Tests pass + integration regression check.**

```bash
npm test -- rehydrate.packed
npm test                                # ≥19 passed
npm test -- recovery-report             # zqndtz still produces report
```

**Step 6: Commit.**

```
feat(3x): full IPackedFileData rehydrate (R6)

- Adds rehydrateIPackedFileData() splicing shared header onto each section
- engine3x.tryRehydrate routes packs through it instead of falling through
- Handles both array and object form packs
```

---

## Task 3: R7 — TypedArray DataTypeID coverage

**Files:**
- Modify: `src/core/cocos3x/rehydrate.js` (`DataTypeID` enum + `assignByType` switch)
- Create: `test/unit/rehydrate.typedarray.test.js`

In current cocos-engine, `DataTypeID.TypedArray = 13` and `DataTypeID.TypedArray_Class = 14`. Encoded form: `[ctorTag, base64String]` where ctorTag is an index into `[Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, Uint8ClampedArray]`. We don't need to allocate real TypedArrays — for source-format JSON we emit `{ __type__: '<TypedArrayCtor>', __data__: '<base64>' }` so downstream tooling round-trips it.

**Step 1: Failing test.**

`test/unit/rehydrate.typedarray.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { rehydrateIFileData, DataTypeID } from '../../src/core/cocos3x/rehydrate.js';

describe('TypedArray DataTypeID', () => {
  it('exposes the enum constants', () => {
    expect(DataTypeID.TypedArray).toBe(13);
    expect(DataTypeID.TypedArray_Class).toBe(14);
  });

  it('rehydrates a single TypedArray field', () => {
    // Class with one TypedArray field "buf"
    // sharedClasses[0] = ['cc.Foo', ['buf'], 1, 13]
    //   propTypeOffset = 1 → dataTypes start at index 1, so for keyIdx 0 → klass[0+1]=13
    // Mask: [classIdx=0, key=0, maskTypeOffset=1] → 0 simple props, 1 advanced
    // Instance: [maskIdx=0, value]
    const doc = [
      1,                                          // version
      [],                                         // sharedUuids
      [],                                         // sharedStrings
      [['cc.Foo', ['buf'], 1, 13]],               // sharedClasses
      [[0, 0, 1]],                                // sharedMasks: classIdx, key=0, maskTypeOffset=1
      [[0, [6, 'AQID']]],                         // instances: Float32Array tag=6, base64 of [1,2,3]
      0,                                          // instanceTypes (length)
      null,                                       // refs
      [], [], [],                                 // depend*
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0]).toMatchObject({
      __type__: 'cc.Foo',
      buf: { __type__: 'Float32Array', __data__: 'AQID' },
    });
  });

  it('rehydrates Array_TypedArray (TypedArray_Class as array element)', () => {
    const doc = [
      1, [], [],
      [['cc.Bar', ['arr'], 1, 14]],               // dataType 14 = TypedArray_Class
      [[0, 0, 1]],
      [[0, [[6, 'AQID'], [7, 'BAUG']]]],          // array of two TypedArrays
      0, null, [], [], [],
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0].arr).toEqual([
      { __type__: 'Float32Array', __data__: 'AQID' },
      { __type__: 'Float64Array', __data__: 'BAUG' },
    ]);
  });

  it('handles zero-length and unknown ctor', () => {
    const doc = [
      1, [], [],
      [['cc.Empty', ['a', 'b'], 1, 13, 13]],
      [[0, 0, 1, 2]],
      [[0, [6, ''], [99, 'XX']]],
      0, null, [], [], [],
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0].a).toEqual({ __type__: 'Float32Array', __data__: '' });
    expect(out[0].b).toEqual({ __type__: 'unknown', __data__: 'XX', __ctor__: 99 });
  });
});
```

**Step 2: Run, expect failure (DataTypeID.TypedArray is undefined).**

**Step 3: Implement.**

In `rehydrate.js` extend `DataTypeID`:
```js
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
  TypedArray: 13,
  TypedArray_Class: 14,
});

const TYPED_ARRAY_CTORS = [
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'Uint8ClampedArray',
];

function decodeTypedArray(value) {
  if (!Array.isArray(value)) return value;
  const tag = value[0];
  const data = value[1];
  const ctor = TYPED_ARRAY_CTORS[tag];
  if (ctor) return { __type__: ctor, __data__: typeof data === 'string' ? data : '' };
  return { __type__: 'unknown', __data__: typeof data === 'string' ? data : '', __ctor__: tag };
}
```

Extend `assignByType` switch:
```js
case DataTypeID.TypedArray:
  owner[key] = decodeTypedArray(value);
  return;
case DataTypeID.TypedArray_Class:
  if (Array.isArray(value)) {
    owner[key] = value.map(decodeTypedArray);
  } else {
    owner[key] = value;
  }
  return;
```

**Step 4: Tests pass.**

`npm test -- rehydrate.typedarray` → 3 passed. `npm test` overall green (≥22 passed).

**Step 5: Commit.**

```
feat(3x): TypedArray DataTypeID rehydrate (R7)

- Recognises DataTypeID 13 (TypedArray) and 14 (TypedArray_Class)
- Emits { __type__: '<Ctor>', __data__: '<base64>' } source-format markers
- Maps the 9 TypedArray ctors used by cocos-engine
```

---

## Task 4: R8 — Cross-bundle redirect resolution

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` (resolve redirect when an import is missing)
- Create: `test/unit/redirect.test.js`
- Create: `test/integration/redirect.test.js`

### Background

`bundleConfig.parseBundleConfig` already extracts a `redirect: { uuid → depBundleName }` map from `config.json`. Currently nothing in engine3x consults it. When a `paths` entry's import file is missing on disk, the asset is "redirected" to a different bundle (referenced via `cfg.deps`). The engine resolves at runtime by looking up the dep bundle and reading from there.

For unpack we need:
1. After loading every bundle's config, build a registry `bundleByName: Map<string, BundleConfig>`.
2. Pass the registry into `unpackBundle` / `unpackAsset`.
3. When `pathExists(importSrc)` is false AND `cfg.redirect[uuid]` is set AND the dep bundle is present → look up the file in the dep bundle and read from there.
4. The output asset still belongs to the **current** bundle's output dir (don't move it across bundles — that would change the user's view of the project).
5. On a successful redirect, log via `logger.debug(\`redirect: [${cfg.name}] ${uuid} -> ${depName}\`)` and add a `report.miss` is wrong here — record it as `report.ok` because the file *was* recovered, just from elsewhere.

### Subtask 4.1: helper unit test

**Step 1: Failing test.**

`test/unit/redirect.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { resolveImportThroughRedirect } from '../../src/core/cocos3x/engine3x.js';

const cfgA = {
  name: 'main',
  baseDir: '/A',
  importBase: 'import',
  nativeBase: 'native',
  versions: { import: {}, native: {} },
  redirect: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': 'shared' },
};
const cfgShared = {
  name: 'shared',
  baseDir: '/B',
  importBase: 'import',
  nativeBase: 'native',
  versions: { import: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': '1' }, native: {} },
  redirect: {},
};

describe('resolveImportThroughRedirect', () => {
  it('returns null when no redirect entry', () => {
    expect(resolveImportThroughRedirect(cfgA, 'unrelated', new Map())).toBeNull();
  });

  it('returns null when redirect target not in registry', () => {
    expect(
      resolveImportThroughRedirect(cfgA, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', new Map())
    ).toBeNull();
  });

  it('returns the dep-bundle import path when both side present', () => {
    const reg = new Map([['shared', cfgShared]]);
    const r = resolveImportThroughRedirect(cfgA, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', reg);
    expect(r).toMatchObject({ depName: 'shared', cfg: cfgShared });
    expect(r.importJsonPath.endsWith('aa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.1.json')).toBe(true);
    expect(r.importCconPath.endsWith('aa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.1.cconb')).toBe(true);
  });
});
```

**Step 2: Run, expect failure (export missing).**

**Step 3: Implement.**

In `engine3x.js` add (near `getImportPath` import or below `unpackAsset`):
```js
function resolveImportThroughRedirect(cfg, uuid, registry) {
  const depName = cfg.redirect && cfg.redirect[uuid];
  if (!depName) return null;
  const depCfg = registry instanceof Map ? registry.get(depName) : null;
  if (!depCfg) return null;
  return {
    depName,
    cfg: depCfg,
    importJsonPath: getImportPath(depCfg, uuid, '.json'),
    importCconPath: getImportPath(depCfg, uuid, '.cconb'),
  };
}
module.exports = { ...module.exports, resolveImportThroughRedirect };
// (or extend the existing module.exports list — match whatever pattern engine3x.js uses)
```

If `engine3x.js` doesn't currently export anything, add `module.exports = { reverseProject3x, resolveImportThroughRedirect, ... };` keeping existing exports intact. **Read the bottom of engine3x.js first to see actual exports.**

### Subtask 4.2: build registry + use in unpackAsset

**Step 4: Modify `reverseProject3x`.**

Find where `reverseProject3x` discovers bundles (look for the loop iterating `assets/`, that builds an array of `cfg` objects). After all configs are loaded, build:
```js
const bundleRegistry = new Map(allConfigs.map(c => [c.name, c]));
```
Pass `bundleRegistry` through to `unpackBundle({ ..., bundleRegistry })` and onward to `unpackAsset({ ..., bundleRegistry })`.

**Step 5: Modify `unpackAsset`.**

In `unpackAsset`, after the existing import-source resolution but before the "import not found" path takes over, insert:
```js
// Cross-bundle redirect: if neither importSrc nor importSrcCcon exists locally
// but cfg.redirect points to another bundle, read the import from there.
let redirectInfo = null;
if (!(await pathExists(importSrc)) && !(await pathExists(importSrcCcon))) {
  redirectInfo = resolveImportThroughRedirect(cfg, uuid, bundleRegistry);
}
```

Then in the existing `if (await pathExists(importSrc))` chain, add a third branch at the end:
```js
} else if (redirectInfo) {
  const candidate = await pathExists(redirectInfo.importJsonPath)
    ? redirectInfo.importJsonPath
    : (await pathExists(redirectInfo.importCconPath) ? redirectInfo.importCconPath : null);
  if (candidate) {
    const buf = await readFile(candidate);
    if (isCcon(buf)) {
      importDoc = await decodeCconToDoc(buf, outBase);
      importFromCcon = true;
    } else {
      try { importDoc = JSON.parse(buf.toString('utf-8')); } catch { importDoc = null; }
    }
    if (importDoc !== null) {
      if (!skipImportWrite) {
        const disabled = process.env.CC_REVERSE_NO_REHYDRATE === '1';
        const content = disabled ? importDoc : (tryRehydrate(importDoc) || importDoc);
        await writeFile(outBase + importExt, JSON.stringify(content, null, 2));
      }
      importRecovered = true;
      logger.debug(`redirect: [${cfg.name}] ${uuid} <- ${redirectInfo.depName}`);
    }
  }
}
```

### Subtask 4.3: integration test

**Step 6: Synthetic two-bundle integration test.**

`test/integration/redirect.test.js`:
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reverseProject3x } from '../../src/core/cocos3x/engine3x.js';

let buildRoot;
let outDir;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-build-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-out-'));

  // Two bundles: main has a redirect entry to shared; shared owns the import.
  // UUID layout: 'aa******' so first-2-byte path-shard is 'aa'.
  const sharedUuid = 'aabbccdd-eeff-0011-2233-445566778899';

  const mainBundle = path.join(buildRoot, 'assets/main');
  const sharedBundle = path.join(buildRoot, 'assets/shared');
  fs.mkdirSync(path.join(mainBundle, 'import/aa'),    { recursive: true });
  fs.mkdirSync(path.join(sharedBundle, 'import/aa'), { recursive: true });

  // sharedBundle owns the asset (import file present).
  fs.writeFileSync(
    path.join(sharedBundle, 'import/aa', `${sharedUuid}.json`),
    JSON.stringify([{ __type__: 'cc.Asset', _name: 'redirected' }])
  );
  // sharedBundle config: declares the uuid in paths.
  fs.writeFileSync(path.join(sharedBundle, 'config.json'), JSON.stringify({
    name: 'shared',
    importBase: 'import',
    nativeBase: 'native',
    deps: [],
    types: ['cc.Asset'],
    uuids: [sharedUuid],
    paths: { '0': ['shared/redirected', 0] },
    scenes: {},
    packs: {},
    redirect: [],
    extensionMap: {},
    versions: { import: [], native: [] },
    debug: true,
  }));

  // mainBundle: declares uuid + redirect to 'shared'.
  fs.writeFileSync(path.join(mainBundle, 'config.json'), JSON.stringify({
    name: 'main',
    importBase: 'import',
    nativeBase: 'native',
    deps: ['shared'],
    types: ['cc.Asset'],
    uuids: [sharedUuid],
    paths: { '0': ['main/proxy', 0] },
    scenes: {},
    packs: {},
    redirect: [0, 0],   // uuid index 0 → dep index 0 ('shared')
    extensionMap: {},
    versions: { import: [], native: [] },
    debug: true,
  }));
});

afterAll(() => {
  // tmp dirs left for OS cleanup; this is fine.
});

describe('integration: cross-bundle redirect', () => {
  it('writes the redirected asset under the requesting bundle', async () => {
    await reverseProject3x({ sourcePath: buildRoot, outputPath: outDir });
    // Asset should appear under main's output.
    const expected = path.join(outDir, 'assets/main/main/proxy.json');
    expect(fs.existsSync(expected)).toBe(true);
    const written = JSON.parse(fs.readFileSync(expected, 'utf-8'));
    // Either rehydrated or pass-through, but the _name should travel.
    const flat = JSON.stringify(written);
    expect(flat).toContain('redirected');
  }, 30_000);
});
```

(Adapt the test to whatever signature `reverseProject3x` actually accepts — read the file first; the names `sourcePath`/`outputPath` were used in the PR 1 integration test.)

**Step 7: Run + commit.**

```bash
npm test -- redirect
npm test
```

Both green. Commit:
```
feat(3x): cross-bundle redirect resolution at unpack time (R8)

- Adds resolveImportThroughRedirect() helper
- reverseProject3x builds a Map<bundleName, cfg> and threads it down
- unpackAsset reads the import from the dep bundle when a local file is missing
  and cfg.redirect points to it
- Integration test covers a synthetic two-bundle layout
```

---

## Task 5: Validate gates for Wave 1

**Files:**
- Create: `src/validate/gates/cconV2.js`
- Create: `src/validate/gates/typedArrays.js`
- Modify: `src/validate/index.js` (register both)
- Create: `test/unit/validate.cconV2.test.js`
- Create: `test/unit/validate.typedArrays.test.js`

Two gates to make Wave 1 work observable in the validate runner.

### Gate A: `cconV2`

Counts `*.ccon-v2.rawjson` files in the output directory. Passing condition: zero files (i.e. every CCON v2 was successfully decoded). On a fixture with a known undecodable file we'd expect this to fail — the gate's purpose is to surface regressions.

`src/validate/gates/cconV2.js`:
```js
const fs = require('fs');
const path = require('path');
module.exports = function(outDir) {
  const found = [];
  walk(outDir, p => { if (p.endsWith('.ccon-v2.rawjson')) found.push(p); });
  if (found.length === 0) return true;
  return `${found.length} undecoded CCON v2 file(s) — first: ${found[0]}`;
};
function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, visit);
    else visit(f);
  }
}
```

### Gate B: `typedArrays`

Greps the rehydrated JSON for `__type__":"<TypedArrayCtor>"` markers and returns the count. Returns `true` always (informational), but encodes the count in the detail. Used to verify that the typed-array path was exercised at all on a sample.

`src/validate/gates/typedArrays.js`:
```js
const fs = require('fs');
const path = require('path');
const CTORS = ['Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','Uint8ClampedArray'];
const RE = new RegExp(`"__type__":"(${CTORS.join('|')})"`, 'g');
module.exports = function(outDir) {
  let count = 0;
  walk(outDir, p => {
    if (!p.endsWith('.json') && !p.endsWith('.scene') && !p.endsWith('.prefab')) return;
    const body = fs.readFileSync(p, 'utf-8');
    const m = body.match(RE);
    if (m) count += m.length;
  });
  return true; // informational gate; surfaces count via detail
};
function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, visit);
    else visit(f);
  }
}
```

(If you want the count visible, return `{ ok: true, count }` — but `runGates` currently expects strict `true`. To stay compatible, log via `console.error` at a higher level, or extend `runGates` to allow `{ ok: true, detail }`. **For this PR, keep it simple: return `true` and skip the count in the JSON — we'll richen `runGates` in PR 5.**)

### Subtask 5.1: tests + register

`test/unit/validate.cconV2.test.js`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGates } from '../../src/validate/index.js';

describe('validate gate: cconV2', () => {
  it('passes when no rawjson files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    fs.writeFileSync(path.join(dir, 'foo.json'), '{}');
    expect(runGates(dir, { gates: ['cconV2'] }).failed).toEqual([]);
  });
  it('fails when a rawjson sentinel is present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub/x.ccon-v2.rawjson'), '');
    expect(runGates(dir, { gates: ['cconV2'] }).failed).toHaveLength(1);
  });
});
```

`test/unit/validate.typedArrays.test.js`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGates } from '../../src/validate/index.js';

describe('validate gate: typedArrays', () => {
  it('always passes (informational)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    fs.writeFileSync(path.join(dir, 'a.json'),
      JSON.stringify([{ "__type__": "Float32Array", "__data__": "AQID" }]));
    expect(runGates(dir, { gates: ['typedArrays'] }).failed).toEqual([]);
  });
});
```

Register in `src/validate/index.js`:
```js
const recoveryReport = require('./gates/recoveryReport');
const cconV2         = require('./gates/cconV2');
const typedArrays    = require('./gates/typedArrays');
const ALL = { recoveryReport, cconV2, typedArrays };
```

**Run + commit:**

```bash
npm test
```

```
feat(validate): cconV2 + typedArrays gates for Wave 1

- cconV2: fails when undecoded .ccon-v2.rawjson files remain
- typedArrays: informational pass for now (count surfacing in PR 5)
```

---

## Task 6: PR-close — CHANGELOG, README, push, PR

**Step 1: CHANGELOG.**

Prepend under `## [Unreleased]`:
```md
### Added (PR 2, Wave 1)
- R5: CCON v2 (notepack) decoder — `.cconb` files at version 2 now produce real documents.
- R6: Full IPackedFileData rehydrate — multi-section packs are split and each section rehydrated.
- R7: TypedArray DataTypeID coverage in rehydrate (DataTypeID 13 + 14, 9 ctors).
- R8: Cross-bundle redirect resolution — assets routed via `cfg.redirect` now read from the dep bundle.
- Validate gates: `cconV2`, `typedArrays`.
```

**Step 2: README.**

Append a row to whatever Wave-status table exists, or under the "Validation" subsection added in PR 1, list the new gates.

**Step 3: Verify all green.**

```bash
npm test
npm test -- recovery-report   # zqndtz still green
node bin/validate.js <some-zqndtz-output>
```

**Step 4: Commit docs, push, open PR.**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR2 Wave 1"
git push -u origin feature/pr2-wave1-3x-deserialize
```

```bash
gh pr create --repo clawnet-ai/cc-reverse --base main \
  --head feature/pr2-wave1-3x-deserialize \
  --title "PR2 Wave 1: 3.x deserialization completion (CCON v2 + IPackedFileData + TypedArray + redirect)" \
  --body "<see template below>"
```

PR body template:
```md
## Summary

Wave 1 of the 3.x overhaul. Closes the four remaining deserialization gaps documented in `docs/plans/2026-05-12-cocos-3x-overhaul-design.md` §2.2.

- **R5 CCON v2 (notepack)** — hand-rolled msgpack subset decoder (no deps), wired into `decodeCcon` so version-2 files produce a real `.document`.
- **R6 IPackedFileData** — `rehydrateIPackedFileData` splices shared header onto each section; `tryRehydrate` no longer skips packs.
- **R7 TypedArray** — `DataTypeID.TypedArray (13)` + `TypedArray_Class (14)` recognised; emits `{ __type__: 'Float32Array', __data__: 'base64' }` source markers.
- **R8 Cross-bundle redirect** — `reverseProject3x` builds a `Map<bundleName, cfg>` and `unpackAsset` consults `cfg.redirect` when a local import is missing.
- Two new validate gates (`cconV2`, `typedArrays`).

## Test plan

- [x] `npm test` → 27+ passing
- [x] zqndtz integration test still green; `RECOVERY_REPORT.md` `failed` count drops on assets that previously broke on packed/CCON-v2
- [x] Synthetic two-bundle redirect test passes
- [x] No `.ccon-v2.rawjson` sentinel files in zqndtz output (cconV2 gate green)

## Out of scope

- Wave 2 (R9 dynamic project.json, R10 SharedClasses table, R11 class→dir mapping, R12 .meta) — PR 5
- Script recovery layers — PR 3+
```

**Step 5: Cleanup after merge.**

```bash
cd /Users/lcf/code/cc-reverse
git fetch origin
git checkout main
git pull
git worktree remove .worktrees/pr2-wave1-3x-deserialize
git branch -d feature/pr2-wave1-3x-deserialize
```

---

## Out of scope (kept honest)

- Wave 2 (R9–R12) — next PR
- Script recovery (Layer 1–7) — PR 3+
- 2.x parity for any of the above — next round (`NEXT-ROUND-2x-backlog.md`)
- Streaming notepack parser for very large packs (current decoder loads whole buffer into memory; OK for 3.x asset bundles, all under 10 MB in practice)
