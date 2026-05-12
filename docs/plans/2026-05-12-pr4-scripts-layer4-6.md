# PR 4 — 脚本恢复 Layer 4-6（ccclassNamer + typeInferer + tsProjectEmitter）实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 接收 PR 3 产出的 Layer 3 之后的"带装饰器的 ESM"输出,并 (a) 还原 ccclass 的友好类名 + UUID 映射,(b) 通过扫描已恢复的 scene/prefab 推断字段类型,(c) 在 `assets/scripts/<bundle>/<module>.ts` 下产出可构建的 TypeScript 工程,并附顶层 `tsconfig.json`。这把分层输出从"带装饰器的 JS"提升到"可编译、镜像原始源码布局的 TS"。

**架构：**
- 在 `src/core/cocos3x/scriptRecovery/` 下新增三层:`ccclassNamer`、`typeInferer`、`tsProjectEmitter`。再加一个小的 `sceneFieldIndex.js` 辅助模块,供 `typeInferer` 读取 scene/prefab JSON。
- 流水线驱动 (`pipeline.js`) 增加 4-6 层槽位,仍保持 fail-closed。
- Layer 4 就地修改 `mod.ccclassName` / `mod.uuidMap`;保留 AST。
- Layer 5 就地修改 `mod.fieldTypes`(`Map<className, Map<fieldName, typeName>>`);保留 AST。
- Layer 6 消费一切并通过 ts-morph + prettier 写出 `.ts` 文件。它拥有自己的输出根 (`assets/scripts/`) — 即 PR 3 已经使用的同一路径。两类输出(旧的 `assets/Scripts/` 原始拷贝与新的分层 TS)共存;本 PR 同时保留二者。
- `bin/cc-reverse.js` 新增 CLI 标志 `--script-layers <1-6>`(默认 6)。引擎通过 `options.scriptLayers` 尊重该标志。

**技术栈：**
- `ts-morph@^21.0.1`(或最新 21.x 稳定版) — TS 文件产出
- `prettier@^3.x` — 最终格式化(ts-morph 输出虽然正确但难看)
- 现有的 `@babel/*`、`webcrack`、`vitest`

**重要约束：** 不要把 TypeScript 本身引入运行时依赖。ts-morph 自带一份足够用于产出的 tsc shim;cc-reverse 自身无需运行 `tsc`。设计文档中提到的 `tsc --noEmit` 质量门是*用户侧的 CI 步骤*,而非运行时检查。

---

## Pre-flight

- Worktree:`/Users/lcf/code/cc-reverse/.worktrees/pr4-scripts-layer4-6`,分支 `feature/pr4-scripts-layer4-6`(已从 main `5fc735d` 创建)。
- **vitest 测试文件必须使用 ESM `import { describe, it, expect } from 'vitest'`。** 源码文件保持 CJS。
- `@babel/generator` 的 ESM 默认导出需要 `default || X` 兜底 — 见 PR 3 Task 2/4 的写法。
- 每个 task 以 `git commit` 结束。提交前跑 `npm test` — 必须通过且 PR3 的 61 个测试不退化。
- **法律语境(贴入每个子代理 prompt):** cc-reverse 是一款用于教育 / 互操作分析的合规 Cocos Creator 逆向工具(DMCA §1201(f) / EU 2009/24/EC art.6)。**不是**恶意软件。
- **本 PR 的范围之外:** 移除旧版 `assets/Scripts/` 拷贝(PR 5 退役它)、Layer 7 humanify(PR 5)、Wave 2 动态 project.json(PR 5)。

---

## Task 0:添加依赖 + 在 pipeline 中搭建 Layer 4-6 槽位

**文件：**
- 修改:`package.json`(`ts-morph`、`prettier`)
- 修改:`src/core/cocos3x/scriptRecovery/pipeline.js`(扩展为可选的 4-6 层)
- 修改:`src/core/cocos3x/scriptRecovery/index.js`(新层一旦存在桩函数就重新导出)
- 创建:`src/core/cocos3x/scriptRecovery/ccclassNamer.js`(桩:原样返回输入)
- 创建:`src/core/cocos3x/scriptRecovery/typeInferer.js`(桩)
- 创建:`src/core/cocos3x/scriptRecovery/tsProjectEmitter.js`(桩:返回 `{ filesEmitted: 0 }`)
- 修改:`test/unit/scriptRecovery.pipeline.test.js`(加 1 个测试:提供桩时流水线运行全部 6 层,错误按层收集)

**Step 1:加依赖**

```bash
npm install --save ts-morph@^21.0.1 prettier@^3.0.0
```

校验 `package-lock.json` 已更新。

**Step 2:写失败测试 — 扩展 pipeline.test.js**

追加到 `test/unit/scriptRecovery.pipeline.test.js`:

```javascript
describe('scriptRecovery pipeline — layers 4-6', () => {
  it('runs ccclassNamer / typeInferer when provided as overrides', async () => {
    const calls = [];
    const result = await runScriptRecoveryPipeline({
      chunks: [{ name: 'a.js', source: 'System.register("m", [], function(){return {execute:function(){}}})' }],
      layers: {
        ccclassNamer: (mods) => { calls.push('namer'); return mods; },
        typeInferer: (mods) => { calls.push('infer'); return mods; },
      },
    });
    expect(calls).toEqual(['namer', 'infer']);
    expect(result.errors).toEqual([]);
  });

  it('continues remaining layers when ccclassNamer crashes', async () => {
    const result = await runScriptRecoveryPipeline({
      chunks: [{ name: 'a.js', source: 'System.register("m", [], function(){return {execute:function(){}}})' }],
      layers: {
        ccclassNamer: () => { throw new Error('boom'); },
      },
    });
    expect(result.errors.some((e) => e.layer === 'ccclassNamer')).toBe(true);
  });
});
```

运行:`npx vitest run test/unit/scriptRecovery.pipeline.test.js`
预期:FAIL — overrides 还未被尊重。

**Step 3:扩展 pipeline.js**

把 3 层驱动替换为 6 槽驱动。Layer 4-5 接收的是*模块数组*(而非单个 AST),因为它们需要跨模块信息(例如 UUID 去重、类型推断要读多个 scene)。Layer 6 消费数组并产出文件(其返回是 `{ filesEmitted, errors }` 而非 modules)。

```javascript
'use strict';

const { splitChunks: defaultSplit } = require('./chunkSplitter');
const { rebuildEsm: defaultRebuild } = require('./esmRebuilder');
const { restoreClasses: defaultRestore } = require('./classRestorer');
const { applyCcclassNames: defaultNamer } = require('./ccclassNamer');
const { inferFieldTypes: defaultInferer } = require('./typeInferer');
const { emitTsProject: defaultEmitter } = require('./tsProjectEmitter');

async function runScriptRecoveryPipeline(input) {
  const { chunks = [], layers = {}, context = {} } = input;
  const split = layers.chunkSplitter || defaultSplit;
  const rebuild = layers.esmRebuilder || defaultRebuild;
  const restore = layers.classRestorer || defaultRestore;
  const namer = layers.ccclassNamer || defaultNamer;
  const inferer = layers.typeInferer || defaultInferer;
  const emitter = layers.tsProjectEmitter; // emitter is opt-in (engine wires it)
  const errors = [];

  let modules = [];
  for (const chunk of chunks) {
    try {
      modules = modules.concat(await split(chunk));
    } catch (err) {
      errors.push({ layer: 'chunkSplitter', chunk: chunk.name, message: err.message });
    }
  }
  for (const m of modules) {
    try { m.ast = await rebuild(m.ast, m); }
    catch (err) { errors.push({ layer: 'esmRebuilder', module: m.name, message: err.message }); }
  }
  for (const m of modules) {
    try { m.ast = await restore(m.ast, m); }
    catch (err) { errors.push({ layer: 'classRestorer', module: m.name, message: err.message }); }
  }

  // Layer 4 sees the whole module set so UUID maps can dedupe across files.
  try {
    modules = (await namer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'ccclassNamer', message: err.message });
  }

  try {
    modules = (await inferer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'typeInferer', message: err.message });
  }

  let emit = null;
  if (emitter) {
    try {
      emit = await emitter(modules, context);
    } catch (err) {
      errors.push({ layer: 'tsProjectEmitter', message: err.message });
    }
  }

  return { modules, errors, emit };
}

module.exports = { runScriptRecoveryPipeline };
```

为三个新层文件写桩。每个:
```javascript
'use strict';
async function applyCcclassNames(modules, _context) { return modules; }
module.exports = { applyCcclassNames };
```
(各文件按需调整函数名 + export。)

更新 `index.js` barrel,重新导出新函数。

**Step 4:跑测试**

`npx vitest run test/unit/scriptRecovery.pipeline.test.js`
预期:PASS — 该文件 4 个测试(2 基线 + 2 新增)。

**Step 5:跑全量套件**

`npm test`
预期:61 基线 + 2 新 = 63 通过。

**Step 6:提交**

```bash
git add package.json package-lock.json src/core/cocos3x/scriptRecovery/ test/unit/scriptRecovery.pipeline.test.js
git commit -m "chore(3x/scripts): add ts-morph + prettier deps; pipeline slots for layers 4-6"
```

---

## Task 1:Layer 4 — ccclassNamer(`_RF.push` + `ccclass(...)` → 名字 + UUID 映射)

**背景。** Layer 1-3 之后,模块体形如:

```javascript
import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;
cclegacy._RF.push({}, "abcd1234-uuid", "Player", undefined);  // (1)

@ccclass('Player')                                             // (2)
class Player extends Component {
  @property name: string = "";
}

cclegacy._RF.pop();                                            // (3)
```

我们需要:
- 找到 (1) `cclegacy._RF.push({}, "<uuid>", "<className>", ...)` 调用(注意:3.x 输出里前缀可能是 `cclegacy._RF.push`,也可能仅为 `_RF.push`)。
- 找到类声明上的装饰器 (2) `@ccclass('<name>')` 或 `@ccclass({ name: '<name>' })`。
- 设置:
  - `mod.ccclassName` = 来自 `_RF.push` 的名字(优先)或装饰器参数。
  - `mod.uuid` = 来自 `_RF.push` 的 UUID。
  - `mod.uuidMap` = 单条目 `{ [uuid]: { className, moduleName: mod.name } }`。
- 删除 (1) `_RF.push(...)` 与 (3) `_RF.pop()` 调用 — 它们是 cocos 引擎内部代码,不是用户代码。
- 当类声明的 id 与 ccclassName 不一致时改名(Layer 1 从 registerId 末尾推导名字,例如 `chunks:///_virtual/Player.ts` → `Player`;通常已对齐,但混淆项目里会出现 `t` 这种垃圾名)。

**文件：**
- 修改:`src/core/cocos3x/scriptRecovery/ccclassNamer.js`
- 创建:`test/unit/scriptRecovery.ccclassNamer.test.js`

**Step 1:写失败测试**

```javascript
import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import babelGen from '@babel/generator';
import { applyCcclassNames } from '../../src/core/cocos3x/scriptRecovery/ccclassNamer.js';

const generate = babelGen.default || babelGen;

function makeModule(src, opts = {}) {
  return {
    name: opts.name || 'Player',
    ast: parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] }),
    deps: opts.deps || [],
    setterBindings: [],
    source: src,
  };
}

describe('Layer 4: ccclassNamer', () => {
  it('extracts uuid+name from cclegacy._RF.push and removes the call', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "abcd1234-uuid", "Player", undefined);
      @ccclass('Player')
      class Player extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src);
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Player');
    expect(out[0].uuid).toBe('abcd1234-uuid');
    expect(out[0].uuidMap).toEqual({ 'abcd1234-uuid': { className: 'Player', moduleName: 'Player' } });
    const code = generate(out[0].ast).code;
    expect(code).not.toMatch(/_RF\.(push|pop)/);
    expect(code).toMatch(/class\s+Player/);
  });

  it('renames a minified class id to the ccclassName from decorator', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "ffff-uuid", "Enemy", undefined);
      @ccclass('Enemy')
      class t extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src, { name: 't' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Enemy');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/class\s+Enemy\s+extends/);
  });

  it('falls back to ccclass decorator when _RF.push is absent', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass('Foo')
      class Foo extends Component {}
    `;
    const mod = makeModule(src, { name: 'Foo' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Foo');
    expect(out[0].uuid).toBeNull();
  });

  it('handles decorator argument as object { name }', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass({ name: 'Bar' })
      class Bar extends Component {}
    `;
    const mod = makeModule(src, { name: 'Bar' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Bar');
  });

  it('passthrough: module without class is unchanged and has null fields', async () => {
    const mod = { name: 'plain', ast: parse('var x = 1;', { sourceType: 'module' }), deps: [], setterBindings: [], source: 'var x = 1;' };
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBeNull();
    expect(out[0].uuid).toBeNull();
  });
});
```

运行:FAIL。

**Step 2:实现**

`src/core/cocos3x/scriptRecovery/ccclassNamer.js`:

```javascript
'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

/**
 * Layer 4: extract ccclass name + UUID from cclegacy._RF.push/_RF.push calls
 * and from @ccclass decorator. Strip the _RF push/pop scaffolding.
 */
async function applyCcclassNames(modules, _context) {
  for (const mod of modules) {
    mod.ccclassName = null;
    mod.uuid = null;
    mod.uuidMap = {};
    if (!mod.ast) continue;

    const meta = extractRfPush(mod.ast);
    let ccclassName = meta.className;
    let uuid = meta.uuid;

    // Prefer _RF.push name; fall back to @ccclass decorator.
    if (!ccclassName) ccclassName = extractCcclassDecoratorName(mod.ast);

    // Rename the class id if it differs (e.g. minified `t` → `Enemy`).
    if (ccclassName) renameClassId(mod.ast, ccclassName);

    mod.ccclassName = ccclassName || null;
    mod.uuid = uuid || null;
    if (uuid && ccclassName) {
      mod.uuidMap = { [uuid]: { className: ccclassName, moduleName: mod.name } };
    }
  }
  return modules;
}

/** Match cclegacy._RF.push({}, "<uuid>", "<name>", ...) or _RF.push(...) and remove. */
function extractRfPush(ast) {
  const out = { uuid: null, className: null };
  const toRemove = [];
  traverse(ast, {
    ExpressionStatement(p) {
      const expr = p.node.expression;
      if (!t.isCallExpression(expr)) return;
      if (!isRfMember(expr.callee, 'push') && !isRfMember(expr.callee, 'pop')) return;
      if (isRfMember(expr.callee, 'push') && expr.arguments.length >= 3) {
        const uuidArg = expr.arguments[1];
        const nameArg = expr.arguments[2];
        if (t.isStringLiteral(uuidArg)) out.uuid = uuidArg.value;
        if (t.isStringLiteral(nameArg)) out.className = nameArg.value;
      }
      toRemove.push(p);
    },
  });
  for (const p of toRemove) p.remove();
  return out;
}

/** member expression matches `cclegacy._RF.<which>` or `_RF.<which>`. */
function isRfMember(node, which) {
  if (!t.isMemberExpression(node)) return false;
  if (!t.isIdentifier(node.property, { name: which })) return false;
  // node.object is _RF or cclegacy._RF
  const obj = node.object;
  if (t.isIdentifier(obj, { name: '_RF' })) return true;
  if (
    t.isMemberExpression(obj) &&
    t.isIdentifier(obj.property, { name: '_RF' })
  ) return true;
  return false;
}

/** Find @ccclass('Name') or @ccclass({name:'Name'}) on any ClassDeclaration. */
function extractCcclassDecoratorName(ast) {
  let name = null;
  traverse(ast, {
    ClassDeclaration(p) {
      if (name) return;
      const decorators = p.node.decorators || [];
      for (const dec of decorators) {
        const expr = dec.expression;
        if (!t.isCallExpression(expr)) continue;
        if (!t.isIdentifier(expr.callee, { name: 'ccclass' })) continue;
        const arg = expr.arguments[0];
        if (t.isStringLiteral(arg)) { name = arg.value; return; }
        if (t.isObjectExpression(arg)) {
          const nameProp = arg.properties.find(
            (pr) => t.isObjectProperty(pr) && t.isIdentifier(pr.key, { name: 'name' }) && t.isStringLiteral(pr.value)
          );
          if (nameProp) { name = nameProp.value.value; return; }
        }
      }
    },
  });
  return name;
}

/** Rename the (single) ClassDeclaration's id and update local references. */
function renameClassId(ast, newName) {
  traverse(ast, {
    ClassDeclaration(p) {
      if (!p.node.id || p.node.id.name === newName) return;
      const oldName = p.node.id.name;
      p.scope.rename(oldName, newName);
      // path-level rename does not always cover ClassDeclaration.id reliably across babel versions.
      if (p.node.id && p.node.id.name === oldName) p.node.id.name = newName;
      p.stop();
    },
  });
}

module.exports = { applyCcclassNames };
```

**Step 3:跑测试**

`npx vitest run test/unit/scriptRecovery.ccclassNamer.test.js`
预期:PASS(5 个测试)。

**Step 4:全量套件**

`npm test`
预期:63 + 5 = 68 通过。

**Step 5:提交**

```bash
git add src/core/cocos3x/scriptRecovery/ccclassNamer.js test/unit/scriptRecovery.ccclassNamer.test.js
git commit -m "feat(3x/scripts): Layer 4 ccclassNamer — _RF.push + @ccclass → name + UUID map"
```

---

## Task 2:Layer 5 — typeInferer(扫描 scene/prefab,构建逐类字段类型表)

**背景。** Layer 4 之后我们已知 `Player` ↔ `abcd1234-uuid`。已恢复的 scene 里包含若干节点,其组件通过 `__type__`(注册的 ccclass 名)引用脚本,并附带字段赋值。已恢复 scene 的一个片段示例:

```json
[
  { "__type__": "Player", "_speed": 5.0, "_target": { "__id__": 7 } },
  { "__type__": "cc.Node", "_name": "Hero", ... },
  { "__type__": "cc.Sprite", ... }
]
```

通过观察值类型(`number`、`string`、`boolean`、`cc.Node`、`cc.Sprite`、`__uuid__` 引用、数组),我们可以为 `_speed: number`、`_target: Node` 等推断 TypeScript 类型。当值是带 `__uuid__` 的对象时,我们在 Layer 4 聚合的 `mod.uuidMap` 中查找 → 推断到用户类。

我们承认这是 best-effort。无法推断的字段保留 `any`(或为了产出方便,直接省略类型,让 TS 用初始化字面量类型)。

**文件：**
- 创建:`src/core/cocos3x/scriptRecovery/sceneFieldIndex.js`(辅助)
- 修改:`src/core/cocos3x/scriptRecovery/typeInferer.js`
- 创建:`test/unit/scriptRecovery.typeInferer.test.js`

**Step 1:写失败测试**

```javascript
import { describe, it, expect } from 'vitest';
import { inferFieldTypes } from '../../src/core/cocos3x/scriptRecovery/typeInferer.js';

describe('Layer 5: typeInferer', () => {
  it('infers number / string / boolean from scalar field values', async () => {
    const modules = [
      { name: 'Player', ccclassName: 'Player', uuid: 'p-uuid', uuidMap: { 'p-uuid': { className: 'Player', moduleName: 'Player' } } },
    ];
    const context = {
      scenes: [
        [
          { __type__: 'Player', _speed: 5, _name: 'hero', _alive: true },
        ],
      ],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes).toEqual({
      _speed: 'number',
      _name: 'string',
      _alive: 'boolean',
    });
  });

  it('maps cc.* node references to engine type names', async () => {
    const modules = [
      { name: 'P', ccclassName: 'P', uuid: 'p', uuidMap: { p: { className: 'P', moduleName: 'P' } } },
    ];
    const context = {
      scenes: [
        [
          { __type__: 'P', _node: { __id__: 1 }, _sprite: { __id__: 2 } },
          { __type__: 'cc.Node' },
          { __type__: 'cc.Sprite' },
        ],
      ],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._node).toBe('Node');
    expect(out[0].fieldTypes._sprite).toBe('Sprite');
  });

  it('resolves __uuid__ asset refs to the matching ccclass when known', async () => {
    const modules = [
      { name: 'A', ccclassName: 'A', uuid: 'a', uuidMap: { a: { className: 'A', moduleName: 'A' } } },
      { name: 'Cfg', ccclassName: 'Cfg', uuid: 'cfg-u', uuidMap: { 'cfg-u': { className: 'Cfg', moduleName: 'Cfg' } } },
    ];
    const context = {
      scenes: [
        [
          { __type__: 'A', _config: { __uuid__: 'cfg-u' } },
        ],
      ],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._config).toBe('Cfg');
  });

  it('falls back to any[] for arrays of unknown shape', async () => {
    const modules = [
      { name: 'X', ccclassName: 'X', uuid: 'x', uuidMap: { x: { className: 'X', moduleName: 'X' } } },
    ];
    const context = {
      scenes: [[{ __type__: 'X', _items: [{ __id__: 5 }, { __id__: 6 }] }]],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._items).toBe('any[]');
  });

  it('passthrough when no scenes provided', async () => {
    const modules = [{ name: 'P', ccclassName: 'P', uuid: null, uuidMap: {} }];
    const out = await inferFieldTypes(modules, {});
    expect(out[0].fieldTypes).toEqual({});
  });
});
```

运行:FAIL。

**Step 2:实现辅助 + 该层**

`src/core/cocos3x/scriptRecovery/sceneFieldIndex.js`:

```javascript
'use strict';

/**
 * Walk a recovered scene/prefab document (an array of "tagged" objects with
 * __type__) and emit { className -> { fieldName -> sample value } }.
 */
function indexSceneFields(doc) {
  const out = new Map();
  if (!Array.isArray(doc)) return out;
  for (const node of doc) {
    if (!node || typeof node !== 'object') continue;
    const type = node.__type__;
    if (typeof type !== 'string') continue;
    let bucket = out.get(type);
    if (!bucket) { bucket = new Map(); out.set(type, bucket); }
    for (const [k, v] of Object.entries(node)) {
      if (k === '__type__' || k === '__id__') continue;
      if (!bucket.has(k)) bucket.set(k, v);
    }
  }
  return out;
}

module.exports = { indexSceneFields };
```

`src/core/cocos3x/scriptRecovery/typeInferer.js`:

```javascript
'use strict';

const { indexSceneFields } = require('./sceneFieldIndex');

/**
 * Layer 5: walk recovered scenes (context.scenes is an array of scene/prefab
 * documents) and per ccclass, infer field types from observed sample values.
 */
async function inferFieldTypes(modules, context = {}) {
  const scenes = context.scenes || [];
  // Aggregate uuidMap across all modules for cross-module __uuid__ resolution.
  const uuidMap = {};
  for (const m of modules) {
    if (m.uuidMap) Object.assign(uuidMap, m.uuidMap);
  }
  // Aggregate per-class samples across all scenes.
  const classSamples = new Map(); // className -> Map<field, sample>
  for (const sc of scenes) {
    const idx = indexSceneFields(sc);
    for (const [klass, fields] of idx.entries()) {
      let bucket = classSamples.get(klass);
      if (!bucket) { bucket = new Map(); classSamples.set(klass, bucket); }
      for (const [k, v] of fields.entries()) {
        if (!bucket.has(k)) bucket.set(k, v);
      }
    }
  }
  for (const mod of modules) {
    mod.fieldTypes = {};
    if (!mod.ccclassName) continue;
    const fields = classSamples.get(mod.ccclassName);
    if (!fields) continue;
    for (const [k, v] of fields.entries()) {
      mod.fieldTypes[k] = inferType(v, uuidMap);
    }
  }
  return modules;
}

function inferType(v, uuidMap) {
  if (v === null) return 'any';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'any[]'; // could be sharper but cheap MVP
  if (typeof v === 'object') {
    // {__uuid__} → asset reference. Resolve to a ccclass name when known.
    if (typeof v.__uuid__ === 'string') {
      const hit = uuidMap[v.__uuid__];
      if (hit && hit.className) return hit.className;
      return 'string'; // raw uuid string
    }
    // {__id__} → in-scene reference. Try to read the referenced node's __type__
    // — but we'd need the original scene index. For MVP, return Node.
    if (typeof v.__id__ === 'number') return 'Node';
    // {__type__: 'cc.Sprite'} inline — strip the cc. prefix.
    if (typeof v.__type__ === 'string' && v.__type__.startsWith('cc.')) {
      return v.__type__.slice(3);
    }
  }
  return 'any';
}

module.exports = { inferFieldTypes };
```

**关于 `_node`/`_sprite` 测试的说明:** 测试期望 `_node: 'Node'`、`_sprite: 'Sprite'`。两个字段都是 `{__id__: N}` 引用。要让 `_sprite` 推断为 `'Sprite'`,需要顺着 `__id__` 找到目标节点并读取其 `__type__`。

更新 `inferFieldTypes`,把*当前 scene 数组*传入 `inferType` 以便解引用。把按场景的循环替换为:

```javascript
for (const sc of scenes) {
  if (!Array.isArray(sc)) continue;
  for (const node of sc) {
    if (!node || typeof node !== 'object') continue;
    const klass = node.__type__;
    if (typeof klass !== 'string') continue;
    let bucket = classSamples.get(klass);
    if (!bucket) { bucket = new Map(); classSamples.set(klass, bucket); }
    for (const [k, v] of Object.entries(node)) {
      if (k === '__type__' || k === '__id__') continue;
      if (!bucket.has(k)) bucket.set(k, { value: v, scene: sc });
    }
  }
}
```

并在按模块的循环里把 scene 传入 `inferType`:
```javascript
for (const [k, sample] of fields.entries()) {
  mod.fieldTypes[k] = inferType(sample.value, uuidMap, sample.scene);
}
```

并扩展 `inferType`:
```javascript
function inferType(v, uuidMap, scene) {
  // ...
  if (typeof v === 'object' && typeof v.__id__ === 'number' && Array.isArray(scene)) {
    const target = scene[v.__id__];
    if (target && typeof target.__type__ === 'string') {
      const tt = target.__type__;
      if (tt.startsWith('cc.')) return tt.slice(3);
      // user class via uuidMap (target may have __uuid__ in some shapes)
      const hit = uuidMap[tt];
      if (hit) return hit.className;
      return tt; // fall through with the bare name
    }
    return 'Node';
  }
  // ...
}
```

`sceneFieldIndex.js` 辅助现在对推断已属冗余,但保留导出 — 它在诊断和 Task 5 的质量门里有用。

**Step 3:跑测试**

`npx vitest run test/unit/scriptRecovery.typeInferer.test.js`
预期:PASS(5 个测试)。

**Step 4:全量套件**

`npm test`
预期:68 + 5 = 73 通过。

**Step 5:提交**

```bash
git add src/core/cocos3x/scriptRecovery/typeInferer.js src/core/cocos3x/scriptRecovery/sceneFieldIndex.js test/unit/scriptRecovery.typeInferer.test.js
git commit -m "feat(3x/scripts): Layer 5 typeInferer — infer field types from scenes"
```

---

## Task 3:Layer 6 — tsProjectEmitter(ts-morph + prettier → assets/scripts/*.ts + tsconfig)

**目标:** 接收 Layer 5 后的 modules,产出:
- `assets/scripts/<bundle>/<module>.ts` — 每个模块一个 TS 文件,字段声明上带 `: <Type>` 注解,`@property` 装饰器保留。
- `assets/scripts/tsconfig.json` — 最小配置,允许 `tsc --noEmit` 校验工程。
- `assets/scripts/RECOVERY_INDEX.json` — `{ uuid → 相对 TS 路径, className }`,供下游工具消费。

**策略。** ts-morph 解析我们已有的 JS 源码(从 babel AST → 字符串往返),随后我们遍历类声明并在匹配的字段上加上类型注解。这比用 babel 构造 TS 更简单,因为 babel-types 的 TS API 与装饰器交互很脆。

**文件：**
- 修改:`src/core/cocos3x/scriptRecovery/tsProjectEmitter.js`
- 创建:`test/integration/scriptRecovery.tsEmit.test.js`

**Step 1:写失败测试**

```javascript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { emitTsProject } from '../../src/core/cocos3x/scriptRecovery/tsProjectEmitter.js';

describe('Layer 6: tsProjectEmitter (integration)', () => {
  it('emits one .ts per module with inferred field types and a tsconfig.json', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-ts-'));
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass, property } = _decorator;
      @ccclass('Player')
      class Player extends Component {
        _speed = 0;
        _name = '';
      }
    `;
    const modules = [{
      name: 'Player',
      bundle: 'main',
      ast: parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] }),
      ccclassName: 'Player',
      uuid: 'p-uuid',
      uuidMap: { 'p-uuid': { className: 'Player', moduleName: 'Player' } },
      fieldTypes: { _speed: 'number', _name: 'string' },
      source: src,
    }];
    const result = await emitTsProject(modules, { outRoot: tmp });
    expect(result.filesEmitted).toBe(1);
    const tsPath = path.join(tmp, 'main', 'Player.ts');
    await access(tsPath);
    const ts = await readFile(tsPath, 'utf8');
    expect(ts).toMatch(/_speed\s*:\s*number/);
    expect(ts).toMatch(/_name\s*:\s*string/);
    await access(path.join(tmp, 'tsconfig.json'));
    const idx = JSON.parse(await readFile(path.join(tmp, 'RECOVERY_INDEX.json'), 'utf8'));
    expect(idx['p-uuid']).toEqual({ path: 'main/Player.ts', className: 'Player' });
  });

  it('returns {filesEmitted:0} when no modules', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-ts-empty-'));
    const r = await emitTsProject([], { outRoot: tmp });
    expect(r.filesEmitted).toBe(0);
  });
});
```

运行:FAIL。

**Step 2:实现**

`src/core/cocos3x/scriptRecovery/tsProjectEmitter.js`:

```javascript
'use strict';

const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');

const babelGenerator = require('@babel/generator');
const generate = babelGenerator.default || babelGenerator;

let tsMorph; // lazy
let prettier; // lazy

/**
 * Layer 6: emit a TypeScript project from post-Layer-5 modules.
 *
 * @param {Array} modules
 * @param {object} context
 * @param {string} context.outRoot   — directory to write into (typically <out>/assets/scripts)
 * @returns {Promise<{filesEmitted:number, errors:Array}>}
 */
async function emitTsProject(modules, context = {}) {
  const outRoot = context.outRoot;
  if (!outRoot) throw new Error('emitTsProject: context.outRoot is required');
  const errors = [];
  if (!modules.length) {
    await mkdir(outRoot, { recursive: true });
    await writeTsconfig(outRoot);
    await writeFile(path.join(outRoot, 'RECOVERY_INDEX.json'), '{}\n');
    return { filesEmitted: 0, errors };
  }

  if (!tsMorph) tsMorph = require('ts-morph');
  if (!prettier) prettier = require('prettier');

  const project = new tsMorph.Project({ useInMemoryFileSystem: true, compilerOptions: { target: tsMorph.ScriptTarget.ES2020 } });
  const recoveryIndex = {};
  let count = 0;

  for (const mod of modules) {
    if (!mod.ast || !mod.ccclassName) continue;
    const bundle = mod.bundle || 'unbundled';
    const relPath = `${bundle}/${mod.ccclassName}.ts`;
    const fsPath = path.join(outRoot, relPath);
    let jsCode;
    try {
      jsCode = generate(mod.ast, { compact: false }).code;
    } catch (err) {
      errors.push({ module: mod.name, message: `generate: ${err.message}` });
      continue;
    }

    let sourceFile;
    try {
      sourceFile = project.createSourceFile(relPath, jsCode, { overwrite: true });
    } catch (err) {
      errors.push({ module: mod.name, message: `tsMorph create: ${err.message}` });
      continue;
    }

    // Apply field type annotations.
    try {
      annotateFields(sourceFile, mod);
    } catch (err) {
      errors.push({ module: mod.name, message: `annotate: ${err.message}` });
    }

    let text = sourceFile.getFullText();
    try {
      text = await prettier.format(text, { parser: 'typescript', singleQuote: true });
    } catch { /* keep unformatted */ }

    await mkdir(path.dirname(fsPath), { recursive: true });
    await writeFile(fsPath, text);
    if (mod.uuid) recoveryIndex[mod.uuid] = { path: relPath, className: mod.ccclassName };
    count += 1;
  }

  await mkdir(outRoot, { recursive: true });
  await writeTsconfig(outRoot);
  await writeFile(path.join(outRoot, 'RECOVERY_INDEX.json'), JSON.stringify(recoveryIndex, null, 2) + '\n');
  return { filesEmitted: count, errors };
}

function annotateFields(sourceFile, mod) {
  const types = mod.fieldTypes || {};
  for (const cls of sourceFile.getClasses()) {
    for (const prop of cls.getInstanceProperties()) {
      // PropertyDeclaration only — skip methods/getters/setters
      if (typeof prop.getName !== 'function') continue;
      const name = prop.getName();
      const inferred = types[name];
      if (!inferred) continue;
      try { prop.setType(inferred); } catch { /* skip */ }
    }
  }
}

async function writeTsconfig(root) {
  const cfg = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Node',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
      allowJs: false,
      esModuleInterop: true,
    },
    include: ['**/*.ts'],
  };
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { emitTsProject };
```

**Step 3:跑测试**

`npx vitest run test/integration/scriptRecovery.tsEmit.test.js`
预期:PASS(2 个测试)。

**Step 4:全量套件**

`npm test`
预期:73 + 2 = 75 通过。

**Step 5:提交**

```bash
git add src/core/cocos3x/scriptRecovery/tsProjectEmitter.js test/integration/scriptRecovery.tsEmit.test.js
git commit -m "feat(3x/scripts): Layer 6 tsProjectEmitter — ts-morph + prettier → .ts files"
```

---

## Task 4:把 Layer 4-6 接入 engine3x(附可选 CLI 标志)

**目标:** 当 `recoverScriptsLayered` 运行时,同时收集 scenes(已恢复的 `assets/` 下的 .json 文件)并以 `context.scenes` 传入流水线。所有层跑完后,如启用 Layer 6,则调用 `emitTsProject`。PR 3 留下的旧版 `assets/scripts/<chunk>/<mod>.js` 输出在 Layer 6 失败或被禁用时作为兜底保留。

**文件：**
- 修改:`src/core/cocos3x/engine3x.js`
- 修改:`bin/cc-reverse.js`(若存在则添加 `--script-layers <n>`;否则默认 6)
- 修改:`test/integration/scriptRecovery.test.js`(扩展以校验 Layer 6 启用时的 .ts 产出)

**Step 1:扩展失败测试**

追加到 `test/integration/scriptRecovery.test.js`:

```javascript
it('emits TS project under assets/scripts/<bundle>/ when Layer 6 enabled', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc3x-ts-'));
  const srcChunks = path.join(tmp, 'src', 'chunks');
  const out = path.join(tmp, 'out');
  await mkdir(srcChunks, { recursive: true });
  // Cocos-shaped chunk that includes a _RF.push so Layer 4 can name it.
  const chunk = `
    System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
      var _decorator, Component, ccclass, Player;
      return {
        setters: [function (_cc) { _decorator = _cc._decorator; Component = _cc.Component; }],
        execute: function () {
          ccclass = _decorator.ccclass;
          cclegacy._RF.push({}, "abcd-uuid", "Player", undefined);
          Player = (function (_super) {
            __extends(Player, _super);
            function Player() { return _super.call(this) || this; }
            return Player;
          }(Component));
          Player = __decorate([ccclass('Player')], Player);
          _export("default", Player);
          cclegacy._RF.pop();
        }
      };
    });
  `;
  await writeFile(path.join(srcChunks, 'index.js'), chunk);

  const result = await recoverScriptsLayered(tmp, out, false, { scriptLayers: 6 });
  expect(result.modulesEmitted).toBeGreaterThanOrEqual(1);
  expect(result.tsFilesEmitted).toBeGreaterThanOrEqual(1);
  await access(path.join(out, 'assets', 'scripts', 'tsconfig.json'));
  await access(path.join(out, 'assets', 'scripts', 'RECOVERY_INDEX.json'));
});
```

运行:FAIL — `recoverScriptsLayered` 还不接受 options,也不返回 tsFilesEmitted。

**Step 2:更新 engine3x**

在 `recoverScriptsLayered(sourcePath, outputPath, verbose, options = {})` 里:

1. 接收 `options.scriptLayers`(默认 6)。
2. 加载 chunks 之后,同时从已恢复的输出目录里加载 scene/prefab JSON。**注意**:recoverScriptsLayered 在分层输出全部写完*之前*就运行了。我们想要的 scenes 是已经被更广义的 unpacker 写到输出目录的那一批。保守 MVP:在调用时刻扫描 `outputPath/assets/` 下的 `*.json` 与 `*.scene` 文件。如果输出还不存在,scenes 为空。
3. 当 `scriptLayers >= 6` 时,在流水线调用里设置 `tsProjectEmitter` 并填入 `context.scenes`。

补丁:

```javascript
async function recoverScriptsLayered(sourcePath, outputPath, verbose, options = {}) {
  const scriptLayers = options.scriptLayers != null ? options.scriptLayers : 6;
  const chunksDir = path.join(sourcePath, 'src', 'chunks');
  if (!(await pathExists(chunksDir))) return { modulesEmitted: 0, tsFilesEmitted: 0, errors: [] };
  const entries = await readdir(chunksDir);
  const chunks = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(chunksDir, entry);
    chunks.push({ name: entry, source: await readFile(full, 'utf8') });
  }
  if (chunks.length === 0) return { modulesEmitted: 0, tsFilesEmitted: 0, errors: [] };

  const scenes = await collectRecoveredScenes(outputPath);
  const layered = require('./scriptRecovery');

  const allErrors = [];
  let allModules = [];
  for (const chunk of chunks) {
    const baseName = chunk.name.replace(/\.js$/, '');
    const r = await layered.runScriptRecoveryPipeline({
      chunks: [chunk],
      context: { scenes, bundle: baseName },
      // omit emitter; we run it once with the union of all modules below
    });
    allErrors.push(...r.errors);
    for (const m of r.modules) m.bundle = baseName;
    allModules = allModules.concat(r.modules);
  }

  // Layer 6: emit TS project if requested.
  let tsFilesEmitted = 0;
  if (scriptLayers >= 6) {
    try {
      const emit = await layered.emitTsProject(allModules, { outRoot: path.join(outputPath, 'assets', 'scripts') });
      tsFilesEmitted = emit.filesEmitted;
      allErrors.push(...emit.errors);
    } catch (err) {
      allErrors.push({ layer: 'tsProjectEmitter', message: err.message });
    }
  }

  // Legacy .js output (PR 3 path) remains for parity until PR 5 retires it.
  let totalEmitted = 0;
  for (const m of allModules) {
    if (!m.ast) continue;
    try {
      const code = generate(m.ast, { compact: false }).code;
      const outDir = path.join(outputPath, 'assets', 'scripts', m.bundle);
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, `${m.name}.js`), code);
      totalEmitted += 1;
    } catch (err) {
      allErrors.push({ layer: 'emit', module: m.name, message: err.message });
    }
  }
  if (verbose) logger.debug(`LayeredScripts: ${totalEmitted} .js, ${tsFilesEmitted} .ts, ${allErrors.length} errors`);
  return { modulesEmitted: totalEmitted, tsFilesEmitted, errors: allErrors };
}

async function collectRecoveredScenes(outputPath) {
  const out = [];
  const root = path.join(outputPath, 'assets');
  if (!(await pathExists(root))) return out;
  for await (const f of walkJsonFiles(root)) {
    try {
      const text = await readFile(f, 'utf8');
      if (!text.startsWith('[')) continue; // scenes are JSON arrays at top
      out.push(JSON.parse(text));
    } catch { /* skip */ }
  }
  return out;
}

async function* walkJsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walkJsonFiles(p);
    else if (e.isFile() && e.name.endsWith('.json')) yield p;
  }
}
```

把 `emitTsProject` 加到对 `./scriptRecovery` 的 require/解构(目前只引入了 `runScriptRecoveryPipeline`)。同步更新 barrel `src/core/cocos3x/scriptRecovery/index.js`,确保也导出 `emitTsProject`、`applyCcclassNames`、`inferFieldTypes`(若尚未导出)。

**Step 3:CLI 标志(尽力而为,结构不便就跳过)**

查看 `bin/cc-reverse.js`。如果它直接用 `process.argv`,加最小解析:

```javascript
const layersArg = process.argv.find((a) => a.startsWith('--script-layers='));
const scriptLayers = layersArg ? parseInt(layersArg.split('=')[1], 10) : 6;
// pass `{ scriptLayers }` through to engine3x
```

如果 CLI 用了解析库(commander/yargs),按其惯例添加。**接线如果不简单,可改为留 TODO 注释 + 默认 6** — 测试路径直接把 options 传入 `recoverScriptsLayered`。

**Step 4:跑测试**

`npm test`
预期:75 + 1 = 76 通过。

**Step 5:提交**

```bash
git add src/core/cocos3x/engine3x.js src/core/cocos3x/scriptRecovery/index.js bin/cc-reverse.js test/integration/scriptRecovery.test.js
git commit -m "feat(3x): wire Layer 4-6 into engine3x; emit TS project + RECOVERY_INDEX"
```

---

## Task 5:质量门 — `recoveryIndex`(UUID 闭包)+ `tsProject`(存在性)

**目标:** 把新工件暴露给 `cc-reverse validate`。两个新质量门:

- `recoveryIndex` — 当 `assets/scripts/RECOVERY_INDEX.json` 存在,且其中列出的每个 uuid 值都能在 `assets/scripts/` 相对路径下找到对应文件时通过。失败模式:报告缺失的 uuid → path 条目。
- `tsProject` — 信息性:当 `assets/scripts/tsconfig.json` 存在时通过;报告 `.ts` 文件数。(**不**在此处 shell 出 `tsc` — 那是用户侧另外的 CI 步骤。)

**文件：**
- 创建:`src/validate/gates/recoveryIndex.js`
- 创建:`src/validate/gates/tsProject.js`
- 修改:`src/validate/index.js`
- 修改:`test/unit/validate.gates.test.js`

**Step 1:写失败测试**

追加到 `test/unit/validate.gates.test.js`:

```javascript
describe('recoveryIndex gate', () => {
  it('passes when index file maps each uuid to an existing path', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ri-'));
    const root = path.join(tmp, 'assets', 'scripts');
    mkdirSync(path.join(root, 'main'), { recursive: true });
    writeFileSync(path.join(root, 'main', 'Player.ts'), '// ok');
    writeFileSync(path.join(root, 'RECOVERY_INDEX.json'), JSON.stringify({ 'p-u': { path: 'main/Player.ts', className: 'Player' } }));
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.passed).toContain('recoveryIndex');
  });

  it('fails when index references a missing path', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ri-'));
    const root = path.join(tmp, 'assets', 'scripts');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'RECOVERY_INDEX.json'), JSON.stringify({ 'p-u': { path: 'main/Missing.ts', className: 'Player' } }));
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.failed).toContain('recoveryIndex');
  });

  it('skips (passes informational) when no index file exists', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ri-'));
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.passed).toContain('recoveryIndex');
  });
});

describe('tsProject gate', () => {
  it('reports ts file count when tsconfig.json present', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ts-'));
    const root = path.join(tmp, 'assets', 'scripts');
    mkdirSync(path.join(root, 'main'), { recursive: true });
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'main', 'A.ts'), 'export {};');
    writeFileSync(path.join(root, 'main', 'B.ts'), 'export {};');
    const r = runGates(tmp, { gates: ['tsProject'] });
    expect(r.passed).toContain('tsProject');
  });
});
```

运行:FAIL。

**Step 2:实现质量门**

`src/validate/gates/recoveryIndex.js`:

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = function recoveryIndex(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  const indexPath = path.join(root, 'RECOVERY_INDEX.json');
  if (!fs.existsSync(indexPath)) return true; // informational pass
  let idx;
  try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (err) { return `RECOVERY_INDEX.json unreadable: ${err.message}`; }
  const missing = [];
  for (const [uuid, entry] of Object.entries(idx)) {
    if (!entry || typeof entry.path !== 'string') { missing.push(uuid); continue; }
    if (!fs.existsSync(path.join(root, entry.path))) missing.push(`${uuid} → ${entry.path}`);
  }
  if (missing.length) return `${missing.length} entries missing — first: ${missing[0]}`;
  return true;
};
```

`src/validate/gates/tsProject.js`:

```javascript
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function walk(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
module.exports = function tsProject(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  if (!fs.existsSync(path.join(root, 'tsconfig.json'))) return true;
  const tsFiles = walk(root, new Set(['.ts']));
  // informational — never fails
  return true;
};
```

把两者注册到 `src/validate/index.js` 的 ALL 块中。

**Step 3:跑**

`npm test` — 76 + 4 = 80 通过。

**Step 4:提交**

```bash
git add src/validate/gates/recoveryIndex.js src/validate/gates/tsProject.js src/validate/index.js test/unit/validate.gates.test.js
git commit -m "feat(validate): recoveryIndex + tsProject gates"
```

---

## Task 6:CHANGELOG、README、push、PR

**文件：**
- 修改:`CHANGELOG.md`(顶部新增条目)
- 修改:`README.md`(扩展 3.x 脚本恢复章节,提到 layers 4-6)

**Step 1:CHANGELOG**

在 CHANGELOG 顶部(`## [Unreleased]` 之后)添加:

```markdown
## PR 4 — Script Recovery Layers 4-6 (ccclassNamer + typeInferer + tsProjectEmitter)

- **Layer 4 (ccclassNamer):** extracts user-facing class name + UUID from `cclegacy._RF.push(...)` and `@ccclass(...)` decorator; renames minified class identifiers; strips engine-internal `_RF.push/pop` scaffolding; aggregates a per-module UUID map.
- **Layer 5 (typeInferer):** scans recovered scene/prefab JSON, resolves `__id__` references to engine types (`cc.Sprite` → `Sprite`) and `__uuid__` references to user ccclass names; emits a per-class field type table.
- **Layer 6 (tsProjectEmitter):** ts-morph + prettier driven emission of `assets/scripts/<bundle>/<className>.ts`, plus top-level `tsconfig.json` and `RECOVERY_INDEX.json` (uuid → ts file path).
- `engine3x.recoverScriptsLayered` now (a) collects already-recovered scene JSON to feed Layer 5, (b) emits the TS project alongside the legacy `.js` files, (c) accepts `options.scriptLayers` to cap the pipeline depth.
- New gates: `recoveryIndex` (UUID closure) and `tsProject` (presence + ts file count, informational).
- New deps: `ts-morph@^21.0.1`, `prettier@^3.0.0`.
```

**Step 2:README**

扩展 `### Script recovery (3.x)` 章节(PR 3 引入),在编号列表后追加 Layers 4-6,并加一段关于 TS 工程 + RECOVERY_INDEX 的说明。

**Step 3:测试 + 提交**

```bash
npm test  # expect 80 passing
git add CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 4 script recovery layers 4-6"
```

**Step 4:Push + PR**

```bash
git push -u origin feature/pr4-scripts-layer4-6
gh pr create --base main --head feature/pr4-scripts-layer4-6 --repo clawnet-ai/cc-reverse \
  --title "feat(3x): script recovery layers 4-6 (ccclass + types + TS emit)" \
  --body "$(cat <<'EOF'
## Summary

PR 4 of the 3.x overhaul — implements layers 4-6 of the script recovery pipeline, taking PR 3's ESM-with-decorators output to a buildable TypeScript project.

- **Layer 4 ccclassNamer** — extracts ccclass name + UUID from `_RF.push` / `@ccclass`, strips engine internals, renames minified classes.
- **Layer 5 typeInferer** — walks recovered scene/prefab JSON, infers field types per ccclass, resolves engine + user types via uuid map.
- **Layer 6 tsProjectEmitter** — ts-morph + prettier produces `.ts` files, `tsconfig.json`, and `RECOVERY_INDEX.json` under `assets/scripts/`.
- engine3x integration: collects scenes for Layer 5; emits TS alongside legacy `.js`; accepts `--script-layers` cap.
- New gates: `recoveryIndex`, `tsProject`.

## Pipeline state after this PR

```
src/chunks/*.js
   ↓ Layer 1  chunkSplitter      System.register → 1 module per class
   ↓ Layer 2  esmRebuilder       setters / _export → import / export
   ↓ Layer 3  classRestorer      __extends / __decorate → class + decorator
   ↓ Layer 4  ccclassNamer       _RF.push + @ccclass → name + UUID map
   ↓ Layer 5  typeInferer        scene scan → per-class field type table
   ↓ Layer 6  tsProjectEmitter   ts-morph → .ts + tsconfig + RECOVERY_INDEX
```

## Tests

19 new tests (5 ccclassNamer + 5 typeInferer + 2 tsEmit + 1 engine integration + 4 gates + 2 pipeline). All 80 tests pass.

## Out of scope (future PRs)

- Layer 7 humanify (PR 5)
- Wave 2 — dynamic `project.json`, smart class→dir mapping, .meta files (PR 5)
- Retiring legacy `assets/Scripts/` raw copy (PR 5)
EOF
)"
```

报告 PR URL + 最终测试数。

---

## 每 task 验收提示

每次 commit 之前:
1. 该 task 的测试通过。
2. 全量套件通过(无回归)。
3. 子代理报告任何偏离。
