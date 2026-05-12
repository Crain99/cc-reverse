# PR 1 — Wave 0 基础实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标:** 为 3.x 大整改构建纠正性基线：加固 JSC key 提取（R1），将所有同步 IO 转为异步（R3），引入逐资源错误隔离（R4），并搭建后续每个 PR 都使用的 vitest 测试基础设施。

**架构:** 三个小重构加测试脚手架。R1 扩展 key 来源并增加字节数组解码；R3 机械地将 `fs.*Sync` 替换为 `fs.promises`；R4 将每个资源包裹在 try/catch 中，并将错误聚合为按 bundle 的报告。质量门（`cc-reverse validate`）和 golden-sample 基线框架放在这里，使 PR 2+ 可以使用。

**技术栈:** Node 14+、vitest 1.x、fs/promises、现有 xxtea-node + pako。

---

## Task 0: Worktree、依赖、基线

**文件:**
- 修改: `package.json`
- 创建: `vitest.config.js`
- 创建: `test/unit/.gitkeep`
- 创建: `test/integration/.gitkeep`
- 创建: `test/e2e/.gitkeep`
- 创建: `test/fixtures.config.js`

**Step 1: 创建 worktree**

```bash
git worktree add .worktrees/pr1-wave0-foundation -b feature/pr1-wave0-foundation main
cd .worktrees/pr1-wave0-foundation
```

**Step 2: 把 vitest 加入 devDependency**

编辑 `package.json` `devDependencies`：
```json
"vitest": "^1.6.0"
```
将 `"test": "jest"` 替换为 `"test": "vitest run"` 并添加：
```json
"test:watch": "vitest",
"e2e": "vitest run --dir test/e2e",
"validate": "node bin/validate.js"
```
从 devDependencies 中移除 `jest`。

执行：`npm install`
预期：`vitest` 出现在 `node_modules/` 下，`jest` 已移除。

**Step 3: 创建 vitest 配置**

`vitest.config.js`：
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

**Step 4: 创建 fixtures registry**

`test/fixtures.config.js`：
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

创建 `test/unit/sanity.test.js`：
```js
const { describe, it, expect } = require('vitest');
describe('sanity', () => { it('runs', () => { expect(1).toBe(1); }); });
```

执行：`npm test`
预期：`1 passed`。

**Step 6: 提交**

```bash
git add package.json vitest.config.js test/
git commit -m "chore(test): replace jest with vitest, scaffold test tree

- Adds vitest config, test/{unit,integration,e2e} layout
- Registers golden samples in test/fixtures.config.js
- Removes jest from devDependencies"
```

---

## Task 1: R1 — JSC key 提取加固（先写失败测试）

**文件:**
- 修改: `src/core/jscDecryptor.js`
- 创建: `test/unit/jscDecryptor.test.js`
- 创建: `test/integration/jsc-keys.test.js`
- 创建: `test/fixtures/jsc-keys/`（小型合成片段）

### Subtask 1.1: 扩展来源列表的测试

**Step 1: 编写失败测试**

`test/unit/jscDecryptor.test.js`：
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

**Step 2: 运行，预期失败**

执行：`npm test -- jscDecryptor`
预期：5 个中 3 个失败（`application.js`、`cocos-js`、`byte-array`、`settings.json`）；可能有 1-2 个通过，因为现有实现已能找到其中部分。

### Subtask 1.2: 实现异步 + 扩展提取

**Step 3: 重写 `extractKeyFromProject` 为异步并扩展来源**

在 `src/core/jscDecryptor.js` 中将该函数替换为：
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

**Step 4: 运行测试，预期通过**

执行：`npm test -- jscDecryptor`
预期：5 passed。

### Subtask 1.3: key 缺失时给出友好失败信息

**Step 5: 添加探针 API**

在 `jscDecryptor.js` 中添加：
```js
async function describeEncryptionState(sourcePath) {
  const jscs = await scanJscFilesAsync(sourcePath);
  if (jscs.length === 0) return { encrypted: false };
  const keyFound = await extractKeyFromProject(sourcePath);
  return { encrypted: true, jscCount: jscs.length, keyFound, keySources: keyFound ? ['auto'] : [] };
}
module.exports = { ...module.exports, describeEncryptionState };
```

`test/unit/jscDecryptor.test.js` 中的测试：
```js
describe('describeEncryptionState', () => {
  it('reports unencrypted when no jsc', async () => {
    const dir = makeFixture({ 'main.js': '' });
    expect((await describeEncryptionState(dir)).encrypted).toBe(false);
  });
});
```

**Step 6: 提交**

```bash
git add src/core/jscDecryptor.js test/unit/jscDecryptor.test.js
git commit -m "feat(jsc): expand key extraction sources and async-ify (R1)

- Adds application.js, cocos-js/, src/settings.json to scanned sources
- Decodes byte-array key form (xxteaKey = [0x.., ...])
- Introduces describeEncryptionState() for diagnostic flow
- Converts to fs/promises throughout"
```

---

## Task 2: R3 — 同步 IO → 异步扫荡（jscDecryptor + engine3x）

**文件:**
- 修改: `src/core/jscDecryptor.js`
- 修改: `src/core/cocos3x/engine3x.js`
- 创建: `test/unit/asyncIo.guard.test.js`

**Step 1: 编写静态守卫测试**

`test/unit/asyncIo.guard.test.js`：
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

（测试本身故意使用同步 fs — 守卫只在测试代码中运行。）

**Step 2: 运行，预期失败**

执行：`npm test -- asyncIo`
预期：2 failed（两个文件都失败）。

**Step 3: 转换 jscDecryptor.js**

将 `scanJscFiles` 重写为 `scanJscFilesAsync`，把 `decryptProject` 主体改为使用 `fs/promises`。同时提供两个名字以兼容旧调用方，但将同步版本标记为 deprecated：
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

在 `decryptProject` 中替换循环体：
```js
const data = await fsp.readFile(jscFile);
await fsp.mkdir(path.dirname(outputFile), { recursive: true });
const result = decryptJscBuffer(data, key);
if (result) { await fsp.writeFile(outputFile, result); decrypted++; }
```

并将每个文件包裹在 try/catch 中（提前体现 R4）：
```js
try { /* …decode + write… */ }
catch (e) { logger.warn(`解密失败 ${relativePath}: ${e.message}`); failed++; }
```

**Step 4: 转换 engine3x.js**

机械替换（保留行为）：

| 旧 | 新 |
|---|---|
| `fs.readFileSync(p, enc)` | `await fsp.readFile(p, enc)` |
| `fs.writeFileSync(p, data)` | `await fsp.writeFile(p, data)` |
| `fs.readdirSync(p)` | `await fsp.readdir(p)` |
| `fs.mkdirSync(p, opts)` | `await fsp.mkdir(p, opts)` |
| `fs.copyFileSync(s, d)` | `await fsp.copyFile(s, d)` |
| `fs.existsSync(p)` | `await pathExists(p)`（使用 `fsp.access` 的辅助函数） |

在 `engine3x.js` 顶部添加辅助：
```js
const fsp = require('fs/promises');
async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
```

逐行走读 `engine3x.js`；所有异步函数已存在，因此签名无需变更。最后用 grep 审计。

执行：`grep -n 'fs\.\(read\|write\|stat\|readdir\|mkdir\|copyFile\|exists\|rm\|unlink\)Sync' src/core/cocos3x/engine3x.js src/core/jscDecryptor.js`
预期：空。

**Step 5: 运行守卫测试**

执行：`npm test -- asyncIo`
预期：2 passed。

**Step 6: 运行完整测试套（回归检查）**

执行：`npm test`
预期：全绿。如果 zqndtz 集成已接好，再运行 `npm run e2e -- zqndtz`。

**Step 7: 提交**

```bash
git add src/core/jscDecryptor.js src/core/cocos3x/engine3x.js test/unit/asyncIo.guard.test.js
git commit -m "refactor(3x): replace sync fs calls with fs/promises (R3)

- Adds asyncIo guard test enforcing no fs.*Sync in 3x hot path
- Introduces pathExists() helper to replace fs.existsSync"
```

---

## Task 3: R4 — 逐资源错误隔离

**文件:**
- 修改: `src/core/cocos3x/engine3x.js`（`unpackBundle` / `unpackAsset` 周围）
- 创建: `src/core/cocos3x/recoveryReport.js`
- 创建: `test/unit/recoveryReport.test.js`

### Subtask 3.1: RecoveryReport 收集器

**Step 1: 编写测试**

`test/unit/recoveryReport.test.js`：
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

**Step 2: 运行，预期失败**

执行：`npm test -- recoveryReport`
预期：import 失败。

**Step 3: 实现**

`src/core/cocos3x/recoveryReport.js`：
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

**Step 4: 运行测试**

执行：`npm test -- recoveryReport`
预期：2 passed。

### Subtask 3.2: 把 RecoveryReport 接入 engine3x

**Step 5: 修改 engine3x.js**

在 bundle 解包循环（`unpackBundle` 周围），每次 `reverseProject3x()` 调用时实例化一个 `RecoveryReport`。包裹每个 `unpackAsset` 调用点：
```js
try {
  await unpackAsset(...);
  report.ok(bundleName, uuid, classGuess);
} catch (e) {
  report.fail(bundleName, uuid, classGuess ?? 'unknown', e);
  logger.warn(`资源失败 [${bundleName}] ${uuid}: ${e.message}`);
}
```

在 `reverseProject3x()` 末尾：
```js
await fsp.writeFile(path.join(outDir, 'RECOVERY_REPORT.md'), report.toMarkdown());
```

**Step 6: 添加针对 zqndtz 的集成测试**

`test/integration/recovery-report.test.js`：
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

（样本缺失时测试跳过 → CI 安全。）

执行：`npm test -- recovery-report`
预期：1 passed（样本不存在时跳过）。

**Step 7: 提交**

```bash
git add src/core/cocos3x/{engine3x.js,recoveryReport.js} test/{unit,integration}/recovery*
git commit -m "feat(3x): per-asset try/catch + RecoveryReport.md (R4)

- One asset failure no longer aborts the bundle
- Writes RECOVERY_REPORT.md to output root
- Adds integration test against zqndtz golden sample"
```

---

## Task 4: 质量门 CLI 脚手架（被所有后续 PR 使用）

**文件:**
- 创建: `bin/validate.js`
- 创建: `src/validate/index.js`
- 创建: `src/validate/gates/recoveryReport.js`
- 创建: `test/unit/validate.recoveryReport.test.js`

**Step 1: 为 gate 运行器编写测试**

`test/unit/validate.recoveryReport.test.js`：
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

**Step 2: 实现最小 gate 运行器**

`src/validate/index.js`：
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

`src/validate/gates/recoveryReport.js`：
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

`bin/validate.js`：
```js
#!/usr/bin/env node
const { runGates } = require('../src/validate');
const dir = process.argv[2];
if (!dir) { console.error('usage: validate <output-dir>'); process.exit(2); }
const r = runGates(dir);
console.log(JSON.stringify(r, null, 2));
process.exit(r.failed.length ? 1 : 0);
```
`chmod +x bin/validate.js`。

**Step 3: 测试通过**

执行：`npm test -- validate`
预期：1 passed。

**Step 4: 提交**

```bash
git add bin/validate.js src/validate/ test/unit/validate*
git commit -m "feat(validate): gate runner skeleton with RECOVERY_REPORT count gate

PR 2-6 will plug additional gates into src/validate/gates/."
```

---

## Task 5: PR 收尾 — CHANGELOG、README、验证、推送

**文件:**
- 修改: `CHANGELOG.md`（不存在则创建）
- 修改: `README.md`

**Step 1: CHANGELOG 条目**

```md
## [Unreleased]
### Added (PR 1, Wave 0)
- R1: JSC key extraction now scans `application.js`, `cocos-js/*.js`, `src/settings.json`; supports byte-array key form.
- R3: All 3.x sync IO replaced with `fs/promises` and guarded by a unit test.
- R4: Per-asset error isolation; emits `RECOVERY_REPORT.md` to output root.
- vitest test scaffold + `npm run validate` gate runner.
```

**Step 2: README — 说明 RECOVERY_REPORT 与 validate 命令**

在现有 "3.x reverse" 文档下追加 "Validation" 子章节，解释 `npm run validate <dir>`。

**Step 3: 完整本地验证**

```bash
npm test
npm run e2e -- zqndtz   # if sample present
npm run validate <some-recent-output-dir>
```

全部必须通过 / 报告干净。

**Step 4: 推送分支**

```bash
git push -u origin feature/pr1-wave0-foundation
```

**Step 5: 开 PR**

标题：`PR 1: Wave 0 — JSC key + async IO + error isolation + test scaffold`

正文：链接设计文档 §2.2 Wave 0，列出已交付的四项（R1、R3、R4、gate runner），并注明 PR 2 接下来在 `.worktrees/pr2-wave1-3x-deserialize/` 启动。

**Step 6: 合并与清理**

合并后：
```bash
cd /Users/lcf/code/cc-reverse
git fetch origin
git checkout main
git pull
git worktree remove .worktrees/pr1-wave0-foundation
```

---

## 范围外（如实交代）

- 2.x JSC key 提取增强 — 由下一轮覆盖（NEXT-ROUND-2x-backlog.md）。
- R2 settings.js eval 安全 — 2.x 特有，已推迟。
- 新的 CCON / IPackedFileData 工作 — 那是 PR 2。
- 脚本恢复 — 那是 PR 3+。
