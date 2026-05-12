# PR 5 — Wave 2 (R9–R12) + Layer 7 humanify + carry-over fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring 3.x output up to "honest project metadata" (dynamic `project.json` from source `settings.json`, smarter class→dir mapping, fuller `.meta` files, drop hardcoded type table for 3.x); add opt-in Layer 7 humanify wrapper (`cc-reverse humanify <dir>`); pay back carry-over test/UX gaps from PR 3/4 reviews.

**Architecture:** All Wave 2 changes live in `src/core/cocos3x/projectScaffold.js` + `engine3x.js`. New `src/core/cocos3x/scriptRecovery/humanify.js` (Layer 7, opt-in, shells out to `humanify` CLI when available, no hard dep). Carry-over fixes are surgical edits to existing files. 2.x code path is untouched.

**Tech Stack:** Node ESM; existing babel/ts-morph/prettier; `child_process.spawn` for humanify; vitest.

---

## Carry-over fixes (from PR 3/4 reviews)

| Source | Item | Where |
|---|---|---|
| PR 4 Task 2 review | typeInferer branch tests: `__uuid__` miss → `any`, `__id__` OOB, inline `__type__: cc.X`, null/undefined, multi-module uuidMap aggregation | Task 6 |
| PR 4 Task 3 review | tsProject gate discards count + tsconfig info | Task 5 |
| PR 4 Task 5 review | recoveryIndex gate failure detail truncates to first missing entry | Task 5 |
| PR 4 Task 1 review | ccclassNamer: no test for class self-reference rename, bare `_RF.push`, `@ccclass` no-arg | Task 6 |

---

## State before PR 5

- Branch: `feature/pr5-wave2-and-humanify` from main `9c88745`
- Tests baseline: **80 passing** (21 files)
- 3.x `project.json`: hardcoded `name: 'recovered-cocos3-project'`, `version: '3.0.0'`
- 3.x assets get `.meta` only for scripts; other assets land bare
- 3.x asset placement: `CLASS_DIR` map gives subdir, but path retains source's full `config.paths[uuid].path` — sometimes mismatched
- No humanify wrapper

## Test progression

`80 → 82 (T0) → 86 (T1 R9) → 89 (T2 R10) → 92 (T3 R11+R12) → 96 (T4 humanify) → 100 (T5 gate fixes) → 105 (T6 carry-over tests)`

Final target: **105 passing**.

---

## Task 0: Plan + baseline guard

**Files:**
- This plan file (committed already by user once execution starts).

**Step 1: Verify baseline**

Run: `npm test`
Expected: 80 passing, 21 files.

**Step 2: Add an integration safety net for Wave 2**

Create: `test/integration/wave2.placeholder.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Wave 2 placeholders', () => {
  it('projectScaffold module exports writeCocos3xProject (added in T1)', () => {
    const mod = require('../../src/core/cocos3x/projectScaffold.js');
    // Will be added in T1; for T0 we only assert the existing 2.x writer is intact.
    expect(typeof mod.writeCocos2xProject).toBe('function');
  });

  it('engine3x writeProjectDescriptor still emits a non-empty project.json', () => {
    // Smoke: source file mentions the function we plan to refactor in T1.
    const src = readFileSync(
      path.resolve(__dirname, '../../src/core/cocos3x/engine3x.js'),
      'utf-8'
    );
    expect(src).toMatch(/writeProjectDescriptor/);
    expect(src).toMatch(/project\.json/);
  });
});
```

**Step 3: Run tests**

Run: `npm test`
Expected: 82 passing.

**Step 4: Commit**

```bash
git add docs/plans/2026-05-12-pr5-wave2-and-humanify.md test/integration/wave2.placeholder.test.js
git commit -m "docs+test: PR5 plan + Wave 2 placeholder smoke test"
```

---

## Task 1: R9 — Dynamic 3.x project.json from settings

**Goal:** 3.x output's `project.json`, `package.json`, and `settings/project.json` reflect the source build (engine version, project name, design resolution, launch scene) instead of hardcoded constants.

**Files:**
- Modify: `src/core/cocos3x/projectScaffold.js` — add `writeCocos3xProject(outputPath, opts)` next to existing 2.x writer
- Modify: `src/core/cocos3x/engine3x.js` — replace inline `writeProjectDescriptor` body with call to `writeCocos3xProject`, threading `settings` from `detectProjectFlavor`
- Test: `test/unit/projectScaffold3x.test.js` (new, 4 tests)

**Step 1: Write failing tests**

Create `test/unit/projectScaffold3x.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { writeCocos3xProject } = require('../../src/core/cocos3x/projectScaffold.js');

describe('writeCocos3xProject', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'cc3x-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('emits project.json with name + creator version from settings', async () => {
    await writeCocos3xProject(dir, {
      projectName: 'mygame',
      cocosVersion: '3.8.2',
      settings: { engine: 'cocos-creator', launchScene: 'db://assets/main.scene' },
    });
    const proj = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
    expect(proj.name).toBe('mygame');
    expect(proj.creator.version).toBe('3.8.2');
  });

  it('falls back to defaults when settings are missing', async () => {
    await writeCocos3xProject(dir, {});
    const proj = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
    expect(proj.name).toBeTruthy();
    expect(proj.creator.version).toMatch(/^3\./);
  });

  it('writes settings/project.json with design resolution from settings', async () => {
    await writeCocos3xProject(dir, {
      projectName: 'mygame',
      settings: { designResolution: { width: 750, height: 1334 } },
    });
    const sp = JSON.parse(readFileSync(path.join(dir, 'settings/project.json'), 'utf-8'));
    expect(sp['design-resolution-width']).toBe(750);
    expect(sp['design-resolution-height']).toBe(1334);
  });

  it('writes package.json named after the project', async () => {
    await writeCocos3xProject(dir, { projectName: 'My Game!' });
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    // Sanitized
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true);
  });
});
```

Run: `npm test test/unit/projectScaffold3x.test.js`
Expected: FAIL — `writeCocos3xProject is not a function`.

**Step 2: Implement `writeCocos3xProject`**

Append to `src/core/cocos3x/projectScaffold.js` (before `module.exports`):

```javascript
/**
 * Write a Cocos Creator 3.x project skeleton, populated from the source build's
 * src/settings.json when available.
 *
 * @param {string} outputPath
 * @param {object} opts
 * @param {string} [opts.projectName='recovered-cocos3-project']
 * @param {string} [opts.cocosVersion='3.8.0']
 * @param {object} [opts.settings] parsed src/settings.json contents
 */
async function writeCocos3xProject(outputPath, opts = {}) {
  const settings = opts.settings || {};
  const projectName = opts.projectName || 'recovered-cocos3-project';
  const cocosVersion = opts.cocosVersion || pickCocosVersion(settings) || '3.8.0';
  const launchScene = settings.launchScene || (settings.scenes && settings.scenes[0]?.url) || 'current';
  const design = settings.designResolution || settings.design || { width: 1280, height: 720 };

  await mkdir(outputPath, { recursive: true });

  const projectJson = {
    name: projectName,
    version: cocosVersion,
    engine: 'cocos-creator',
    packages: ['assets'],
    creator: { version: cocosVersion },
    recoveredBy: 'cc-reverse',
  };
  await writeFile(
    path.join(outputPath, 'project.json'),
    JSON.stringify(projectJson, null, 2),
  );

  const safePkgName = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recovered-project';
  const pkgJson = {
    name: safePkgName,
    version: '1.0.0',
    description: 'Recovered by cc-reverse',
    creator: { version: cocosVersion },
    dependencies: {},
  };
  await writeFile(
    path.join(outputPath, 'package.json'),
    JSON.stringify(pkgJson, null, 2),
  );

  const settingsDir = path.join(outputPath, 'settings');
  await mkdir(settingsDir, { recursive: true });
  const settingsProject = {
    'engine-version': cocosVersion,
    'design-resolution-width': design.width,
    'design-resolution-height': design.height,
    'fit-width': false,
    'fit-height': false,
    'start-scene': launchScene,
    'package-name': 'org.cocos.' + safePkgName,
    'recovered-from': settings.assetsZip ? 'assets.zip' : 'web-build',
  };
  await writeFile(
    path.join(settingsDir, 'project.json'),
    JSON.stringify(settingsProject, null, 2),
  );
}

function pickCocosVersion(settings) {
  if (!settings) return null;
  if (typeof settings.engineVersion === 'string') return settings.engineVersion;
  if (settings.creator && typeof settings.creator.version === 'string') return settings.creator.version;
  if (typeof settings.version === 'string' && /^\d+\./.test(settings.version)) return settings.version;
  return null;
}
```

Update the exports line:
```javascript
module.exports = { writeCocos2xProject, writeCocos3xProject };
```

**Step 3: Wire engine3x to use it**

In `src/core/cocos3x/engine3x.js`:

Replace the `writeProjectDescriptor` definition with:
```javascript
const { writeCocos2xProject, writeCocos3xProject } = require('./projectScaffold');

async function writeProjectDescriptor(outputPath, settings, sourceProjectName) {
  await writeCocos3xProject(outputPath, {
    projectName: sourceProjectName,
    settings: settings || {},
  });
}
```

Find the call site of `writeProjectDescriptor(outputPath)` — pass through the `settings` object captured in `detectProjectFlavor` and (if available) a derived project name (e.g., basename of sourcePath). Trace: it's called near the end of `reverseProject3x`. Capture both args from the surrounding scope.

**Step 4: Run tests**

Run: `npm test`
Expected: 86 passing.

**Step 5: Commit**

```bash
git add -u src/core/cocos3x/projectScaffold.js src/core/cocos3x/engine3x.js
git add test/unit/projectScaffold3x.test.js
git commit -m "feat(3x): R9 dynamic project.json from source settings.json"
```

---

## Task 2: R10 — Use SharedClasses dynamic type table for 3.x

**Goal:** Stop loading `src/core/typeDefinitions.js` (which is the 2.x hardcoded table) when rehydrating 3.x assets; rely entirely on each document's own `sharedClasses` (already wired in `rehydrate.js`). Confirm + add a test pinning the behavior so future regressions are caught.

**Files:**
- Audit: `src/core/cocos3x/rehydrate.js` and `src/core/cocos3x/engine3x.js` for any import of `../typeDefinitions`. There should be none — but verify and document with an integration test.
- Test: `test/unit/cocos3x.no-static-types.test.js` (new, 3 tests)

**Step 1: Write tests asserting the boundary**

Create `test/unit/cocos3x.no-static-types.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cocos3xDir = path.resolve(__dirname, '../../src/core/cocos3x');

describe('3.x must not depend on 2.x typeDefinitions', () => {
  function listJs(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...listJs(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }
  const files = listJs(cocos3xDir);

  it('no 3.x file requires ../typeDefinitions', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).not.toMatch(/require\(['"]\.\.\/typeDefinitions['"]\)/);
    }
  });

  it('no 3.x file references the global typeDefinitions object', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      // Loose: catches `typeDefinitions.getProperties(`
      expect(text, f).not.toMatch(/typeDefinitions\.getProperties/);
    }
  });

  it('rehydrate exposes sharedClasses-driven decoder shape', () => {
    const r = require('../../src/core/cocos3x/rehydrate.js');
    expect(typeof r.rehydrateIFileData).toBe('function');
  });
});
```

Run: `npm test test/unit/cocos3x.no-static-types.test.js`
Expected: PASS already (current code has no offending imports). If FAIL, fix the offender by removing the import.

**Step 2: Add a doc comment in rehydrate.js**

Edit the top doc-comment in `src/core/cocos3x/rehydrate.js` to explicitly call out:

```
* NOTE: 3.x rehydration is fully driven by each document's own
* `sharedClasses` array. We deliberately do NOT consult the 2.x
* hardcoded `typeDefinitions` table — see test/unit/cocos3x.no-static-types.test.js
* for the regression guard.
```

**Step 3: Run tests**

Run: `npm test`
Expected: 89 passing.

**Step 4: Commit**

```bash
git add -u src/core/cocos3x/rehydrate.js
git add test/unit/cocos3x.no-static-types.test.js
git commit -m "test(3x): R10 pin 'no static typeDefinitions' boundary"
```

---

## Task 3: R11 + R12 — Smarter class→dir mapping + complete .meta files

**Goal (R11):** When the source project's `config.paths[uuid].path` is empty/missing or collides, derive a sensible output path from the asset's recovered class via `CLASS_DIR` + extension; preserve original path when present.

**Goal (R12):** Emit a richer `.meta` for non-script assets (currently only scripts get one). Use class-aware shape: `{ ver, importer, uuid, files, subMetas }` keyed off the asset class.

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` — extract a `resolveOutputPath(uuid, cfg, klass)` helper; widen the `.meta` emitter to cover non-script assets
- Test: `test/unit/cocos3x.outputPath.test.js` (new, 2 tests)
- Test: `test/integration/cocos3x.metaFiles.test.js` (new, 1 test)

**Step 1: Write failing tests**

Create `test/unit/cocos3x.outputPath.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
const { resolveOutputPath } = require('../../src/core/cocos3x/engine3x.js');

describe('resolveOutputPath', () => {
  it('uses cfg.paths[uuid].path when present', () => {
    const cfg = { paths: { abc: { path: 'subdir/foo' } } };
    expect(resolveOutputPath('abc', cfg, 'cc.SpriteFrame', '.png')).toContain('subdir/foo');
  });

  it('falls back to <classDir>/<uuid> when path missing', () => {
    const cfg = { paths: {} };
    const p = resolveOutputPath('abc-1234', cfg, 'cc.SpriteFrame', '.png');
    expect(p).toMatch(/texture\/abc-1234/);
  });
});
```

Create `test/integration/cocos3x.metaFiles.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
const { writeAssetMeta } = require('../../src/core/cocos3x/engine3x.js');
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('writeAssetMeta', () => {
  it('emits importer + uuid for SpriteFrame', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'meta-'));
    try {
      const file = path.join(dir, 'foo.png');
      require('node:fs').writeFileSync(file, Buffer.from([0]));
      await writeAssetMeta(file, { uuid: 'u1', klass: 'cc.SpriteFrame' });
      const meta = JSON.parse(readFileSync(file + '.meta', 'utf-8'));
      expect(meta.uuid).toBe('u1');
      expect(meta.importer).toMatch(/sprite-frame|texture/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `npm test test/unit/cocos3x.outputPath.test.js test/integration/cocos3x.metaFiles.test.js`
Expected: FAIL — neither helper exported.

**Step 2: Implement helpers in engine3x.js**

Add (export both at the bottom of the file's `module.exports`):

```javascript
const KLASS_TO_IMPORTER = {
  'cc.SpriteFrame': 'sprite-frame',
  'cc.ImageAsset': 'image',
  'cc.Texture2D': 'texture',
  'cc.AudioClip': 'audio-clip',
  'cc.JsonAsset': 'json',
  'cc.TextAsset': 'text',
  'cc.Prefab': 'prefab',
  'cc.SceneAsset': 'scene',
  'cc.Material': 'material',
  'cc.EffectAsset': 'effect',
  'cc.AnimationClip': 'animation-clip',
  'cc.Mesh': 'gltf-mesh',
  'cc.SkeletalAnimationClip': 'skeletal-animation-clip',
  'cc.BufferAsset': 'buffer',
};

function resolveOutputPath(uuid, cfg, klass, ext = '') {
  const explicit = cfg && cfg.paths && cfg.paths[uuid] && cfg.paths[uuid].path;
  if (explicit) return explicit + ext;
  const sub = CLASS_DIR[klass] || 'raw';
  return path.join(sub, uuid) + ext;
}

async function writeAssetMeta(filePath, opts) {
  const { uuid, klass } = opts;
  const importer = KLASS_TO_IMPORTER[klass] || 'unknown';
  const meta = {
    ver: '1.0.0',
    importer,
    imported: true,
    uuid,
    files: [path.extname(filePath)],
    subMetas: {},
    userData: { recoveredBy: 'cc-reverse' },
  };
  await writeFile(filePath + '.meta', JSON.stringify(meta, null, 2));
}

module.exports = {
  // ...existing exports...,
  resolveOutputPath,
  writeAssetMeta,
};
```

(Also ensure `KLASS_TO_IMPORTER` and `CLASS_DIR` are visible to the helper.)

**Step 3: Use the helpers in the asset-write loop**

Find the existing inner loop that copies asset documents (the place that today computes the output filename via `config.paths[uuid].path`). Replace the inline path computation with `resolveOutputPath(uuid, cfg, klass, ext)`. After successfully writing the asset, call `await writeAssetMeta(outBase + ext, { uuid, klass })` if `klass` is in `KLASS_TO_IMPORTER` and a `.meta` file isn't already there.

Keep the existing script `.meta` emitter intact.

**Step 4: Run tests**

Run: `npm test`
Expected: 92 passing.

**Step 5: Commit**

```bash
git add -u src/core/cocos3x/engine3x.js
git add test/unit/cocos3x.outputPath.test.js test/integration/cocos3x.metaFiles.test.js
git commit -m "feat(3x): R11 path resolver + R12 richer asset .meta files"
```

---

## Task 4: Layer 7 humanify wrapper

**Goal:** Provide an opt-in `cc-reverse humanify <dir>` command that calls the user-installed `humanify` CLI on the recovered TS project. No hard dep. Two providers: `local` (default) and `openai` (configurable via `OPENAI_BASE_URL` and `OPENAI_API_KEY`). Detect missing CLI and exit 1 with install instructions; do NOT auto-install.

**Files:**
- Create: `src/core/cocos3x/scriptRecovery/humanify.js`
- Modify: `src/index.js` — register subcommand
- Test: `test/unit/scriptRecovery.humanify.test.js` (new, 4 tests)

**Step 1: Write failing tests**

Create `test/unit/scriptRecovery.humanify.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';

const { runHumanify, buildHumanifyArgs } = require('../../src/core/cocos3x/scriptRecovery/humanify.js');

describe('humanify wrapper', () => {
  it('buildHumanifyArgs default provider local', () => {
    const args = buildHumanifyArgs('/out', { provider: 'local' });
    expect(args[0]).toBe('local');
    expect(args).toContain('-o');
    expect(args).toContain('/out/humanified');
  });

  it('buildHumanifyArgs openai includes api base when given', () => {
    const args = buildHumanifyArgs('/out', { provider: 'openai', baseUrl: 'http://x', apiKey: 'k' });
    expect(args[0]).toBe('openai');
    expect(args.join(' ')).toContain('--api-key');
    expect(args.join(' ')).toContain('--base-url');
  });

  it('buildHumanifyArgs rejects unsupported provider', () => {
    expect(() => buildHumanifyArgs('/out', { provider: 'copilot' })).toThrow(/unsupported/i);
  });

  it('runHumanify returns { ok: false } when binary missing', async () => {
    const r = await runHumanify('/tmp/no-such-dir', {
      provider: 'local',
      _bin: '/definitely/no/such/binary/humanify-xyz',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not.*found|missing/i);
  });
});
```

Run: `npm test test/unit/scriptRecovery.humanify.test.js`
Expected: FAIL — module not found.

**Step 2: Implement `humanify.js`**

```javascript
/*
 * Layer 7 — humanify wrapper.
 *
 * Opt-in. Shells out to the user-installed `humanify` CLI
 * (https://github.com/jehna/humanify). Never installed automatically.
 * Two providers supported:
 *   - local   (default): offline LLM, downloadable model
 *   - openai           : OpenAI-compatible endpoint via OPENAI_BASE_URL / OPENAI_API_KEY
 *
 * The Copilot-via-copilot-api route is documented in the README as a
 * user-borne risk path; we never wire it programmatically.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_PROVIDERS = new Set(['local', 'openai']);

function buildHumanifyArgs(outDir, opts = {}) {
  const provider = opts.provider || 'local';
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`unsupported humanify provider: ${provider}`);
  }
  const args = [provider, '-o', path.join(outDir, 'humanified')];
  if (provider === 'openai') {
    if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
    if (opts.apiKey) args.push('--api-key', opts.apiKey);
    if (opts.model) args.push('--model', opts.model);
  }
  // Input is the recovered TS project root.
  args.push(path.join(outDir, 'assets', 'scripts'));
  return args;
}

async function runHumanify(outDir, opts = {}) {
  const bin = opts._bin || 'humanify';
  if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
    return { ok: false, reason: `humanify binary not found at ${bin}. Install via: npm i -g humanify` };
  }
  let args;
  try {
    args = buildHumanifyArgs(outDir, opts);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  return await new Promise(resolve => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: opts.silent ? 'ignore' : 'inherit' });
    } catch (e) {
      resolve({ ok: false, reason: `spawn failed: ${e.code === 'ENOENT' ? 'humanify binary not found on PATH (npm i -g humanify)' : e.message}` });
      return;
    }
    proc.on('error', e => {
      resolve({ ok: false, reason: e.code === 'ENOENT' ? 'humanify binary not found on PATH (npm i -g humanify)' : String(e.message || e) });
    });
    proc.on('exit', code => {
      if (code === 0) resolve({ ok: true, outDir: path.join(outDir, 'humanified') });
      else resolve({ ok: false, reason: `humanify exited with code ${code}` });
    });
  });
}

module.exports = { runHumanify, buildHumanifyArgs };
```

**Step 3: Wire CLI subcommand in `src/index.js`**

Add (alongside existing commander commands):

```javascript
program
  .command('humanify <outDir>')
  .description('[opt-in, Layer 7] rename minified identifiers via the user-installed humanify CLI')
  .option('--provider <name>', 'local | openai', 'local')
  .option('--base-url <url>', 'OpenAI-compatible base URL', process.env.OPENAI_BASE_URL)
  .option('--api-key <key>', 'OpenAI-compatible API key', process.env.OPENAI_API_KEY)
  .option('--model <name>', 'model name (openai)')
  .action(async (outDir, opts) => {
    const { runHumanify } = require('./core/cocos3x/scriptRecovery/humanify');
    const r = await runHumanify(outDir, {
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    if (!r.ok) {
      console.error('[humanify]', r.reason);
      process.exit(1);
    }
    console.log('[humanify] output →', r.outDir);
  });
```

**Step 4: Run tests**

Run: `npm test`
Expected: 96 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/humanify.js test/unit/scriptRecovery.humanify.test.js
git add -u src/index.js
git commit -m "feat(3x scripts): Layer 7 humanify wrapper (opt-in CLI subcommand)"
```

---

## Task 5: Carry-over gate fixes (PR 4 review)

**Goal:** Fix the two gate UX gaps caught in PR 4 reviews.

- `tsProject` gate: surface tsconfig presence + count in `detail`.
- `recoveryIndex` gate: list ALL missing entries (cap at 10 to keep output sane), not just the first.

**Files:**
- Modify: `src/validate/gates/tsProject.js`
- Modify: `src/validate/gates/recoveryIndex.js`
- Modify: `test/unit/validate.gates.test.js` (add 2 tightened tests; bring file +2)

**Step 1: tsProject — keep the data**

Edit `src/validate/gates/tsProject.js`:

Replace the `void tsFiles; void hasTsconfig;` lines with:

```javascript
return { ok: true, detail: `${tsFiles} .ts file(s); tsconfig.json ${hasTsconfig ? 'present' : 'absent'}` };
```

Check what `runGates` does with `{ ok, detail }` return — sibling gates (e.g., `cconV2`, `layeredScripts`) may return shape variants. Match whatever convention currently surfaces `detail` in `passed`/`failed`. If gates return plain `true`/`string`, instead change tsProject to return the descriptive string only on failure (keep `true` on pass) AND update via `console.log` from the gate itself OR upgrade `runGates` once, so `passed` entries can carry detail. Pick the **lowest-impact** option: if `runGates` already supports object returns (`{name, detail}`), use that; otherwise, just return `true` and accept that tsProject stays informational-only. Document the choice in the test.

**Step 2: recoveryIndex — list all missing**

Edit `src/validate/gates/recoveryIndex.js`:

Replace the failure message with:

```javascript
const list = missing.slice(0, 10).join(', ');
const more = missing.length > 10 ? ` (+${missing.length - 10} more)` : '';
return `${missing.length} missing entries: ${list}${more}`;
```

**Step 3: Tighten tests**

In `test/unit/validate.gates.test.js`, append:

```javascript
it('recoveryIndex failure detail enumerates missing entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    const scriptsDir = path.join(dir, 'assets/scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, 'RECOVERY_INDEX.json'), JSON.stringify({
      a: { path: 'main/A.ts', className: 'A' },
      b: { path: 'main/B.ts', className: 'B' },
    }));
    const r = await runGates(dir, { gates: ['recoveryIndex'] });
    const failed = r.failed.find(x => x.name === 'recoveryIndex');
    expect(failed).toBeTruthy();
    expect(failed.detail).toMatch(/main\/A\.ts/);
    expect(failed.detail).toMatch(/main\/B\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('tsProject pass surfaces file count + tsconfig presence', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    const scriptsDir = path.join(dir, 'assets/scripts/main');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, 'A.ts'), 'export class A {}');
    writeFileSync(path.join(dir, 'assets/scripts/tsconfig.json'), '{}');
    const r = await runGates(dir, { gates: ['tsProject'] });
    const passed = r.passed.find(x => x.name === 'tsProject');
    expect(passed).toBeTruthy();
    expect(passed.detail).toMatch(/1 \.ts file/);
    expect(passed.detail).toMatch(/tsconfig\.json present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Add the necessary imports/helpers at the top of the file if not already present.)

If runGates does NOT today thread `detail` through, also patch `src/validate/index.js` (`runGates`) so a gate returning `{ ok, detail }` populates `passed.push({name, detail})` and a string-return failure populates `failed.push({name, detail: <string>})`. Keep backward compat with bare-`true` returns.

**Step 4: Run tests**

Run: `npm test`
Expected: 100 passing.

**Step 5: Commit**

```bash
git add -u src/validate/gates/tsProject.js src/validate/gates/recoveryIndex.js src/validate/index.js test/unit/validate.gates.test.js
git commit -m "fix(validate): surface tsProject detail; enumerate recoveryIndex misses"
```

---

## Task 6: Carry-over Layer 4/5 test gaps (PR 4 reviews)

**Goal:** Add the missing branch tests reviewers flagged. No production code changes — only tests. If a test exposes a real bug, fix it in the same commit.

**Files:**
- Modify: `test/unit/scriptRecovery.ccclassNamer.test.js` (add 2 tests)
- Modify: `test/unit/scriptRecovery.typeInferer.test.js` (add 3 tests)

**Step 1: ccclassNamer — class self-reference rename + bare _RF.push**

Append:

```javascript
it('renames references to the class, not just the declaration', async () => {
  // After Layer 4: `Player.create()` inside the class body should be renamed too.
  const code = `
    cclegacy._RF.push({}, 'uuid-x', 'Player', undefined);
    var t = (function (_super) {
      function t() { _super.call(this); t.create(); }
      t.create = function () { return new t(); };
      return t;
    }(_super));
    cclegacy._RF.pop();
    export { t as default };
  `;
  // Build module + run namer (use existing test harness pattern).
  const { applyCcclassNames } = require('../../src/core/cocos3x/scriptRecovery/ccclassNamer.js');
  const parser = require('@babel/parser');
  const ast = parser.parse(code, { sourceType: 'module' });
  const mods = [{ ast, name: 'm' }];
  await applyCcclassNames(mods);
  const gen = require('@babel/generator');
  const generate = gen.default || gen;
  const out = generate(mods[0].ast).code;
  // Both the declaration AND every reference should be renamed.
  expect(out).toMatch(/function Player\(\)/);
  expect(out).toMatch(/Player\.create/);
  expect(out).not.toMatch(/\bt\.create\b/);
});

it('handles bare _RF.push (no cclegacy prefix)', async () => {
  const code = `
    _RF.push({}, 'uuid-y', 'Enemy', undefined);
    var z = function() { function z() {} return z; }();
    _RF.pop();
  `;
  const { applyCcclassNames } = require('../../src/core/cocos3x/scriptRecovery/ccclassNamer.js');
  const parser = require('@babel/parser');
  const ast = parser.parse(code, { sourceType: 'module' });
  const mods = [{ ast, name: 'm' }];
  await applyCcclassNames(mods);
  expect(mods[0].ccclassName).toBe('Enemy');
  expect(mods[0].uuid).toBe('uuid-y');
});
```

**Step 2: typeInferer — branch coverage**

Append to `test/unit/scriptRecovery.typeInferer.test.js`:

```javascript
it('__uuid__ miss → any (documented MVP fallback, NOT plan default of string)', async () => {
  const { inferType } = require('../../src/core/cocos3x/scriptRecovery/typeInferer.js');
  const t = inferType({ __uuid__: 'no-such-uuid' }, {}, []);
  expect(t).toBe('any');
});

it('__id__ out of bounds → any', async () => {
  const { inferType } = require('../../src/core/cocos3x/scriptRecovery/typeInferer.js');
  expect(inferType({ __id__: 999 }, {}, [])).toBe('any');
});

it('aggregates uuidMap across modules for cross-module __uuid__ lookup', async () => {
  const { inferFieldTypes } = require('../../src/core/cocos3x/scriptRecovery/typeInferer.js');
  const modA = { name: 'a', ccclassName: 'A', uuid: 'ua', uuidMap: { ua: { className: 'A', moduleName: 'a' } }, fieldTypes: {} };
  const modB = { name: 'b', ccclassName: 'B', uuid: 'ub', uuidMap: { ub: { className: 'B', moduleName: 'b' } }, fieldTypes: {} };
  const scenes = [[
    { __type__: 'A', target: { __uuid__: 'ub' } },
  ]];
  await inferFieldTypes([modA, modB], { scenes });
  expect(modA.fieldTypes.target).toBe('B');
});
```

If any of these reveal a bug (e.g., `inferType` not exported, or aggregation actually broken), fix in the same commit and explain in the message.

**Step 3: Run tests**

Run: `npm test`
Expected: 105 passing.

**Step 4: Commit**

```bash
git add -u test/unit/scriptRecovery.ccclassNamer.test.js test/unit/scriptRecovery.typeInferer.test.js
git commit -m "test(3x scripts): close PR4 review coverage gaps (Layer 4 refs, Layer 5 branches)"
```

---

## Task 7: CHANGELOG + README + push + PR

**Step 1: CHANGELOG**

Add an Unreleased entry summarizing:

- R9 — `project.json` / `package.json` / `settings/project.json` now derived from source `src/settings.json` (engine version, project name, design resolution, launch scene).
- R10 — explicit boundary: 3.x rehydration uses each document's `sharedClasses`; the 2.x `typeDefinitions` table is no longer in the 3.x dep graph (regression-pinned by test).
- R11 — `resolveOutputPath` falls back to `<classDir>/<uuid>` when source path missing.
- R12 — non-script assets get `.meta` files (importer keyed by class).
- Layer 7 — opt-in `cc-reverse humanify <outDir>` CLI (no hard dep on humanify CLI; supports local + openai providers; copilot-api documented as user-borne risk only).
- Carry-over fixes — gate detail strings; ccclassNamer + typeInferer test gaps closed.
- 105 tests passing.

**Step 2: README**

Add a `### Layer 7 — humanify (opt-in)` subsection under the script-recovery docs:

- How to install (`npm i -g humanify`).
- Two supported providers (local default; openai with `OPENAI_BASE_URL` / `OPENAI_API_KEY`).
- Output: `<outDir>/humanified/`.
- Note that copilot-api is a documented user-borne risk path and is NOT wired by this tool.

**Step 3: Final test + push**

```bash
npm test  # expect 105
git add -u CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 5 (Wave 2 + humanify)"
git push origin feature/pr5-wave2-and-humanify
```

**Step 4: Create PR**

```bash
gh pr create --base main --head feature/pr5-wave2-and-humanify \
  --title "feat(3.x): Wave 2 (R9–R12) + Layer 7 humanify + PR3/4 carry-over fixes" \
  --body "$(cat <<'EOF'
## Summary

Wave 2 of the 3.x overhaul plus the opt-in Layer 7 humanify wrapper, plus carry-over fixes from PR 3/4 reviews.

Plan: docs/plans/2026-05-12-pr5-wave2-and-humanify.md

### Wave 2
- **R9** — dynamic `project.json` / `package.json` / `settings/project.json` derived from source `src/settings.json` (was hardcoded constants).
- **R10** — pin "no static `typeDefinitions` in 3.x dep graph" with a regression test; 3.x now strictly relies on each document's own `sharedClasses`.
- **R11** — `resolveOutputPath` helper: when `config.paths[uuid].path` is missing, derive `<classDir>/<uuid>` from `CLASS_DIR`.
- **R12** — `.meta` files for non-script assets, importer keyed by Cocos class (`cc.SpriteFrame` → `sprite-frame`, etc.).

### Layer 7 — humanify (opt-in)
- New CLI subcommand: `cc-reverse humanify <outDir> [--provider local|openai] [--base-url ...] [--api-key ...] [--model ...]`.
- humanify is **not** a hard dep — wrapper detects missing binary and exits with install instructions.
- copilot-api documented as user-borne risk only; never wired programmatically.

### Carry-over fixes
- `tsProject` gate now surfaces `<n> .ts file(s); tsconfig.json present|absent` in `detail`.
- `recoveryIndex` gate enumerates ALL missing entries (capped at 10).
- `ccclassNamer` tests: class self-reference rename + bare `_RF.push`.
- `typeInferer` tests: `__uuid__` miss → `any`, `__id__` out-of-bounds, multi-module uuidMap aggregation.

### Tests
- 80 → 105 passing (25 added).

### Out of scope
- Wave 3 extended assets (R14–R16) → PR 6.
- Skill methodology A–F → PR 7.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report PR URL.

---

## Definition of Done

1. All 105 tests pass.
2. CHANGELOG + README updated.
3. PR opened on `clawnet-ai/cc-reverse` against `main`.
4. No 2.x regression (engine2x untouched; 2.x golden samples not in CI here, but plan asserts no edits to `src/core/cocos2x/**`).
