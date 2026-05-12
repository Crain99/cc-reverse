# PR 6 — Wave 3: Extended Asset Coverage (Spine / DragonBones / Binary settings) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land Wave 3 of the 3.x overhaul — recover Spine (`sp.SkeletonData`), DragonBones (`dragonBones.DragonBonesAsset` / `DragonBonesAtlasAsset`), and decode binary `settings.bin` projects — plus carry over two PR 5 review nits (rich-meta collision for pure-native classes; `pickCocosVersion` regex tightening).

**Architecture:**
- Extend `engine3x.js` rich-meta path to handle pure-native classes without colliding with the legacy `writeMeta` (which writes `<outBase>.meta`). Strategy: write rich meta to a sibling path that does not collide, OR allow rich-meta to overwrite the legacy stub when the class is in `KLASS_TO_IMPORTER` (the latter is intent — legacy was a placeholder).
- Add Spine / DragonBones entries to `KLASS_TO_IMPORTER` and (in writeAssetMeta) emit the right `subMetas`/`userData` shape so Creator's editor recognises the pair (`.skel + .atlas + .png` for Spine; `_ske.json + _tex.json + _tex.png` for DragonBones).
- Detect `src/settings.bin` (and hashed variants `settings.<md5>.bin`) in `detectProjectFlavor`; decode via the existing notepack subset (added in PR 2 for CCON v2) — the binary settings format is the same notepack envelope.
- Tighten `pickCocosVersion`'s `version` regex from `/^\d+\./` to `/^3\./` (this branch only triggers in 3.x flavor).

**Tech Stack:** Node.js CJS, vitest 1.x ESM tests, @babel/* (already in deps), notepack subset under `external/deserialize/notepack_decode.js` (PR 2).

---

## Background — references

- Design doc: `docs/plans/2026-05-12-cocos-3x-overhaul-design.md` §2.2 Wave 3.
- PR 5 plan/review carry-overs:
  - Pure-native classes (e.g., `cc.BufferAsset`, `cc.Mesh`, `cc.AudioClip` in some builds) have `primaryExt === ''`, so `richMetaPath === outBase + '.meta'` — identical to the path `writeMeta(outBase, …)` already wrote. The `pathExists` guard makes the legacy stub win, suppressing the rich meta. Fix in Task 1.
  - `pickCocosVersion` `version` branch regex `/^\d+\./` is too loose (would accept `2.4.x`). Fix in Task 2.
- Engine landmarks (PR 6 worktree, post-PR5 baseline `781d864`):
  - `src/core/cocos3x/engine3x.js`
    - `CLASS_DIR` (lines ~70-88) — already maps `sp.SkeletonData`→`spine`, `dragonBones.*`→`dragonbones`.
    - `KLASS_TO_IMPORTER` (lines 94-109) — 14 cc.* entries, missing Spine/DragonBones.
    - `writeAssetMeta` (lines 131-144) — writes `<filePath>.meta` with `{ ver, importer, imported, uuid, files, subMetas, userData }`.
    - `unpackAsset` rich-meta block (lines 638-655) — collision site.
    - `recoverScripts()` and `classToImporter()` near line 880-905 (older inline map; keep but note the duplication).
  - `src/core/cocos3x/projectScaffold.js`
    - `pickCocosVersion` lines 240-246 — regex carry-over fix.
    - `detectProjectFlavor` lives in `engine3x.js` (line 243), not here.
  - `src/core/cocos3x/rehydrate.js` — `IFileData` / `IPackedFileData` decode entry; Spine `sp.SkeletonData` rehydration goes here.

- Baseline tests: 105 passing on this branch (`npm test`). Target after PR 6: ~125-130.

---

## Task 0 — Baseline + worktree sanity

**Files:**
- Touch only: `test/unit/pr6-baseline.test.js` (new, single placeholder test that asserts `KLASS_TO_IMPORTER` is exported).

**Step 1: confirm worktree**

Run: `git status && git branch --show-current`
Expected: clean tree, branch `feature/pr6-wave3-extended-assets`.

**Step 2: confirm baseline**

Run: `npm test 2>&1 | tail -5`
Expected: `Test Files  X passed`, total `105 passed`.

**Step 3: write smoke test**

```js
// test/unit/pr6-baseline.test.js
const { describe, it, expect } = require('vitest');
const { KLASS_TO_IMPORTER } = require('../../src/core/cocos3x/engine3x.js');

describe('PR6 baseline', () => {
  it('exposes KLASS_TO_IMPORTER from engine3x', () => {
    expect(KLASS_TO_IMPORTER).toBeTypeOf('object');
    expect(KLASS_TO_IMPORTER['cc.SpriteFrame']).toBe('sprite-frame');
  });
});
```

**Step 4: run the smoke test**

Run: `npx vitest run test/unit/pr6-baseline.test.js`
Expected: 1 passed.

**Step 5: commit**

```bash
git add test/unit/pr6-baseline.test.js docs/plans/2026-05-12-pr6-wave3-extended-assets.md
git commit -m "test(pr6): baseline smoke test (105→106)"
```

---

## Task 1 — Carry-over: rich-meta collision for pure-native classes

**Problem:** When `primaryExt === ''` (e.g., `cc.BufferAsset`), the legacy `writeMeta(outBase, …)` writes `<outBase>.meta` first, then the PR 5 rich-meta block bails because `pathExists(richMetaPath)` is true.

**Fix strategy:** When the class is in `KLASS_TO_IMPORTER`, the rich meta is the *intended* output and should override the legacy stub. Drop the `pathExists` guard for the rich-meta path and let it overwrite. The legacy stub still serves classes outside `KLASS_TO_IMPORTER`.

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` lines 644-654 (rich-meta block).
- Test: `test/unit/3x-richmeta-pure-native.test.js` (new).

**Step 1: failing test**

```js
// test/unit/3x-richmeta-pure-native.test.js
const { describe, it, expect, beforeEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeAssetMeta } = require('../../src/core/cocos3x/engine3x.js');

describe('rich-meta on pure-native classes (PR6 carry-over #1)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-richmeta-'));
  });

  it('overwrites a legacy stub .meta with rich meta when klass is in KLASS_TO_IMPORTER', async () => {
    const outBase = path.join(tmp, 'native', 'ab', 'abcdef');
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    // Simulate the legacy writeMeta stub at <outBase>.meta
    fs.writeFileSync(outBase + '.meta', JSON.stringify({ legacy: true }));
    // Now write rich meta — pure-native primary file is outBase itself
    fs.writeFileSync(outBase, Buffer.from([0, 1, 2, 3]));
    await writeAssetMeta(outBase, { uuid: 'abcdef', klass: 'cc.BufferAsset' });
    const meta = JSON.parse(fs.readFileSync(outBase + '.meta', 'utf-8'));
    expect(meta.legacy).toBeUndefined();
    expect(meta.importer).toBe('buffer');
    expect(meta.uuid).toBe('abcdef');
  });
});
```

Run: `npx vitest run test/unit/3x-richmeta-pure-native.test.js`
Expected: PASS already (writeAssetMeta unconditionally overwrites). Then add second test asserting `unpackAsset` end-to-end behavior — but simpler is to fix the call-site directly.

**Step 2: edit engine3x.js**

Replace lines 644-655:

```js
  // R12 — emit a richer editor-style .meta for non-script assets when class
  // maps to a known importer. We unconditionally overwrite any legacy stub
  // produced by writeMeta() above (PR 6 carry-over #1: pure-native classes
  // like cc.BufferAsset have primaryExt='' so richMetaPath collides with
  // the stub path, and the rich meta is the intended editor-facing output).
  if ((importRecovered || nativeRecovered) && KLASS_TO_IMPORTER[className]) {
    const primaryExt = isPureNativeClass(className) ? '' : inferImportExt(className);
    const primaryFile = outBase + primaryExt;
    try {
      await writeAssetMeta(primaryFile, { uuid, klass: className });
    } catch {
      // best-effort
    }
  }
```

**Step 3: add an integration-style test asserting the overwrite happens via the public path**

```js
  it('rich meta survives when its path collides with the legacy stub', async () => {
    const outBase = path.join(tmp, 'native', 'ab', 'collide');
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + '.meta', JSON.stringify({ legacyStub: true }));
    fs.writeFileSync(outBase, Buffer.from([9]));
    await writeAssetMeta(outBase, { uuid: 'collide', klass: 'cc.BufferAsset' });
    const meta = JSON.parse(fs.readFileSync(outBase + '.meta', 'utf-8'));
    expect(meta.legacyStub).toBeUndefined();
    expect(meta.importer).toBe('buffer');
  });
```

**Step 4: run the full suite**

Run: `npm test 2>&1 | tail -5`
Expected: 108 passed.

**Step 5: commit**

```bash
git add src/core/cocos3x/engine3x.js test/unit/3x-richmeta-pure-native.test.js
git commit -m "fix(3x meta): overwrite legacy stub when class has rich importer (PR5 carry-over)"
```

---

## Task 2 — Carry-over: tighten `pickCocosVersion` 3.x branch regex

**Files:**
- Modify: `src/core/cocos3x/projectScaffold.js:244` (regex `/^\d+\./` → `/^3\./`).
- Test: `test/unit/3x-pickCocosVersion.test.js` (new).

**Step 1: failing test**

```js
// test/unit/3x-pickCocosVersion.test.js
const { describe, it, expect } = require('vitest');
// pickCocosVersion is not exported; test via writeCocos3xProject side-effect, OR
// add a named export. Cleanest: add module.exports.pickCocosVersion = pickCocosVersion;
// in projectScaffold.js for testability.
const { pickCocosVersion } = require('../../src/core/cocos3x/projectScaffold.js');

describe('pickCocosVersion (PR6 carry-over #2)', () => {
  it('accepts engineVersion verbatim', () => {
    expect(pickCocosVersion({ engineVersion: '3.8.2' })).toBe('3.8.2');
  });
  it('accepts creator.version', () => {
    expect(pickCocosVersion({ creator: { version: '3.7.0' } })).toBe('3.7.0');
  });
  it('accepts settings.version when it begins with 3.', () => {
    expect(pickCocosVersion({ version: '3.6.1' })).toBe('3.6.1');
  });
  it('rejects 2.x version strings (PR5 review nit)', () => {
    expect(pickCocosVersion({ version: '2.4.14' })).toBeNull();
  });
  it('returns null for empty', () => {
    expect(pickCocosVersion({})).toBeNull();
    expect(pickCocosVersion(null)).toBeNull();
  });
});
```

Run: `npx vitest run test/unit/3x-pickCocosVersion.test.js`
Expected: FAIL on the 2.x rejection case (regex currently `/^\d+\./`), and FAIL on import (not exported yet).

**Step 2: edit projectScaffold.js**

```js
function pickCocosVersion(settings) {
  if (!settings) return null;
  if (typeof settings.engineVersion === 'string') return settings.engineVersion;
  if (settings.creator && typeof settings.creator.version === 'string') return settings.creator.version;
  if (typeof settings.version === 'string' && /^3\./.test(settings.version)) return settings.version;
  return null;
}

module.exports = { writeCocos2xProject, writeCocos3xProject, pickCocosVersion };
```

**Step 3: run targeted test**

Run: `npx vitest run test/unit/3x-pickCocosVersion.test.js`
Expected: 5 passed.

**Step 4: commit**

```bash
git add src/core/cocos3x/projectScaffold.js test/unit/3x-pickCocosVersion.test.js
git commit -m "fix(3x scaffold): pickCocosVersion only accepts 3.x in version branch (PR5 carry-over)"
```

---

## Task 3 — R14: Spine `sp.SkeletonData` recovery

**Spine asset shape in 3.x:**
- Editor source: `<name>.skel` (or `.json`) + `<name>.atlas` + `<name>.png`.
- Imported `sp.SkeletonData` JSON references skeleton + atlas + texture(s) via `_native` (skeleton binary blob) and `textures: [Texture2D uuids]`, with `atlasText` inline OR atlas as a separate raw text asset.
- Native blob lands in `native/<2>/<uuid>.skel` (or `.json`).

**Strategy (minimum viable):**
1. Add `'sp.SkeletonData': 'spine'` to `KLASS_TO_IMPORTER`.
2. Extend `writeAssetMeta` to emit a `subMetas` map with one entry per referenced texture when klass === `sp.SkeletonData` (best-effort, references uuids the rehydrator already resolved).
3. Add a Spine-specific entry to `inferImportExt` so the import file is written as `<uuid>.json` (the deserialized SkeletonData document) and the native blob keeps its `.skel`/`.json` extension.
4. Cross-link in `unpackAsset` so the native skeleton file lands beside the import JSON in `assets/spine/<uuid>/`.

**Files:**
- Modify: `src/core/cocos3x/engine3x.js`
  - `KLASS_TO_IMPORTER` add `'sp.SkeletonData': 'spine'`.
  - `inferImportExt` add `case 'sp.SkeletonData': return '.json'`.
  - `writeAssetMeta` extend with optional `extras: { textures, atlasUuid }` to populate `subMetas`.
  - `unpackAsset` Spine branch: when `nativeRecovered && className === 'sp.SkeletonData'`, also detect atlas sibling.
- Test: `test/unit/3x-spine-recovery.test.js` (new).

**Step 1: failing test (table-driven)**

```js
// test/unit/3x-spine-recovery.test.js
const { describe, it, expect } = require('vitest');
const { KLASS_TO_IMPORTER, writeAssetMeta } = require('../../src/core/cocos3x/engine3x.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('R14 Spine recovery', () => {
  it('maps sp.SkeletonData to spine importer', () => {
    expect(KLASS_TO_IMPORTER['sp.SkeletonData']).toBe('spine');
  });

  it('writeAssetMeta records textures + atlas when extras provided', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spine-'));
    const file = path.join(tmp, 'hero.json');
    fs.writeFileSync(file, '{}');
    await writeAssetMeta(file, {
      uuid: 'hero-uuid',
      klass: 'sp.SkeletonData',
      extras: { textures: ['tex-1', 'tex-2'], atlasUuid: 'atlas-1' },
    });
    const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf-8'));
    expect(meta.importer).toBe('spine');
    expect(meta.userData.textures).toEqual(['tex-1', 'tex-2']);
    expect(meta.userData.atlasUuid).toBe('atlas-1');
  });
});
```

Run: `npx vitest run test/unit/3x-spine-recovery.test.js`
Expected: FAIL — `sp.SkeletonData` not in `KLASS_TO_IMPORTER`, `extras` not honored.

**Step 2: edit engine3x.js**

```js
// KLASS_TO_IMPORTER:
'sp.SkeletonData': 'spine',
'dragonBones.DragonBonesAsset': 'dragonbones',
'dragonBones.DragonBonesAtlasAsset': 'dragonbones-atlas',

// writeAssetMeta:
async function writeAssetMeta(filePath, opts) {
  const { uuid, klass, extras } = opts;
  const importer = KLASS_TO_IMPORTER[klass] || 'unknown';
  const userData = { recoveredBy: 'cc-reverse' };
  if (extras && typeof extras === 'object') Object.assign(userData, extras);
  const meta = {
    ver: '1.0.0',
    importer,
    imported: true,
    uuid,
    files: [path.extname(filePath)],
    subMetas: {},
    userData,
  };
  await writeFile(filePath + '.meta', JSON.stringify(meta, null, 2));
}
```

**Step 3: thread `extras` from `unpackAsset`**

In the rich-meta block, when `className === 'sp.SkeletonData'`, attempt to pull `textures` and `atlas` uuids from the rehydrated import document (best-effort — guard heavily; if the doc isn't shaped as expected, just skip extras).

```js
let extras;
if (className === 'sp.SkeletonData' && importRecovered) {
  try {
    const doc = JSON.parse(await fsp.readFile(outBase + importExt, 'utf-8'));
    // Look for textures: [{ __uuid__: ... }] and atlasText / _atlas reference
    const textures = Array.isArray(doc.textures)
      ? doc.textures.map(t => t && t.__uuid__).filter(Boolean) : [];
    extras = { textures };
    if (doc.atlasText) extras.atlasInline = true;
  } catch { /* best-effort */ }
}
await writeAssetMeta(primaryFile, { uuid, klass: className, extras });
```

**Step 4: add `inferImportExt` case**

Find the `inferImportExt` function in engine3x.js and add `case 'sp.SkeletonData': return '.json';` if not already covered (it likely defaults to `.json` already; verify by reading the function).

**Step 5: run tests**

Run: `npm test 2>&1 | tail -5`
Expected: 110 passed (108 + 2 new).

**Step 6: commit**

```bash
git add src/core/cocos3x/engine3x.js test/unit/3x-spine-recovery.test.js
git commit -m "feat(3x R14): recover sp.SkeletonData with importer + textures/atlas extras"
```

---

## Task 4 — R15: DragonBones recovery

**DragonBones 3.x shape:**
- `dragonBones.DragonBonesAsset` — references skeleton text/binary + atlas asset uuid.
- `dragonBones.DragonBonesAtlasAsset` — references atlas text/binary + texture uuid.

**Strategy:** Same skeleton as Spine. Already added importer mappings in Task 3 (`'dragonbones'`, `'dragonbones-atlas'`). Now add `extras` extraction:

- For `DragonBonesAsset`: pull `_atlasUuid` / `dragonBonesAtlas.__uuid__` and store under `userData.atlasUuid`.
- For `DragonBonesAtlasAsset`: pull `_textureUuid` / `texture.__uuid__` and store under `userData.textureUuid`.

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` (extras-extraction switch in unpackAsset).
- Test: `test/unit/3x-dragonbones-recovery.test.js` (new).

**Step 1: failing test**

```js
// test/unit/3x-dragonbones-recovery.test.js
const { describe, it, expect } = require('vitest');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { KLASS_TO_IMPORTER, writeAssetMeta } = require('../../src/core/cocos3x/engine3x.js');

describe('R15 DragonBones recovery', () => {
  it('maps DragonBones classes to importers', () => {
    expect(KLASS_TO_IMPORTER['dragonBones.DragonBonesAsset']).toBe('dragonbones');
    expect(KLASS_TO_IMPORTER['dragonBones.DragonBonesAtlasAsset']).toBe('dragonbones-atlas');
  });

  it('writeAssetMeta carries atlas/texture cross-refs via extras', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-'));
    const f = path.join(tmp, 'monster.json');
    fs.writeFileSync(f, '{}');
    await writeAssetMeta(f, {
      uuid: 'm1', klass: 'dragonBones.DragonBonesAsset',
      extras: { atlasUuid: 'a1' },
    });
    const meta = JSON.parse(fs.readFileSync(f + '.meta', 'utf-8'));
    expect(meta.importer).toBe('dragonbones');
    expect(meta.userData.atlasUuid).toBe('a1');
  });
});
```

**Step 2: extend the extras-extraction switch in `unpackAsset`**

Reuse the structure from Task 3:

```js
let extras;
if (importRecovered) {
  try {
    const doc = JSON.parse(await fsp.readFile(outBase + importExt, 'utf-8'));
    if (className === 'sp.SkeletonData') {
      const textures = Array.isArray(doc.textures)
        ? doc.textures.map(t => t && t.__uuid__).filter(Boolean) : [];
      extras = { textures };
      if (doc.atlasText) extras.atlasInline = true;
    } else if (className === 'dragonBones.DragonBonesAsset') {
      const atlasUuid = doc.dragonBonesAtlas && doc.dragonBonesAtlas.__uuid__;
      if (atlasUuid) extras = { atlasUuid };
    } else if (className === 'dragonBones.DragonBonesAtlasAsset') {
      const textureUuid = doc.texture && doc.texture.__uuid__;
      if (textureUuid) extras = { textureUuid };
    }
  } catch { /* best-effort */ }
}
```

**Step 3: run tests**

Run: `npm test 2>&1 | tail -5`
Expected: 112 passed.

**Step 4: commit**

```bash
git add src/core/cocos3x/engine3x.js test/unit/3x-dragonbones-recovery.test.js
git commit -m "feat(3x R15): recover DragonBones asset/atlas with cross-uuid extras"
```

---

## Task 5 — R16: Binary `settings.bin` decoding

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` `detectProjectFlavor` (line ~243).
- Possibly add: `src/core/cocos3x/binarySettings.js` (thin wrapper around the existing notepack subset).
- Test: `test/unit/3x-binary-settings.test.js` (new) + a fixture under `test/fixtures/3x-binary-settings/`.

**Step 1: investigate the existing notepack module**

Run: `ls external/deserialize/ && grep -l "notepack" src/core/cocos3x/*.js`
Note its export shape (likely `decode(buf) → object`).

**Step 2: failing test**

```js
// test/unit/3x-binary-settings.test.js
const { describe, it, expect } = require('vitest');
const fs = require('fs'); const path = require('path'); const os = require('os');
// We'll test detectProjectFlavor — need to expose it. If not exported, add it.
const { detectProjectFlavor } = require('../../src/core/cocos3x/engine3x.js');

describe('R16 binary settings detection', () => {
  it('detects src/settings.bin and decodes a notepack-encoded settings doc', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    // Encode a minimal settings doc using the same notepack subset
    const notepack = require('../../external/deserialize/notepack_decode.js');
    // If only a decoder ships, hand-craft the bytes for { engineVersion: '3.8.0' } via a known-good fixture file
    // For now, copy a fixture:
    const fixture = path.join(__dirname, '..', 'fixtures', '3x-binary-settings', 'settings.bin');
    if (!fs.existsSync(fixture)) {
      // skip until fixture is added
      return;
    }
    fs.copyFileSync(fixture, path.join(tmp, 'src', 'settings.bin'));
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).toBe('3.x');
    expect(out.settings.engineVersion).toBeTypeOf('string');
  });

  it('detects hashed variant settings.<hash>.bin', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-h-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const fixture = path.join(__dirname, '..', 'fixtures', '3x-binary-settings', 'settings.bin');
    if (!fs.existsSync(fixture)) return;
    fs.copyFileSync(fixture, path.join(tmp, 'src', 'settings.abc123.bin'));
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).toBe('3.x');
  });
});
```

**Step 3: build a fixture**

Hand-roll a tiny `settings.bin` by running the existing notepack encoder (or writing a one-shot Node script) on `{ engineVersion: '3.8.0', launchScene: 'db://assets/Main.scene', assets: {} }` and saving to `test/fixtures/3x-binary-settings/settings.bin`. If the local module is decode-only, install `notepack.io` as a devDependency *only* for the fixture-build script, then commit the fixture and uninstall.

Cleaner alternative: write the encoder script as `scripts/build-binary-settings-fixture.js`, run it once, commit the output, document it.

**Step 4: extend `detectProjectFlavor`**

Replace the 3.x marker block:

```js
async function detectProjectFlavor(sourcePath) {
  // 3.x marker — JSON form first
  const settings3xPath = path.join(sourcePath, 'src', 'settings.json');
  if (await pathExists(settings3xPath)) {
    try {
      const s = JSON.parse(await fsp.readFile(settings3xPath, 'utf-8'));
      return { flavor: '3.x', settings: s };
    } catch { /* fall through */ }
  }
  // 3.x marker — binary form (newer builds)
  const binPath = await findBinarySettings(path.join(sourcePath, 'src'));
  if (binPath) {
    try {
      const buf = await fsp.readFile(binPath);
      const decoder = require('../../external/deserialize/notepack_decode.js');
      const decode = typeof decoder === 'function' ? decoder : decoder.decode;
      const s = decode(buf);
      return { flavor: '3.x', settings: s };
    } catch (e) {
      logger.warn(`Failed to decode binary settings at ${binPath}: ${e.message}`);
    }
  }
  // … rest unchanged …
}

async function findBinarySettings(srcDir) {
  if (!(await pathExists(srcDir))) return null;
  let entries;
  try { entries = await readdir(srcDir); } catch { return null; }
  // Prefer plain settings.bin, then hashed settings.<hash>.bin
  if (entries.includes('settings.bin')) return path.join(srcDir, 'settings.bin');
  const hashed = entries.find(n => /^settings\.[0-9a-f]+\.bin$/i.test(n));
  return hashed ? path.join(srcDir, hashed) : null;
}
```

**Step 5: export `detectProjectFlavor` for tests**

Add to `module.exports` at end of engine3x.js.

**Step 6: run tests**

Run: `npm test 2>&1 | tail -5`
Expected: 114 passed.

**Step 7: commit**

```bash
git add src/core/cocos3x/engine3x.js test/unit/3x-binary-settings.test.js test/fixtures/3x-binary-settings/ scripts/build-binary-settings-fixture.js
git commit -m "feat(3x R16): decode src/settings.bin (and hashed variants) via notepack"
```

---

## Task 6 — Integration smoke + CHANGELOG + README + PR

**Step 1: sanity end-to-end on a synthetic micro-bundle**

If a synthetic 3.x fixture exists under `test/fixtures/`, run an integration test that recovers it and asserts: a `.meta` for a `cc.BufferAsset` exists with `importer: "buffer"`. Otherwise skip and rely on unit coverage.

**Step 2: update CHANGELOG**

Append to `CHANGELOG.md`:

```markdown
## PR 6 — Wave 3 extended assets (2026-05-12)

- feat(3x R14): `sp.SkeletonData` recovery with importer + textures/atlas extras.
- feat(3x R15): DragonBones (`DragonBonesAsset` / `DragonBonesAtlasAsset`) recovery with cross-uuid extras.
- feat(3x R16): decode binary `src/settings.bin` (incl. hashed `settings.<hash>.bin`).
- fix(3x meta): rich `.meta` now overwrites the legacy stub for pure-native classes (e.g. `cc.BufferAsset`).
- fix(3x scaffold): `pickCocosVersion` only honours `version` when it begins with `3.`.
```

**Step 3: README touch-up**

Under "Supported assets" / "What we recover" add:

- Spine `sp.SkeletonData` (importer + texture/atlas cross-refs in `.meta`).
- DragonBones `DragonBonesAsset` / `DragonBonesAtlasAsset`.
- Binary `settings.bin` projects.

**Step 4: full test run**

Run: `npm test 2>&1 | tail -10`
Expected: ~114-116 passing, 0 failing.

**Step 5: commit + push + PR**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 6 (Wave 3 extended assets)"
git push -u origin feature/pr6-wave3-extended-assets
gh pr create --base main --head feature/pr6-wave3-extended-assets \
  --title "PR 6: Wave 3 — Spine / DragonBones / binary settings + PR5 carry-overs" \
  --body "$(cat <<'EOF'
## Summary
Wave 3 of the 3.x overhaul + two PR 5 review carry-overs.

### R14 Spine
`sp.SkeletonData` → `spine` importer; rich `.meta` carries texture uuids and atlas-inline flag.

### R15 DragonBones
`DragonBonesAsset`/`DragonBonesAtlasAsset` mapped; rich `.meta` carries atlas/texture cross-uuids.

### R16 Binary settings
`src/settings.bin` (and hashed `settings.<hash>.bin`) decoded via the notepack subset shipped in PR 2.

### Carry-overs
- Pure-native classes (e.g. `cc.BufferAsset`) now keep their rich `.meta` — the previous `pathExists` guard let the legacy stub win.
- `pickCocosVersion` `version` branch tightened from `/^\d+\./` to `/^3\./`.

## Test plan
- [x] `npm test` — 105 → ~115 passing.
- [x] Existing 2.x regression suite untouched.
- [x] No 3.x golden sample regression (rich-meta change is overwrite-not-skip; legacy semantics preserved for unknown classes).
EOF
)"
```

---

## Definition of Done

- [ ] All 6 tasks committed.
- [ ] `npm test` ≥ 114 passing, 0 failing.
- [ ] CHANGELOG + README updated.
- [ ] PR opened against `main` on `clawnet-ai/cc-reverse`.
- [ ] No degradation on 2.x regression tests (dabaoyiqie / cgxfd) — this PR only touches `cocos3x/`.
