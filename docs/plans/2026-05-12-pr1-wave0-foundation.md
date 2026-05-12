# PR 1 — Wave 0 Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the corrective baseline for the 3.x overhaul: harden JSC key extraction (R1), convert all sync IO to async (R3), introduce per-asset error isolation (R4), and stand up the vitest test infrastructure used by every later PR.

**Architecture:** Three small refactors plus the test scaffold. R1 expands key sources and adds byte-array decoding; R3 mechanically swaps `fs.*Sync` for `fs.promises`; R4 wraps each asset in a try/catch and accumulates errors into a per-bundle report. Quality gates (`cc-reverse validate`) and the golden-sample baseline framework live here so PR 2+ can use them.

**Tech Stack:** Node 14+, vitest 1.x, fs/promises, existing xxtea-node + pako.

---

## Task 0: Worktree, deps, baseline

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `test/unit/.gitkeep`
- Create: `test/integration/.gitkeep`
- Create: `test/e2e/.gitkeep`
- Create: `test/fixtures.config.js`

**Step 1: Create the worktree**

```bash
git worktree add .worktrees/pr1-wave0-foundation -b feature/pr1-wave0-foundation main
cd .worktrees/pr1-wave0-foundation
```

**Step 2: Add vitest as devDependency**

Edit `package.json` `devDependencies`:
```json
"vitest": "^1.6.0"
```
Replace `"test": "jest"` with `"test": "vitest run"` and add:
```json
"test:watch": "vitest",
"e2e": "vitest run --dir test/e2e",
"validate": "node bin/validate.js"
```
Remove `jest` from devDependencies.

Run: `npm install`
Expected: `vitest` appears under `node_modules/`, `jest` removed.

**Step 3: Create vitest config**

`vitest.config.js`:
```js
const { defineConfig } = require('vitest/config');
module.exports = defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 60_000,
    pool: 'forks',
  },
});
```

**Step 4: Create the fixtures registry**

`test/fixtures.config.js`:
```js
const path = require('path');
const home = require('os').homedir();
module.exports = {
  zqndtz:      { engine: '3.x', path: path.join(home, 'mini/zqndtz'),               role: 'gold' },
  dabaoyiqie:  { engine: '2.4.x', path: path.join(home, 'mini/dabaoyiqie-reverse'), role: 'regression-only' },
  cgxfd:       { engine: '2.4.x', path: path.join(home, 'mini/cgxfd-reverse'),      role: 'regression-only' },
};
```

**Step 5: Sanity test**

Create `test/unit/sanity.test.js`:
```js
const { describe, it, expect } = require('vitest');
describe('sanity', () => { it('runs', () => { expect(1).toBe(1); }); });
```

Run: `npm test`
Expected: `1 passed`.

**Step 6: Commit**

```bash
git add package.json vitest.config.js test/
git commit -m "chore(test): replace jest with vitest, scaffold test tree

- Adds vitest config, test/{unit,integration,e2e} layout
- Registers golden samples in test/fixtures.config.js
- Removes jest from devDependencies"
```

---

## Task 1: R1 — JSC key extraction hardening (failing tests first)

**Files:**
- Modify: `src/core/jscDecryptor.js`
- Create: `test/unit/jscDecryptor.test.js`
- Create: `test/integration/jsc-keys.test.js`
- Create: `test/fixtures/jsc-keys/` (small synthetic snippets)

### Subtask 1.1: Tests for expanded source list

**Step 1: Write failing test**

`test/unit/jscDecryptor.test.js`:
```js
const { describe, it, expect } = require('vitest');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extractKeyFromProject } = require('../../src/core/jscDecryptor');

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

describe('extractKeyFromProject — source coverage', () => {
  it('finds key in application.js (3.x web build)', async () => {
    const dir = makeFixture({ 'application.js': 'var xxteaKey = "abc-def-1234";' });
    expect(await extractKeyFromProject(dir)).toBe('abc-def-1234');
  });

  it('finds key inside cocos-js bundle file', async () => {
    const dir = makeFixture({
      'cocos-js/cc.abc.js': 'window.XXTEA_KEY = "deadbeef-cafe-babe";'
    });
    expect(await extractKeyFromProject(dir)).toBe('deadbeef-cafe-babe');
  });

  it('finds key referenced in 3.x src/settings.json', async () => {
    const dir = makeFixture({
      'src/settings.json': JSON.stringify({ assets: { encrypted: true }, encryptKey: 'fromsettings-1234' })
    });
    expect(await extractKeyFromProject(dir)).toBe('fromsettings-1234');
  });

  it('decodes byte-array key form', async () => {
    const dir = makeFixture({
      'main.js': 'var xxteaKey = [0x61,0x62,0x63,0x64];'   // "abcd"
    });
    expect(await extractKeyFromProject(dir)).toBe('abcd');
  });

  it('returns null when no key present', async () => {
    const dir = makeFixture({ 'main.js': '// nothing' });
    expect(await extractKeyFromProject(dir)).toBeNull();
  });
});
```

**Step 2: Run, expect failures**

Run: `npm test -- jscDecryptor`
Expected: 3 of 5 fail (`application.js`, `cocos-js`, `byte-array`, `settings.json`); 1-2 may pass since current impl finds some of these.

### Subtask 1.2: Implement async + expanded extraction

**Step 3: Rewrite `extractKeyFromProject` async with expanded sources**

In `src/core/jscDecryptor.js` replace the function with:
```js
const fsp = require('fs/promises');

async function extractKeyFromProject(sourcePath) {
  const stringSources = [
    'main.js',
    'src/main.js',
    'application.js',
  ];
  const dirSources = ['cocos-js'];                   // scan all .js inside
  const jsonSources = ['src/settings.json', 'settings.json'];

  const candidates = [];

  for (const rel of stringSources) {
    const p = path.join(sourcePath, rel);
    try { candidates.push({ p, body: await fsp.readFile(p, 'utf-8') }); } catch {}
  }
  for (const dir of dirSources) {
    const root = path.join(sourcePath, dir);
    try {
      const entries = await fsp.readdir(root);
      for (const f of entries) {
        if (!f.endsWith('.js')) continue;
        const p = path.join(root, f);
        candidates.push({ p, body: await fsp.readFile(p, 'utf-8') });
      }
    } catch {}
  }
  for (const rel of jsonSources) {
    const p = path.join(sourcePath, rel);
    try { candidates.push({ p, body: await fsp.readFile(p, 'utf-8'), isJson: true }); } catch {}
  }

  const stringPatterns = [
    /xxteaKey\s*[:=]\s*['"]([^'"]+)['"]/i,
    /encryptKey\s*[:=]\s*['"]([^'"]+)['"]/i,
    /XXTEA_KEY\s*[:=]\s*['"]([^'"]+)['"]/,
    /key\s*:\s*['"]([0-9a-f-]{16,})['"]/i,
  ];
  const bytePattern = /(?:xxteaKey|encryptKey|XXTEA_KEY)\s*[:=]\s*\[([0-9xXa-fA-F,\s]+)\]/;

  for (const { body } of candidates) {
    for (const re of stringPatterns) {
      const m = body.match(re);
      if (m) return m[1];
    }
    const bm = body.match(bytePattern);
    if (bm) {
      const bytes = bm[1].split(',').map(s => parseInt(s.trim(), 16) || parseInt(s.trim(), 10));
      return Buffer.from(bytes).toString('utf-8');
    }
  }
  return null;
}
```

**Step 4: Run tests, expect pass**

Run: `npm test -- jscDecryptor`
Expected: 5 passed.

### Subtask 1.3: Friendly failure when key is needed but missing

**Step 5: Add a probe API**

Add to `jscDecryptor.js`:
```js
async function describeEncryptionState(sourcePath) {
  const jscs = await scanJscFilesAsync(sourcePath);
  if (jscs.length === 0) return { encrypted: false };
  const keyFound = await extractKeyFromProject(sourcePath);
  return { encrypted: true, jscCount: jscs.length, keyFound, keySources: keyFound ? ['auto'] : [] };
}
module.exports = { ...module.exports, describeEncryptionState };
```

Test in `test/unit/jscDecryptor.test.js`:
```js
describe('describeEncryptionState', () => {
  it('reports unencrypted when no jsc', async () => {
    const dir = makeFixture({ 'main.js': '' });
    expect((await describeEncryptionState(dir)).encrypted).toBe(false);
  });
});
```

**Step 6: Commit**

```bash
git add src/core/jscDecryptor.js test/unit/jscDecryptor.test.js
git commit -m "feat(jsc): expand key extraction sources and async-ify (R1)

- Adds application.js, cocos-js/, src/settings.json to scanned sources
- Decodes byte-array key form (xxteaKey = [0x.., ...])
- Introduces describeEncryptionState() for diagnostic flow
- Converts to fs/promises throughout"
```

---

## Task 2: R3 — Sync IO → Async sweep (jscDecryptor + engine3x)

**Files:**
- Modify: `src/core/jscDecryptor.js`
- Modify: `src/core/cocos3x/engine3x.js`
- Create: `test/unit/asyncIo.guard.test.js`

**Step 1: Write a static guard test**

`test/unit/asyncIo.guard.test.js`:
```js
const { describe, it, expect } = require('vitest');
const fs = require('fs');
const path = require('path');

const FORBIDDEN = /\bfs\.(readFileSync|writeFileSync|statSync|readdirSync|mkdirSync|copyFileSync|existsSync|rmSync|unlinkSync)\b/;

const FILES = [
  'src/core/jscDecryptor.js',
  'src/core/cocos3x/engine3x.js',
];

describe('async io guard', () => {
  for (const rel of FILES) {
    it(`${rel} contains no fs.*Sync`, () => {
      const body = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf-8');
      const m = body.match(FORBIDDEN);
      expect(m, `Found ${m?.[0]} in ${rel}`).toBeNull();
    });
  }
});
```

(The test itself uses sync fs intentionally — guards run in test code.)

**Step 2: Run, expect failures**

Run: `npm test -- asyncIo`
Expected: 2 failed (both files).

**Step 3: Convert jscDecryptor.js**

Rewrite `scanJscFiles` as `scanJscFilesAsync`, the `decryptProject` body to use `fs/promises`. Provide both names to keep old callers working but mark sync as deprecated:
```js
async function scanJscFilesAsync(dirPath) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (path.extname(full) === '.jsc') out.push(full);
    }
  }
  await walk(dirPath);
  return out;
}
```

In `decryptProject`, replace the loop body:
```js
const data = await fsp.readFile(jscFile);
await fsp.mkdir(path.dirname(outputFile), { recursive: true });
const result = decryptJscBuffer(data, key);
if (result) { await fsp.writeFile(outputFile, result); decrypted++; }
```

Also wrap each file in try/catch (pre-empts R4):
```js
try { /* …decode + write… */ }
catch (e) { logger.warn(`解密失败 ${relativePath}: ${e.message}`); failed++; }
```

**Step 4: Convert engine3x.js**

Mechanical replacements (preserve behaviour):

| Old | New |
|---|---|
| `fs.readFileSync(p, enc)` | `await fsp.readFile(p, enc)` |
| `fs.writeFileSync(p, data)` | `await fsp.writeFile(p, data)` |
| `fs.readdirSync(p)` | `await fsp.readdir(p)` |
| `fs.mkdirSync(p, opts)` | `await fsp.mkdir(p, opts)` |
| `fs.copyFileSync(s, d)` | `await fsp.copyFile(s, d)` |
| `fs.existsSync(p)` | `await pathExists(p)` (helper using `fsp.access`) |

Add helper at top of `engine3x.js`:
```js
const fsp = require('fs/promises');
async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
```

Walk through `engine3x.js` line by line; every async function already exists so no signature changes. Audit at the end with grep.

Run: `grep -n 'fs\.\(read\|write\|stat\|readdir\|mkdir\|copyFile\|exists\|rm\|unlink\)Sync' src/core/cocos3x/engine3x.js src/core/jscDecryptor.js`
Expected: empty.

**Step 5: Run guard test**

Run: `npm test -- asyncIo`
Expected: 2 passed.

**Step 6: Run full suite (regression check)**

Run: `npm test`
Expected: all green. If integration with zqndtz has been wired by now, also `npm run e2e -- zqndtz`.

**Step 7: Commit**

```bash
git add src/core/jscDecryptor.js src/core/cocos3x/engine3x.js test/unit/asyncIo.guard.test.js
git commit -m "refactor(3x): replace sync fs calls with fs/promises (R3)

- Adds asyncIo guard test enforcing no fs.*Sync in 3x hot path
- Introduces pathExists() helper to replace fs.existsSync"
```

---

## Task 3: R4 — Per-asset error isolation

**Files:**
- Modify: `src/core/cocos3x/engine3x.js` (around `unpackBundle` / `unpackAsset`)
- Create: `src/core/cocos3x/recoveryReport.js`
- Create: `test/unit/recoveryReport.test.js`

### Subtask 3.1: RecoveryReport collector

**Step 1: Write tests**

`test/unit/recoveryReport.test.js`:
```js
const { describe, it, expect } = require('vitest');
const { RecoveryReport } = require('../../src/core/cocos3x/recoveryReport');

describe('RecoveryReport', () => {
  it('records ok and failure counts per bundle', () => {
    const r = new RecoveryReport();
    r.ok('main', 'fc991dd7', 'cc.SpriteFrame');
    r.fail('main', 'aabb', 'cc.Mesh', new Error('CCON v2 not supported'));
    const s = r.summary();
    expect(s.bundles.main).toEqual({ ok: 1, failed: 1, byClass: { 'cc.SpriteFrame': 1, 'cc.Mesh': 0 } });
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].reason).toMatch(/CCON v2/);
  });

  it('serialises to a markdown report', () => {
    const r = new RecoveryReport();
    r.ok('main', 'a', 'cc.Prefab');
    r.fail('main', 'b', 'cc.Mesh', new Error('boom'));
    const md = r.toMarkdown();
    expect(md).toMatch(/# Recovery Report/);
    expect(md).toMatch(/main.*ok=1/);
    expect(md).toMatch(/cc\.Mesh.*boom/);
  });
});
```

**Step 2: Run, expect failure**

Run: `npm test -- recoveryReport`
Expected: import fails.

**Step 3: Implement**

`src/core/cocos3x/recoveryReport.js`:
```js
class RecoveryReport {
  constructor() {
    this.bundles = {};
    this.failures = [];
  }
  _ensure(b) { return (this.bundles[b] ??= { ok: 0, failed: 0, byClass: {} }); }
  ok(bundle, uuid, klass) {
    const b = this._ensure(bundle);
    b.ok++;
    b.byClass[klass] = (b.byClass[klass] ?? 0) + 1;
  }
  fail(bundle, uuid, klass, error) {
    const b = this._ensure(bundle);
    b.failed++;
    b.byClass[klass] ??= 0;
    this.failures.push({ bundle, uuid, klass, reason: error?.message ?? String(error) });
  }
  summary() { return { bundles: this.bundles, failures: this.failures }; }
  toMarkdown() {
    const lines = ['# Recovery Report', ''];
    lines.push('## Per-bundle counts');
    for (const [name, b] of Object.entries(this.bundles)) {
      lines.push(`- **${name}**: ok=${b.ok}, failed=${b.failed}`);
      for (const [k, v] of Object.entries(b.byClass).sort()) lines.push(`  - ${k}: ${v}`);
    }
    if (this.failures.length) {
      lines.push('', '## Failures');
      for (const f of this.failures) lines.push(`- [${f.bundle}] ${f.klass} ${f.uuid}: ${f.reason}`);
    }
    return lines.join('\n');
  }
}
module.exports = { RecoveryReport };
```

**Step 4: Run tests**

Run: `npm test -- recoveryReport`
Expected: 2 passed.

### Subtask 3.2: Wire RecoveryReport into engine3x

**Step 5: Modify engine3x.js**

In the bundle-unpack loop (around `unpackBundle`), instantiate one `RecoveryReport` per `reverseProject3x()` call. Wrap each `unpackAsset` call site:
```js
try {
  await unpackAsset(...);
  report.ok(bundleName, uuid, classGuess);
} catch (e) {
  report.fail(bundleName, uuid, classGuess ?? 'unknown', e);
  logger.warn(`资源失败 [${bundleName}] ${uuid}: ${e.message}`);
}
```

At end of `reverseProject3x()`:
```js
await fsp.writeFile(path.join(outDir, 'RECOVERY_REPORT.md'), report.toMarkdown());
```

**Step 6: Add integration test against zqndtz**

`test/integration/recovery-report.test.js`:
```js
const { describe, it, expect } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fixtures = require('../fixtures.config');

const sample = fixtures.zqndtz;

describe.skipIf(!fs.existsSync(sample.path))('integration: RecoveryReport on zqndtz', () => {
  it('writes RECOVERY_REPORT.md after unpack', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zqndtz-out-'));
    const { reverseProject3x } = require('../../src/core/cocos3x/engine3x');
    await reverseProject3x({ buildRoot: sample.path, output: out, scriptsOnly: false, assetsOnly: true });
    expect(fs.existsSync(path.join(out, 'RECOVERY_REPORT.md'))).toBe(true);
  }, 120_000);
});
```

(Test skips when sample missing → CI-safe.)

Run: `npm test -- recovery-report`
Expected: 1 passed (or skipped if sample absent).

**Step 7: Commit**

```bash
git add src/core/cocos3x/{engine3x.js,recoveryReport.js} test/{unit,integration}/recovery*
git commit -m "feat(3x): per-asset try/catch + RecoveryReport.md (R4)

- One asset failure no longer aborts the bundle
- Writes RECOVERY_REPORT.md to output root
- Adds integration test against zqndtz golden sample"
```

---

## Task 4: Quality gates CLI scaffold (used by all later PRs)

**Files:**
- Create: `bin/validate.js`
- Create: `src/validate/index.js`
- Create: `src/validate/gates/recoveryReport.js`
- Create: `test/unit/validate.recoveryReport.test.js`

**Step 1: Write tests for the gate runner**

`test/unit/validate.recoveryReport.test.js`:
```js
const { describe, it, expect } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGates } = require('../../src/validate');

describe('validate gate: recoveryReport.count-matches-fs', () => {
  it('passes when report counts match assets/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
    fs.mkdirSync(path.join(dir, 'assets/main/scene'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/main/scene/a.scene.json'), '{}');
    fs.writeFileSync(path.join(dir, 'RECOVERY_REPORT.md'),
      '# Recovery Report\n## Per-bundle counts\n- **main**: ok=1, failed=0\n');
    const r = runGates(dir, { gates: ['recoveryReport'] });
    expect(r.failed).toEqual([]);
  });
});
```

**Step 2: Implement minimal gate runner**

`src/validate/index.js`:
```js
const path = require('path');
const recoveryReport = require('./gates/recoveryReport');
const ALL = { recoveryReport };
function runGates(outputDir, { gates = Object.keys(ALL) } = {}) {
  const results = { passed: [], failed: [] };
  for (const name of gates) {
    const g = ALL[name];
    if (!g) continue;
    try {
      const ok = g(outputDir);
      (ok === true ? results.passed : results.failed).push({ name, detail: ok });
    } catch (e) { results.failed.push({ name, detail: e.message }); }
  }
  return results;
}
module.exports = { runGates };
```

`src/validate/gates/recoveryReport.js`:
```js
const fs = require('fs');
const path = require('path');
module.exports = function(outDir) {
  const report = path.join(outDir, 'RECOVERY_REPORT.md');
  if (!fs.existsSync(report)) return 'RECOVERY_REPORT.md missing';
  const md = fs.readFileSync(report, 'utf-8');
  const totals = [...md.matchAll(/- \*\*(.+?)\*\*: ok=(\d+), failed=(\d+)/g)];
  const declared = totals.reduce((s, m) => s + parseInt(m[2], 10), 0);
  const actual = countAssets(path.join(outDir, 'assets'));
  if (declared !== actual) return `declared ${declared} vs actual ${actual}`;
  return true;
};
function countAssets(root) {
  let n = 0;
  if (!fs.existsSync(root)) return 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) n += countAssets(f);
    else if (!e.name.endsWith('.meta')) n++;
  }
  return n;
}
```

`bin/validate.js`:
```js
#!/usr/bin/env node
const { runGates } = require('../src/validate');
const dir = process.argv[2];
if (!dir) { console.error('usage: validate <output-dir>'); process.exit(2); }
const r = runGates(dir);
console.log(JSON.stringify(r, null, 2));
process.exit(r.failed.length ? 1 : 0);
```
`chmod +x bin/validate.js`.

**Step 3: Tests pass**

Run: `npm test -- validate`
Expected: 1 passed.

**Step 4: Commit**

```bash
git add bin/validate.js src/validate/ test/unit/validate*
git commit -m "feat(validate): gate runner skeleton with RECOVERY_REPORT count gate

PR 2-6 will plug additional gates into src/validate/gates/."
```

---

## Task 5: PR-close — CHANGELOG, README, verification, push

**Files:**
- Modify: `CHANGELOG.md` (create if missing)
- Modify: `README.md`

**Step 1: CHANGELOG entry**

```md
## [Unreleased]
### Added (PR 1, Wave 0)
- R1: JSC key extraction now scans `application.js`, `cocos-js/*.js`, `src/settings.json`; supports byte-array key form.
- R3: All 3.x sync IO replaced with `fs/promises` and guarded by a unit test.
- R4: Per-asset error isolation; emits `RECOVERY_REPORT.md` to output root.
- vitest test scaffold + `npm run validate` gate runner.
```

**Step 2: README — note RECOVERY_REPORT and validate command**

Append a "Validation" subsection under the existing "3.x reverse" docs explaining `npm run validate <dir>`.

**Step 3: Run full local verification**

```bash
npm test
npm run e2e -- zqndtz   # if sample present
npm run validate <some-recent-output-dir>
```

All must pass / report cleanly.

**Step 4: Push branch**

```bash
git push -u origin feature/pr1-wave0-foundation
```

**Step 5: Open PR**

Title: `PR 1: Wave 0 — JSC key + async IO + error isolation + test scaffold`

Body: link the design doc section §2.2 Wave 0, list the four shipped items (R1, R3, R4, gate runner), and note that PR 2 starts in `.worktrees/pr2-wave1-3x-deserialize/` next.

**Step 6: Merge & cleanup**

After merge:
```bash
cd /Users/lcf/code/cc-reverse
git fetch origin
git checkout main
git pull
git worktree remove .worktrees/pr1-wave0-foundation
```

---

## Out of scope (kept honest)

- 2.x JSC key extraction enhancements — covered by next round (NEXT-ROUND-2x-backlog.md).
- R2 settings.js eval safety — 2.x specific, deferred.
- New CCON / IPackedFileData work — that's PR 2.
- Script recovery — that's PR 3+.
