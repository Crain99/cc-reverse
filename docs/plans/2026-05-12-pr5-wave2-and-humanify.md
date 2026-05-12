# PR 5 — Wave 2(R9–R12)+ humanify opt-in CLI 子命令 + 遗留修复

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 把 3.x 的输出提升到"诚实的工程元数据"水准(从源 `settings.json` 动态生成 `project.json`、更智能的 class→dir 映射、更完整的 `.meta` 文件、3.x 弃用硬编码类型表);新增**可选的 `cc-reverse humanify <outDir>` CLI 子命令**(opt-in 带外步骤,**不**属于 6 层 in-memory 脚本恢复管线,需要用户显式调用);偿还 PR 3/4 评审中遗留的测试/UX 缺口。

> 注：脚本恢复管线由 6 个 in-memory AST layer 组成(只有 Layer 6 落盘),humanify 是 reverse 主流程之外的独立 CLI 子命令。参考 cocos-reverse-engineering-skill `references/output-layers.md` 已正确描述。

**架构:** 所有 Wave 2 改动落在 `src/core/cocos3x/projectScaffold.js` + `engine3x.js`。新增 `src/core/cocos3x/scriptRecovery/humanify.js`(humanify CLI 包装器,opt-in,在 `humanify` CLI 可用时 shell out,不作为硬依赖,**不**自动接入 reverse 主管线)。遗留修复是对现有文件的小手术。2.x 代码路径完全不动。

**技术栈:** Node ESM;现有的 babel/ts-morph/prettier;`child_process.spawn` 用于 humanify;vitest。

---

## 遗留修复(来自 PR 3/4 评审)

| 来源 | 项目 | 落位 |
|---|---|---|
| PR 4 Task 2 评审 | typeInferer 分支测试:`__uuid__` 未命中 → `any`、`__id__` 越界、内联 `__type__: cc.X`、null/undefined、多模块 uuidMap 聚合 | Task 6 |
| PR 4 Task 3 评审 | tsProject gate 丢弃了 count 与 tsconfig 信息 | Task 5 |
| PR 4 Task 5 评审 | recoveryIndex gate 失败信息只截到第一个 missing | Task 5 |
| PR 4 Task 1 评审 | ccclassNamer:缺少类自引用改名、裸 `_RF.push`、`@ccclass` 无参 测试 | Task 6 |

---

## PR 5 之前的状态

- 分支:`feature/pr5-wave2-and-humanify`,基于 main `9c88745`
- 测试基线:**80 通过**(21 个文件)
- 3.x `project.json`:硬编码 `name: 'recovered-cocos3-project'`,`version: '3.0.0'`
- 3.x 资源仅脚本得到 `.meta`;其他资源裸落地
- 3.x 资源放置:`CLASS_DIR` 给出子目录,但路径仍保留源 `config.paths[uuid].path` 全量 — 时有错位
- 没有 humanify 包装

## 测试演进

`80 → 82 (T0) → 86 (T1 R9) → 89 (T2 R10) → 92 (T3 R11+R12) → 96 (T4 humanify) → 100 (T5 gate fixes) → 105 (T6 carry-over tests)`

最终目标:**105 通过**。

---

## Task 0:计划 + 基线护栏

**文件：**
- 本计划文件(执行开始时由用户已 commit)。

**Step 1:校验基线**

运行:`npm test`
预期:80 通过,21 个文件。

**Step 2:为 Wave 2 加一张集成保护网**

创建:`test/integration/wave2.placeholder.test.js`

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

**Step 3:跑测试**

运行:`npm test`
预期:82 通过。

**Step 4:提交**

```bash
git add docs/plans/2026-05-12-pr5-wave2-and-humanify.md test/integration/wave2.placeholder.test.js
git commit -m "docs+test: PR5 plan + Wave 2 placeholder smoke test"
```

---

## Task 1:R9 — 由 settings 动态生成 3.x project.json

**目标:** 3.x 输出的 `project.json`、`package.json`、`settings/project.json` 反映源构建(引擎版本、工程名、设计分辨率、启动场景),不再是硬编码常量。

**文件：**
- 修改:`src/core/cocos3x/projectScaffold.js` — 在现有 2.x writer 旁新增 `writeCocos3xProject(outputPath, opts)`
- 修改:`src/core/cocos3x/engine3x.js` — 把内联的 `writeProjectDescriptor` 体替换为对 `writeCocos3xProject` 的调用,并把 `detectProjectFlavor` 拿到的 `settings` 串进去
- 测试:`test/unit/projectScaffold3x.test.js`(新增,4 个测试)

**Step 1:写失败测试**

创建 `test/unit/projectScaffold3x.test.js`:

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

运行:`npm test test/unit/projectScaffold3x.test.js`
预期:FAIL — `writeCocos3xProject is not a function`。

**Step 2:实现 `writeCocos3xProject`**

追加到 `src/core/cocos3x/projectScaffold.js`(在 `module.exports` 之前):

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

更新 exports:
```javascript
module.exports = { writeCocos2xProject, writeCocos3xProject };
```

**Step 3:在 engine3x 中接线**

在 `src/core/cocos3x/engine3x.js`:

把 `writeProjectDescriptor` 定义替换为:
```javascript
const { writeCocos2xProject, writeCocos3xProject } = require('./projectScaffold');

async function writeProjectDescriptor(outputPath, settings, sourceProjectName) {
  await writeCocos3xProject(outputPath, {
    projectName: sourceProjectName,
    settings: settings || {},
  });
}
```

找到 `writeProjectDescriptor(outputPath)` 的调用点 — 把在 `detectProjectFlavor` 中拿到的 `settings` 对象以及(若有)派生的工程名(例如 sourcePath 的 basename)透传过去。追踪:它在 `reverseProject3x` 的尾部被调用。从外层作用域取这两个参数。

**Step 4:跑测试**

运行:`npm test`
预期:86 通过。

**Step 5:提交**

```bash
git add -u src/core/cocos3x/projectScaffold.js src/core/cocos3x/engine3x.js
git add test/unit/projectScaffold3x.test.js
git commit -m "feat(3x): R9 dynamic project.json from source settings.json"
```

---

## Task 2:R10 — 3.x 使用 SharedClasses 动态类型表

**目标:** 在 rehydrate 3.x 资源时不再加载 `src/core/typeDefinitions.js`(那是 2.x 的硬编码表);完全依赖每份文档自带的 `sharedClasses`(`rehydrate.js` 已经接通)。确认现状 + 加一个测试钉死行为,以便后续有回归立即被捕获。

**文件：**
- 审计:`src/core/cocos3x/rehydrate.js` 与 `src/core/cocos3x/engine3x.js` 是否有 `../typeDefinitions` 的 import。理论上没有 — 但要校验并以集成测试作记录。
- 测试:`test/unit/cocos3x.no-static-types.test.js`(新增,3 个测试)

**Step 1:写测试断言边界**

创建 `test/unit/cocos3x.no-static-types.test.js`:

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

运行:`npm test test/unit/cocos3x.no-static-types.test.js`
预期:已经 PASS(当前代码无违规 import)。如果 FAIL,通过移除 import 修复违规者。

**Step 2:在 rehydrate.js 顶部加文档注释**

在 `src/core/cocos3x/rehydrate.js` 顶部 doc-comment 中显式声明:

```
* NOTE: 3.x rehydration is fully driven by each document's own
* `sharedClasses` array. We deliberately do NOT consult the 2.x
* hardcoded `typeDefinitions` table — see test/unit/cocos3x.no-static-types.test.js
* for the regression guard.
```

**Step 3:跑测试**

运行:`npm test`
预期:89 通过。

**Step 4:提交**

```bash
git add -u src/core/cocos3x/rehydrate.js
git add test/unit/cocos3x.no-static-types.test.js
git commit -m "test(3x): R10 pin 'no static typeDefinitions' boundary"
```

---

## Task 3:R11 + R12 — 更智能的 class→dir 映射 + 完整 .meta 文件

**目标(R11):** 当源工程 `config.paths[uuid].path` 缺失/为空或冲突时,通过 `CLASS_DIR` + 扩展名,从该资源的恢复后类派生出合理的输出路径;路径存在时予以保留。

**目标(R12):** 为非脚本资源也输出更丰富的 `.meta`(目前只有脚本会得到)。按资源类采用 class-aware 形态:`{ ver, importer, uuid, files, subMetas }`。

**文件：**
- 修改:`src/core/cocos3x/engine3x.js` — 抽出 `resolveOutputPath(uuid, cfg, klass)` 辅助;扩宽 `.meta` emitter 覆盖非脚本资源
- 测试:`test/unit/cocos3x.outputPath.test.js`(新增,2 个测试)
- 测试:`test/integration/cocos3x.metaFiles.test.js`(新增,1 个测试)

**Step 1:写失败测试**

创建 `test/unit/cocos3x.outputPath.test.js`:

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

创建 `test/integration/cocos3x.metaFiles.test.js`:

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

运行:`npm test test/unit/cocos3x.outputPath.test.js test/integration/cocos3x.metaFiles.test.js`
预期:FAIL — 两个 helper 都未导出。

**Step 2:在 engine3x.js 中实现 helper**

加入(并在文件 `module.exports` 末尾两者都导出):

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

(同时确保 `KLASS_TO_IMPORTER` 与 `CLASS_DIR` 对该 helper 可见。)

**Step 3:在资源写循环中使用这两个 helper**

找到现有的、复制资源文档的内层循环(目前通过 `config.paths[uuid].path` 计算输出文件名的位置)。把内联路径计算替换为 `resolveOutputPath(uuid, cfg, klass, ext)`。资源写成功后,如果 `klass` 在 `KLASS_TO_IMPORTER` 中且该路径还没有 `.meta`,则调用 `await writeAssetMeta(outBase + ext, { uuid, klass })`。

保留现有的脚本 `.meta` emitter。

**Step 4:跑测试**

运行:`npm test`
预期:92 通过。

**Step 5:提交**

```bash
git add -u src/core/cocos3x/engine3x.js
git add test/unit/cocos3x.outputPath.test.js test/integration/cocos3x.metaFiles.test.js
git commit -m "feat(3x): R11 path resolver + R12 richer asset .meta files"
```

---

## Task 4:humanify opt-in CLI 子命令(带外,不属于 6 层 in-memory 管线)

**目标:** 提供可选的 `cc-reverse humanify <dir>` 命令,在已恢复的 TS 工程上调用用户已安装的 `humanify` CLI。**这是带外步骤,需要用户显式调用,不会被 `cc-reverse reverse` 主管线自动触发。** 无硬依赖。两种 provider:`local`(默认)与 `openai`(可经 `OPENAI_BASE_URL` 与 `OPENAI_API_KEY` 配置)。检测到缺少 CLI 时退出码 1 并附安装说明;**不**自动安装。

**文件：**
- 创建:`src/core/cocos3x/scriptRecovery/humanify.js`
- 修改:`src/index.js` — 注册子命令
- 测试:`test/unit/scriptRecovery.humanify.test.js`(新增,4 个测试)

**Step 1:写失败测试**

创建 `test/unit/scriptRecovery.humanify.test.js`:

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

运行:`npm test test/unit/scriptRecovery.humanify.test.js`
预期:FAIL — 模块不存在。

**Step 2:实现 `humanify.js`**

```javascript
/*
 * humanify CLI wrapper (out-of-band, opt-in).
 *
 * NOT part of the 6-layer in-memory script recovery pipeline.
 * Triggered only by the explicit `cc-reverse humanify <outDir>` subcommand.
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

**Step 3:在 `src/index.js` 接 CLI 子命令**

加入(与现有 commander 命令并列):

```javascript
program
  .command('humanify <outDir>')
  .description('[opt-in, out-of-band — not part of the 6-layer pipeline] rename minified identifiers via the user-installed humanify CLI')
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

**Step 4:跑测试**

运行:`npm test`
预期:96 通过。

**Step 5:提交**

```bash
git add src/core/cocos3x/scriptRecovery/humanify.js test/unit/scriptRecovery.humanify.test.js
git add -u src/index.js
git commit -m "feat(3x scripts): humanify wrapper (opt-in CLI subcommand, out-of-band)"
```

---

## Task 5:遗留 gate 修复(PR 4 评审)

**目标:** 修复 PR 4 评审中暴露的两个 gate UX 缺陷。

- `tsProject` gate:把 tsconfig 是否存在 + 文件数暴露在 `detail` 中。
- `recoveryIndex` gate:列出*所有*缺失项(上限 10,以免输出过长),不再只列第一项。

**文件：**
- 修改:`src/validate/gates/tsProject.js`
- 修改:`src/validate/gates/recoveryIndex.js`
- 修改:`test/unit/validate.gates.test.js`(加 2 个更紧的测试;文件 +2)

**Step 1:tsProject — 保住数据**

编辑 `src/validate/gates/tsProject.js`:

把 `void tsFiles; void hasTsconfig;` 行替换为:

```javascript
return { ok: true, detail: `${tsFiles} .ts file(s); tsconfig.json ${hasTsconfig ? 'present' : 'absent'}` };
```

检查 `runGates` 对 `{ ok, detail }` 返回值的处理 — 同级 gate(如 `cconV2`、`layeredScripts`)可能用了不同 shape。匹配现有把 `detail` 投射到 `passed`/`failed` 的约定。如果 gate 现在返回的是裸 `true`/字符串,要么改成只在失败时返回描述字符串(成功保持 `true`),要么一次性升级 `runGates`,使 `passed` 条目能携带 detail。选**改动最小**的方案:若 `runGates` 已支持对象返回 (`{name, detail}`) 就用之;否则就返回 `true`,接受 tsProject 仍仅作信息性。在测试里把这一选择记下。

**Step 2:recoveryIndex — 列出全部 missing**

编辑 `src/validate/gates/recoveryIndex.js`:

把失败信息替换为:

```javascript
const list = missing.slice(0, 10).join(', ');
const more = missing.length > 10 ? ` (+${missing.length - 10} more)` : '';
return `${missing.length} missing entries: ${list}${more}`;
```

**Step 3:加紧测试**

在 `test/unit/validate.gates.test.js` 末尾追加:

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

(必要的 imports/helpers 若未引入,在文件顶部加上。)

如果 runGates 当前没有把 `detail` 串出去,也要 patch `src/validate/index.js`(`runGates`),让返回 `{ ok, detail }` 的 gate 把 `passed.push({name, detail})` 写入,字符串失败返回写入 `failed.push({name, detail: <string>})`。保持对裸 `true` 返回的向后兼容。

**Step 4:跑测试**

运行:`npm test`
预期:100 通过。

**Step 5:提交**

```bash
git add -u src/validate/gates/tsProject.js src/validate/gates/recoveryIndex.js src/validate/index.js test/unit/validate.gates.test.js
git commit -m "fix(validate): surface tsProject detail; enumerate recoveryIndex misses"
```

---

## Task 6:遗留 Layer 4/5 测试缺口(PR 4 评审)

**目标:** 补齐评审标记的缺失分支测试。无生产代码改动 — 仅测试。如有测试暴露真实 bug,在同一 commit 里修。

**文件：**
- 修改:`test/unit/scriptRecovery.ccclassNamer.test.js`(加 2 个测试)
- 修改:`test/unit/scriptRecovery.typeInferer.test.js`(加 3 个测试)

**Step 1:ccclassNamer — 类自引用改名 + 裸 _RF.push**

追加:

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

**Step 2:typeInferer — 分支覆盖**

追加到 `test/unit/scriptRecovery.typeInferer.test.js`:

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

如这些测试暴露任何 bug(例如 `inferType` 未导出,或聚合实际有问题),在同一 commit 中修复并在提交信息说明。

**Step 3:跑测试**

运行:`npm test`
预期:105 通过。

**Step 4:提交**

```bash
git add -u test/unit/scriptRecovery.ccclassNamer.test.js test/unit/scriptRecovery.typeInferer.test.js
git commit -m "test(3x scripts): close PR4 review coverage gaps (Layer 4 refs, Layer 5 branches)"
```

---

## Task 7:CHANGELOG + README + push + PR

**Step 1:CHANGELOG**

新增 Unreleased 条目,概述:

- R9 — `project.json` / `package.json` / `settings/project.json` 现在派生自源 `src/settings.json`(引擎版本、工程名、设计分辨率、启动场景)。
- R10 — 显式边界:3.x rehydration 使用每份文档的 `sharedClasses`;2.x `typeDefinitions` 表已不在 3.x 依赖图中(由测试钉死)。
- R11 — 源 path 缺失时 `resolveOutputPath` 回退到 `<classDir>/<uuid>`。
- R12 — 非脚本资源也得到 `.meta`(importer 按类映射)。
- humanify CLI 子命令 — 可选的 `cc-reverse humanify <outDir>` 带外步骤(对 humanify CLI 无硬依赖;支持 local + openai provider;copilot-api 仅作为用户自担风险记入文档;**不**属于 6 层 in-memory 脚本恢复管线,需用户显式调用)。
- 遗留修复 — gate detail 字符串;ccclassNamer + typeInferer 测试缺口已补。
- 105 个测试通过。

**Step 2:README**

在脚本恢复文档下新增 `### humanify (opt-in, out-of-band)` 子节,**强调它不是 reverse 主管线的一部分,而是用户在 reverse 完成后显式调用的独立 CLI 子命令**:

- 安装方法 (`npm i -g humanify`)。
- 两种支持的 provider(local 默认;openai 通过 `OPENAI_BASE_URL` / `OPENAI_API_KEY`)。
- 输出:`<outDir>/humanified/`。
- 备注:copilot-api 是文档化的用户自担风险路径,本工具**不**接通它。

**Step 3:终测 + push**

```bash
npm test  # expect 105
git add -u CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 5 (Wave 2 + humanify)"
git push origin feature/pr5-wave2-and-humanify
```

**Step 4:创建 PR**

```bash
gh pr create --base main --head feature/pr5-wave2-and-humanify \
  --title "feat(3.x): Wave 2 (R9–R12) + humanify opt-in CLI subcommand + PR3/4 carry-over fixes" \
  --body "$(cat <<'EOF'
## Summary

Wave 2 of the 3.x overhaul plus the opt-in `cc-reverse humanify` CLI subcommand (out-of-band — NOT part of the 6-layer in-memory script recovery pipeline; user must invoke explicitly), plus carry-over fixes from PR 3/4 reviews.

Plan: docs/plans/2026-05-12-pr5-wave2-and-humanify.md

### Wave 2
- **R9** — dynamic `project.json` / `package.json` / `settings/project.json` derived from source `src/settings.json` (was hardcoded constants).
- **R10** — pin "no static `typeDefinitions` in 3.x dep graph" with a regression test; 3.x now strictly relies on each document's own `sharedClasses`.
- **R11** — `resolveOutputPath` helper: when `config.paths[uuid].path` is missing, derive `<classDir>/<uuid>` from `CLASS_DIR`.
- **R12** — `.meta` files for non-script assets, importer keyed by Cocos class (`cc.SpriteFrame` → `sprite-frame`, etc.).

### humanify (opt-in, out-of-band)
- New CLI subcommand: `cc-reverse humanify <outDir> [--provider local|openai] [--base-url ...] [--api-key ...] [--model ...]`.
- **Not** triggered by the `reverse` main pipeline — user must invoke explicitly after recovery completes. Not one of the 6 in-memory AST layers.
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

报告 PR URL。

---

## Definition of Done

1. 所有 105 个测试通过。
2. CHANGELOG + README 已更新。
3. PR 已在 `clawnet-ai/cc-reverse` 上对 `main` 提交。
4. 无 2.x 退化(engine2x 未触;2.x golden 样本不在此处的 CI 中,但本计划承诺不动 `src/core/cocos2x/**`)。
