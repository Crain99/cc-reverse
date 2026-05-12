# PR 2 — Wave 1 3.x 反序列化补全

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标:** 关闭 3.x 资源反序列化中剩余的四个缺口 — CCON v2 (notepack) 解码器、IPackedFileData 完整复原、`rehydrate.js` 中 TypedArray DataTypeID 覆盖、跨 bundle 重定向解析。增加 validate gates 来证明新路径在 zqndtz golden 样本上工作。

**架构:** 在 PR 1 奠定的基础设施之上，挂上四个相互独立的单元。
- **R5 CCON v2** 位于 `src/core/cocos3x/notepack.js`（一个小的 notepack/msgpack 解码器），并接入 `decodeCcon()`，使 v2 返回真正的 `document` 而非 `rawJson`。我们手写 Cocos 实际发出的 msgpack 子集，而不是引入 50 KB 的依赖。
- **R6 IPackedFileData** 从 "skip and write raw"（`tryRehydrate` 对 `{sections:[]}` 返回 `null`）走向 "通过把每个 section 拼到共享 header 上来 rehydrate"— 该代码路径已在 `extractPackSection` 中原型化，只需从 `tryRehydrate` 调用即可。
- **R7 TypedArray** 将缺失的 `DataTypeID.TypedArray`（当前 cocos-engine 中 = 13）及其数组形式加入 `rehydrate.assignByType`。边界情况：零长度数组、混合数值类型。
- **R8 跨 bundle 重定向** 在 unpack 时解析 `cfg.redirect[uuid] -> depBundleName`，使 bundle A 中缺失的 import 文件能从 bundle B 取得（运行时引擎透明地这么做）。

每个单元先由单元测试（合成 fixture）把关，再由对 zqndtz 实际输出运行的 validate gate 验证。

**技术栈:** Node 14+、vitest 1.x（ESM imports）、`Buffer`、`fs/promises`。无新增运行时依赖。

---

## 预检

你在 `/Users/lcf/code/cc-reverse/.worktrees/pr2-wave1-3x-deserialize` 工作，分支 `feature/pr2-wave1-3x-deserialize`（PR 1 合并后从 `main` 创建）。

**测试文件使用 ESM `import` 语法** — vitest 1.x 拒绝 `require('vitest')`。源文件保持 CJS（`module.exports`）。

变更前 `npm test` 基线：16 passed。

---

## Task 1: R5 — CCON v2 (notepack) 解码器

**文件:**
- 创建: `src/core/cocos3x/notepack.js`
- 修改: `src/core/cocos3x/ccon.js`（version === 2 时调用 notepack 解码器）
- 创建: `test/unit/notepack.test.js`
- 创建: `test/unit/ccon.v2.test.js`

### Subtask 1.1: notepack 子集解码器

Cocos 的 `serialize-ccon.ts` 使用 `@cocos/notepack-lite`，它是 msgpack，带一个扩展：将 `bin8/16/32` 的长度字节序翻转为大端（与规范一致），但其他 cocos 关心的部分使用小端（实际上 Cocos 不关心 — msgpack 严格大端）。我们的目的：按 https://github.com/msgpack/msgpack/blob/master/spec.md 实现严格大端 msgpack，并以 fixture 校验。

**Step 1: 编写失败测试**

`test/unit/notepack.test.js`：
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

**Step 2: 运行，预期失败（模块缺失）。**

`npm test -- notepack` → import 错误。

**Step 3: 实现。**

`src/core/cocos3x/notepack.js`：
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

**Step 4: `npm test -- notepack` → 全绿。**

### Subtask 1.2: 接入 ccon.js

**Step 5: v2 解码测试。**

`test/unit/ccon.v2.test.js`：
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

**Step 6: 修改 `ccon.js`。**

将 `if (version === 1) { ... }` 块（以及构建结果的尾部）替换为：
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

（变量重命名：现有代码把切片叫做 `rawJson`。把局部变量改名为 `rawJsonBuf` 以避免遮蔽冲突。）

**Step 7: `npm test` → 全绿（之前 16，现 ≥18）。**

**Step 8: 提交。**

```
feat(3x): CCON v2 (notepack) decoder (R5)

- Adds src/core/cocos3x/notepack.js (msgpack subset decoder, no deps)
- decodeCcon() now produces a real .document for version==2 files
- Falls back to rawJson on undecodable bodies (no throw)
```

---

## Task 2: R6 — IPackedFileData 完整 rehydrate

**文件:**
- 修改: `src/core/cocos3x/rehydrate.js`（导出多 section rehydrate）
- 修改: `src/core/cocos3x/engine3x.js`（`tryRehydrate` 不再跳过 IPackedFileData）
- 创建: `test/unit/rehydrate.packed.test.js`

`engine3x.js:599-609` 处当前对 IPackedFileData 返回 `null`；splicing 逻辑已存在于 `extractPackSection`（594-596），但只在单资源 pack-index 路径中调用。我们需要一个函数：接收完整 IPackedFileData，并发出每个 asset 一份的 rehydrated section 数组，每份与 rehydrate 当前对独立 IFileData 产出的 source-format 形状一致。

**Step 1: 失败测试。**

`test/unit/rehydrate.packed.test.js`：
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

**Step 2: 运行，预期失败（导出缺失）。**

**Step 3: 在 `rehydrate.js` 中实现。**

在 `rehydrateIFileData` 之后添加：
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

**Step 4: 接入 `engine3x.tryRehydrate`。**

将 IPackedFileData 跳过分支（`engine3x.js:602-604`）改为转发：
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

在 `engine3x.js` 顶部添加 import：
```js
const { rehydrateIFileData, rehydrateIPackedFileData } = require('./rehydrate');
```

**Step 5: 测试通过 + 集成回归检查。**

```bash
npm test -- rehydrate.packed
npm test                                # ≥19 passed
npm test -- recovery-report             # zqndtz still produces report
```

**Step 6: 提交。**

```
feat(3x): full IPackedFileData rehydrate (R6)

- Adds rehydrateIPackedFileData() splicing shared header onto each section
- engine3x.tryRehydrate routes packs through it instead of falling through
- Handles both array and object form packs
```

---

## Task 3: R7 — TypedArray DataTypeID 覆盖

**文件:**
- 修改: `src/core/cocos3x/rehydrate.js`（`DataTypeID` 枚举 + `assignByType` switch）
- 创建: `test/unit/rehydrate.typedarray.test.js`

当前 cocos-engine 中 `DataTypeID.TypedArray = 13`、`DataTypeID.TypedArray_Class = 14`。编码形式：`[ctorTag, base64String]`，其中 ctorTag 是 `[Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, Uint8ClampedArray]` 的下标。我们不需要分配真正的 TypedArray — 对源格式 JSON 我们发出 `{ __type__: '<TypedArrayCtor>', __data__: '<base64>' }`，让下游工具能 round-trip。

**Step 1: 失败测试。**

`test/unit/rehydrate.typedarray.test.js`：
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

**Step 2: 运行，预期失败（DataTypeID.TypedArray 未定义）。**

**Step 3: 实现。**

在 `rehydrate.js` 中扩展 `DataTypeID`：
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

扩展 `assignByType` switch：
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

**Step 4: 测试通过。**

`npm test -- rehydrate.typedarray` → 3 passed。`npm test` 整体绿（≥22 passed）。

**Step 5: 提交。**

```
feat(3x): TypedArray DataTypeID rehydrate (R7)

- Recognises DataTypeID 13 (TypedArray) and 14 (TypedArray_Class)
- Emits { __type__: '<Ctor>', __data__: '<base64>' } source-format markers
- Maps the 9 TypedArray ctors used by cocos-engine
```

---

## Task 4: R8 — 跨 bundle 重定向解析

**文件:**
- 修改: `src/core/cocos3x/engine3x.js`（import 缺失时解析 redirect）
- 创建: `test/unit/redirect.test.js`
- 创建: `test/integration/redirect.test.js`

### 背景

`bundleConfig.parseBundleConfig` 已从 `config.json` 提取 `redirect: { uuid → depBundleName }` map。当前 engine3x 中没有任何代码查询它。当某个 `paths` 条目对应的 import 文件在磁盘上缺失时，资源被 "重定向" 到不同的 bundle（通过 `cfg.deps` 引用）。运行时引擎通过查找 dep bundle 并从那里读取来解析。

unpack 时我们需要：
1. 加载完每个 bundle 的 config 后，构建一个 `bundleByName: Map<string, BundleConfig>` registry。
2. 把 registry 传入 `unpackBundle` / `unpackAsset`。
3. 当 `pathExists(importSrc)` 为 false 且 `cfg.redirect[uuid]` 已设置且 dep bundle 存在时 → 在 dep bundle 中查找该文件并从那里读取。
4. 输出资源仍归属**当前** bundle 的输出目录（不要跨 bundle 移动 — 那会改变用户对项目的视图）。
5. 重定向成功时，通过 `logger.debug(\`redirect: [${cfg.name}] ${uuid} -> ${depName}\`)` 记日志，并加 `report.miss` 是错的 — 应记为 `report.ok`，因为文件*确实*被恢复了，只是从别处。

### Subtask 4.1: 辅助函数单元测试

**Step 1: 失败测试。**

`test/unit/redirect.test.js`：
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

**Step 2: 运行，预期失败（导出缺失）。**

**Step 3: 实现。**

在 `engine3x.js` 中添加（靠近 `getImportPath` import 或 `unpackAsset` 下方）：
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

如果 `engine3x.js` 当前未导出任何东西，添加 `module.exports = { reverseProject3x, resolveImportThroughRedirect, ... };` 保留现有导出完整。**先读 engine3x.js 底部以查看实际导出。**

### Subtask 4.2: 构建 registry + 在 unpackAsset 使用

**Step 4: 修改 `reverseProject3x`。**

找到 `reverseProject3x` 发现 bundles 的位置（查找遍历 `assets/` 并构建 `cfg` 对象数组的循环）。所有 config 加载完后，构建：
```js
const bundleRegistry = new Map(allConfigs.map(c => [c.name, c]));
```
把 `bundleRegistry` 传入 `unpackBundle({ ..., bundleRegistry })` 并向下传给 `unpackAsset({ ..., bundleRegistry })`。

**Step 5: 修改 `unpackAsset`。**

在 `unpackAsset` 中，已有 import 源解析之后但 "import not found" 路径接管之前，插入：
```js
// Cross-bundle redirect: if neither importSrc nor importSrcCcon exists locally
// but cfg.redirect points to another bundle, read the import from there.
let redirectInfo = null;
if (!(await pathExists(importSrc)) && !(await pathExists(importSrcCcon))) {
  redirectInfo = resolveImportThroughRedirect(cfg, uuid, bundleRegistry);
}
```

然后在已有的 `if (await pathExists(importSrc))` 链末尾加第三分支：
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

### Subtask 4.3: 集成测试

**Step 6: 合成两 bundle 集成测试。**

`test/integration/redirect.test.js`：
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

（按 `reverseProject3x` 实际接收的签名调整测试 — 先读源文件；`sourcePath`/`outputPath` 这些名字曾在 PR 1 集成测试中使用。）

**Step 7: 运行 + 提交。**

```bash
npm test -- redirect
npm test
```

均绿。提交：
```
feat(3x): cross-bundle redirect resolution at unpack time (R8)

- Adds resolveImportThroughRedirect() helper
- reverseProject3x builds a Map<bundleName, cfg> and threads it down
- unpackAsset reads the import from the dep bundle when a local file is missing
  and cfg.redirect points to it
- Integration test covers a synthetic two-bundle layout
```

---

## Task 5: Wave 1 的 validate gates

**文件:**
- 创建: `src/validate/gates/cconV2.js`
- 创建: `src/validate/gates/typedArrays.js`
- 修改: `src/validate/index.js`（注册两者）
- 创建: `test/unit/validate.cconV2.test.js`
- 创建: `test/unit/validate.typedArrays.test.js`

两个 gate，让 Wave 1 工作在 validate 运行器中可观测。

### Gate A: `cconV2`

统计输出目录中的 `*.ccon-v2.rawjson` 文件。通过条件：零文件（即每个 CCON v2 都被成功解码）。在已知存在不可解码文件的 fixture 上预期它失败 — 这个 gate 的目的是暴露回归。

`src/validate/gates/cconV2.js`：
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

在 rehydrated JSON 中 grep `__type__":"<TypedArrayCtor>"` 标记并返回数量。始终返回 `true`（信息性），但在 detail 中编码数量。用于验证某样本上是否触发了 typed-array 路径。

`src/validate/gates/typedArrays.js`：
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

（如果想让 count 可见，可返回 `{ ok: true, count }` — 但 `runGates` 当前严格期待 `true`。为兼容性起见，可通过 `console.error` 在更高层记录，或扩展 `runGates` 接受 `{ ok: true, detail }`。**本 PR 保持简单：返回 `true` 并在 JSON 中跳过 count — 在 PR 5 中再丰富 `runGates`。**）

### Subtask 5.1: 测试 + 注册

`test/unit/validate.cconV2.test.js`：
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

`test/unit/validate.typedArrays.test.js`：
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

在 `src/validate/index.js` 中注册：
```js
const recoveryReport = require('./gates/recoveryReport');
const cconV2         = require('./gates/cconV2');
const typedArrays    = require('./gates/typedArrays');
const ALL = { recoveryReport, cconV2, typedArrays };
```

**运行 + 提交：**

```bash
npm test
```

```
feat(validate): cconV2 + typedArrays gates for Wave 1

- cconV2: fails when undecoded .ccon-v2.rawjson files remain
- typedArrays: informational pass for now (count surfacing in PR 5)
```

---

## Task 6: PR 收尾 — CHANGELOG、README、push、PR

**Step 1: CHANGELOG。**

在 `## [Unreleased]` 下前置：
```md
### Added (PR 2, Wave 1)
- R5: CCON v2 (notepack) decoder — `.cconb` files at version 2 now produce real documents.
- R6: Full IPackedFileData rehydrate — multi-section packs are split and each section rehydrated.
- R7: TypedArray DataTypeID coverage in rehydrate (DataTypeID 13 + 14, 9 ctors).
- R8: Cross-bundle redirect resolution — assets routed via `cfg.redirect` now read from the dep bundle.
- Validate gates: `cconV2`, `typedArrays`.
```

**Step 2: README。**

向已存在的 Wave 状态表追加一行，或在 PR 1 中新增的 "Validation" 子章节下列出新 gates。

**Step 3: 验证全绿。**

```bash
npm test
npm test -- recovery-report   # zqndtz still green
node bin/validate.js <some-zqndtz-output>
```

**Step 4: 提交文档、推送、开 PR。**

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

PR body 模板：
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

**Step 5: 合并后清理。**

```bash
cd /Users/lcf/code/cc-reverse
git fetch origin
git checkout main
git pull
git worktree remove .worktrees/pr2-wave1-3x-deserialize
git branch -d feature/pr2-wave1-3x-deserialize
```

---

## 范围外（如实交代）

- Wave 2 (R9–R12) — 下一个 PR
- 脚本恢复 (Layer 1–7) — PR 3+
- 上述任何条目的 2.x 对等 — 下一轮（`NEXT-ROUND-2x-backlog.md`）
- 超大 pack 的流式 notepack 解析器（当前解码器把整个 buffer 一次加载到内存；对于 3.x 资源 bundle 没问题，实践中均小于 10 MB）
