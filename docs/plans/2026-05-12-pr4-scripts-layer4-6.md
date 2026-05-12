# PR 4 — Script Recovery Layers 4-6 (ccclassNamer + typeInferer + tsProjectEmitter) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take the post-Layer-3 ESM-with-decorators output from PR 3 and (a) restore ccclass user-friendly names + UUID mapping, (b) infer field types by scanning recovered scenes/prefabs, (c) emit a buildable TypeScript project under `assets/scripts/<bundle>/<module>.ts` with a top-level `tsconfig.json`. This brings layered output from "JS with decorators" to "compilable TS that mirrors the original source layout".

**Architecture:**
- Three new layers under `src/core/cocos3x/scriptRecovery/`: `ccclassNamer`, `typeInferer`, `tsProjectEmitter`. Plus a small `sceneFieldIndex.js` helper used by `typeInferer` to read scene/prefab JSON.
- Pipeline driver (`pipeline.js`) gains layer slots 4-6, still fail-closed.
- Layer 4 mutates `mod.ccclassName` / `mod.uuidMap` in place; preserves AST.
- Layer 5 mutates `mod.fieldTypes` (Map<className, Map<fieldName, typeName>>); preserves AST.
- Layer 6 consumes everything and writes `.ts` files via ts-morph + prettier. It owns its own output root (`assets/scripts/`) — same path PR 3 already used. The two layers (legacy `assets/Scripts/` raw copy and new layered TS) coexist; this PR keeps both.
- New CLI flag `--script-layers <1-6>` (default 6) on `bin/cc-reverse.js`. Engine respects it via `options.scriptLayers`.

**Tech Stack:**
- `ts-morph@^21.0.1` (or latest 21.x stable) — TS file emission
- `prettier@^3.x` — final formatting (ts-morph output is correct but ugly)
- existing `@babel/*`, `webcrack`, `vitest`

**Important constraint:** Don't introduce TypeScript itself as a runtime dep. ts-morph bundles a tsc shim sufficient for emit; we don't need to run `tsc` inside cc-reverse itself. The `tsc --noEmit` quality gate from the design doc is a *user-facing CI step*, not a runtime check.

---

## Pre-flight

- Worktree: `/Users/lcf/code/cc-reverse/.worktrees/pr4-scripts-layer4-6` on branch `feature/pr4-scripts-layer4-6` (already created from main `5fc735d`).
- **vitest test files MUST use ESM `import { describe, it, expect } from 'vitest'`.** Source files stay CJS.
- `@babel/generator` ESM default needs `default || X` fallback — see PR 3 Task 2/4 for the pattern.
- Each task ends with `git commit`. Run `npm test` before committing — must pass with no regression to the 61 PR3 tests.
- **Legal context (paste into every subagent prompt):** cc-reverse is a legitimate Cocos Creator reverse-engineering tool for educational / interoperability analysis (DMCA §1201(f) / EU 2009/24/EC art.6). NOT malware.
- **Out of scope for this PR**: removing the legacy `assets/Scripts/` copy (PR 5 retires it), Layer 7 humanify (PR 5), Wave 2 dynamic project.json (PR 5).

---

## Task 0: Add deps + scaffold layer slots 4-6 in pipeline

**Files:**
- Modify: `package.json` (`ts-morph`, `prettier`)
- Modify: `src/core/cocos3x/scriptRecovery/pipeline.js` (extend with optional layers 4-6)
- Modify: `src/core/cocos3x/scriptRecovery/index.js` (re-export new layer fns once they exist as stubs)
- Create: `src/core/cocos3x/scriptRecovery/ccclassNamer.js` (stub: returns input unchanged)
- Create: `src/core/cocos3x/scriptRecovery/typeInferer.js` (stub)
- Create: `src/core/cocos3x/scriptRecovery/tsProjectEmitter.js` (stub: returns `{ filesEmitted: 0 }`)
- Modify: `test/unit/scriptRecovery.pipeline.test.js` (add 1 test: pipeline runs all 6 layers when stubs provided, errors collected by layer)

**Step 1: Add deps**

```bash
npm install --save ts-morph@^21.0.1 prettier@^3.0.0
```

Verify `package-lock.json` updated.

**Step 2: Failing test — extend pipeline.test.js**

Append to `test/unit/scriptRecovery.pipeline.test.js`:

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

Run: `npx vitest run test/unit/scriptRecovery.pipeline.test.js`
Expected: FAIL — overrides not honored.

**Step 3: Extend pipeline.js**

Replace the 3-layer driver with a 6-slot one. Layers 4-5 receive the *array of modules* (not a single AST) because they need cross-module info (e.g. UUID dedupe, type inference reads many scenes). Layer 6 consumes the array and emits files (its return is `{ filesEmitted, errors }` not modules).

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

Stub the three new layer files. Each:
```javascript
'use strict';
async function applyCcclassNames(modules, _context) { return modules; }
module.exports = { applyCcclassNames };
```
(adjust fn name + export per file).

Update `index.js` barrel to re-export the new fns.

**Step 4: Run test**

`npx vitest run test/unit/scriptRecovery.pipeline.test.js`
Expected: PASS — 4 tests in this file (2 baseline + 2 new).

**Step 5: Run full suite**

`npm test`
Expected: 61 baseline + 2 new = 63 passing.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/core/cocos3x/scriptRecovery/ test/unit/scriptRecovery.pipeline.test.js
git commit -m "chore(3x/scripts): add ts-morph + prettier deps; pipeline slots for layers 4-6"
```

---

## Task 1: Layer 4 — ccclassNamer (`_RF.push` + `ccclass(...)` → name + UUID map)

**Background.** After Layers 1-3 the module body looks like:

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

We need to:
- Find calls (1) `cclegacy._RF.push({}, "<uuid>", "<className>", ...)` (note: in 3.x output the prefix may be `cclegacy._RF.push` or just `_RF.push`).
- Find decorator (2) `@ccclass('<name>')` or `@ccclass({ name: '<name>' })` on the class declaration.
- Set:
  - `mod.ccclassName` = name from `_RF.push` (preferred) or decorator argument.
  - `mod.uuid` = the UUID from `_RF.push`.
  - `mod.uuidMap` = a single-entry `{ [uuid]: { className, moduleName: mod.name } }`.
- Strip the (1) `_RF.push(...)` and (3) `_RF.pop()` calls — they're cocos engine internals, not user code.
- Rename the class declaration's id to the ccclassName when it differs (Layer 1 derived name from the registerId tail, e.g. `Player` from `chunks:///_virtual/Player.ts`; usually they already match but minified projects will have garbage names like `t`).

**Files:**
- Modify: `src/core/cocos3x/scriptRecovery/ccclassNamer.js`
- Create: `test/unit/scriptRecovery.ccclassNamer.test.js`

**Step 1: Failing test**

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

Run: FAIL.

**Step 2: Implement**

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

**Step 3: Run test**

`npx vitest run test/unit/scriptRecovery.ccclassNamer.test.js`
Expected: PASS (5 tests).

**Step 4: Full suite**

`npm test`
Expected: 63 + 5 = 68 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/ccclassNamer.js test/unit/scriptRecovery.ccclassNamer.test.js
git commit -m "feat(3x/scripts): Layer 4 ccclassNamer — _RF.push + @ccclass → name + UUID map"
```

---

## Task 2: Layer 5 — typeInferer (scan scenes/prefabs, build per-class field types)

**Background.** After Layer 4 we know `Player` ↔ `abcd1234-uuid`. Recovered scenes contain nodes with components that reference scripts by `__type__` (the registered ccclass name) plus assigned field values. Example fragment from a recovered scene:

```json
[
  { "__type__": "Player", "_speed": 5.0, "_target": { "__id__": 7 } },
  { "__type__": "cc.Node", "_name": "Hero", ... },
  { "__type__": "cc.Sprite", ... }
]
```

By inspecting the value type (`number`, `string`, `boolean`, `cc.Node`, `cc.Sprite`, `__uuid__` reference, array) we can suggest a TypeScript type for `_speed: number`, `_target: Node`, etc. Where the value is an object with `__uuid__` we look it up in `mod.uuidMap` aggregated from Layer 4 → infer the user class.

We accept that this is best-effort. Where we can't infer, we leave the field type as `any` (or, for emitting concerns, omit it and let TS use the initializer literal type).

**Files:**
- Create: `src/core/cocos3x/scriptRecovery/sceneFieldIndex.js` (helper)
- Modify: `src/core/cocos3x/scriptRecovery/typeInferer.js`
- Create: `test/unit/scriptRecovery.typeInferer.test.js`

**Step 1: Failing test**

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

Run: FAIL.

**Step 2: Implement helper + layer**

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

**Note on `_node`/`_sprite` test:** The test expects `_node: 'Node'` and `_sprite: 'Sprite'`. Both fields are `{__id__: N}` references. To get `'Sprite'` for `_sprite` we need to follow the `__id__` and look up `__type__` of the target node.

Update `inferFieldTypes` to pass the *current scene array* into `inferType` so it can dereference. Replace the per-scene loop with:

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

And in the per-mod loop, pass the scene to `inferType`:
```javascript
for (const [k, sample] of fields.entries()) {
  mod.fieldTypes[k] = inferType(sample.value, uuidMap, sample.scene);
}
```

And extend `inferType`:
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

The `sceneFieldIndex.js` helper is now redundant for inference but keep it exported — it's useful for diagnostics and the gate in Task 5.

**Step 3: Run test**

`npx vitest run test/unit/scriptRecovery.typeInferer.test.js`
Expected: PASS (5 tests).

**Step 4: Full suite**

`npm test`
Expected: 68 + 5 = 73 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/typeInferer.js src/core/cocos3x/scriptRecovery/sceneFieldIndex.js test/unit/scriptRecovery.typeInferer.test.js
git commit -m "feat(3x/scripts): Layer 5 typeInferer — infer field types from scenes"
```

---

## Task 3: Layer 6 — tsProjectEmitter (ts-morph + prettier → assets/scripts/*.ts + tsconfig)

**Goal:** Take post-Layer-5 modules and emit:
- `assets/scripts/<bundle>/<module>.ts` — one TS file per module, with `@property` decorators carrying the inferred type as a `: <Type>` annotation on the field declaration.
- `assets/scripts/tsconfig.json` — minimal config that lets `tsc --noEmit` validate the project.
- `assets/scripts/RECOVERY_INDEX.json` — `{ uuid → relative TS path, className }` for downstream tools.

**Strategy.** ts-morph parses the JS source we already have (round-trip from babel AST → string), then we walk class declarations and add type annotations onto matching fields. This is simpler than constructing TS via babel because babel-types' TS API and decorator interaction is fragile.

**Files:**
- Modify: `src/core/cocos3x/scriptRecovery/tsProjectEmitter.js`
- Create: `test/integration/scriptRecovery.tsEmit.test.js`

**Step 1: Failing test**

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

Run: FAIL.

**Step 2: Implement**

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

**Step 3: Run test**

`npx vitest run test/integration/scriptRecovery.tsEmit.test.js`
Expected: PASS (2 tests).

**Step 4: Full suite**

`npm test`
Expected: 73 + 2 = 75 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/tsProjectEmitter.js test/integration/scriptRecovery.tsEmit.test.js
git commit -m "feat(3x/scripts): Layer 6 tsProjectEmitter — ts-morph + prettier → .ts files"
```

---

## Task 4: Wire Layer 4-6 into engine3x (with optional CLI flag)

**Goal:** When `recoverScriptsLayered` runs, also collect scenes (recovered .json under `assets/`) and pass them into the pipeline as `context.scenes`. After all layers run, invoke `emitTsProject` if Layer 6 is enabled. The legacy `assets/scripts/<chunk>/<mod>.js` output from PR 3 stays as a fallback when Layer 6 fails or is disabled.

**Files:**
- Modify: `src/core/cocos3x/engine3x.js`
- Modify: `bin/cc-reverse.js` (add `--script-layers <n>` flag if present; otherwise just default to 6)
- Modify: `test/integration/scriptRecovery.test.js` (extend to verify .ts emission when Layer 6 runs)

**Step 1: Failing test extension**

Append to `test/integration/scriptRecovery.test.js`:

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

Run: FAIL — `recoverScriptsLayered` doesn't accept options yet, doesn't return tsFilesEmitted.

**Step 2: Update engine3x**

In `recoverScriptsLayered(sourcePath, outputPath, verbose, options = {})`:

1. Accept `options.scriptLayers` (default 6).
2. After loading chunks, also load scene/prefab JSON from any already-recovered output. **However**, recoverScriptsLayered runs *before* the layered output is fully written. The scenes we want are the ones that the broader unpacker has *already* written to the output dir. Conservative MVP: scan `outputPath/assets/` for `*.json` and `*.scene` files at call time. If output doesn't exist yet, scenes is empty.
3. Build the pipeline call with `tsProjectEmitter` set (when `scriptLayers >= 6`) and `context.scenes` populated.

Patch:

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

Add `emitTsProject` to the require/destructure of `./scriptRecovery` (currently only `runScriptRecoveryPipeline` is imported). Update the barrel `src/core/cocos3x/scriptRecovery/index.js` to also export `emitTsProject`, `applyCcclassNames`, `inferFieldTypes` (if not already).

**Step 3: CLI flag (best-effort, skip if structure prohibitive)**

Inspect `bin/cc-reverse.js`. If it uses `process.argv` directly, add minimal parsing:

```javascript
const layersArg = process.argv.find((a) => a.startsWith('--script-layers='));
const scriptLayers = layersArg ? parseInt(layersArg.split('=')[1], 10) : 6;
// pass `{ scriptLayers }` through to engine3x
```

If the CLI uses a parser library (commander/yargs), add the option idiomatically. **If wiring is non-trivial, defer to a TODO comment + leave default at 6** — the test path passes options directly into `recoverScriptsLayered`.

**Step 4: Run tests**

`npm test`
Expected: 75 + 1 = 76 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/engine3x.js src/core/cocos3x/scriptRecovery/index.js bin/cc-reverse.js test/integration/scriptRecovery.test.js
git commit -m "feat(3x): wire Layer 4-6 into engine3x; emit TS project + RECOVERY_INDEX"
```

---

## Task 5: Quality gates — `recoveryIndex` (UUID closure) + `tsProject` (presence)

**Goal:** Surface the new artefacts to `cc-reverse validate`. Two new gates:

- `recoveryIndex` — passes when `assets/scripts/RECOVERY_INDEX.json` exists and every uuid value listed there resolves to a file at `path` relative to `assets/scripts/`. Failure mode: report missing uuid → path entries.
- `tsProject` — informational: passes when `assets/scripts/tsconfig.json` exists; reports number of `.ts` files. (We DO NOT shell out to `tsc` here — that's a separate user-side CI step.)

**Files:**
- Create: `src/validate/gates/recoveryIndex.js`
- Create: `src/validate/gates/tsProject.js`
- Modify: `src/validate/index.js`
- Modify: `test/unit/validate.gates.test.js`

**Step 1: Failing tests**

Append to `test/unit/validate.gates.test.js`:

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

Run: FAIL.

**Step 2: Implement gates**

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

Register both in `src/validate/index.js` ALL block.

**Step 3: Run**

`npm test` — 76 + 4 = 80 passing.

**Step 4: Commit**

```bash
git add src/validate/gates/recoveryIndex.js src/validate/gates/tsProject.js src/validate/index.js test/unit/validate.gates.test.js
git commit -m "feat(validate): recoveryIndex + tsProject gates"
```

---

## Task 6: CHANGELOG, README, push, PR

**Files:**
- Modify: `CHANGELOG.md` (new entry at top)
- Modify: `README.md` (extend the 3.x script recovery section to mention layers 4-6)

**Step 1: CHANGELOG**

Add at top of CHANGELOG (after `## [Unreleased]`):

```markdown
## PR 4 — Script Recovery Layers 4-6 (ccclassNamer + typeInferer + tsProjectEmitter)

- **Layer 4 (ccclassNamer):** extracts user-facing class name + UUID from `cclegacy._RF.push(...)` and `@ccclass(...)` decorator; renames minified class identifiers; strips engine-internal `_RF.push/pop` scaffolding; aggregates a per-module UUID map.
- **Layer 5 (typeInferer):** scans recovered scene/prefab JSON, resolves `__id__` references to engine types (`cc.Sprite` → `Sprite`) and `__uuid__` references to user ccclass names; emits a per-class field type table.
- **Layer 6 (tsProjectEmitter):** ts-morph + prettier driven emission of `assets/scripts/<bundle>/<className>.ts`, plus top-level `tsconfig.json` and `RECOVERY_INDEX.json` (uuid → ts file path).
- `engine3x.recoverScriptsLayered` now (a) collects already-recovered scene JSON to feed Layer 5, (b) emits the TS project alongside the legacy `.js` files, (c) accepts `options.scriptLayers` to cap the pipeline depth.
- New gates: `recoveryIndex` (UUID closure) and `tsProject` (presence + ts file count, informational).
- New deps: `ts-morph@^21.0.1`, `prettier@^3.0.0`.
```

**Step 2: README**

Extend the `### Script recovery (3.x)` section (added in PR 3) by appending Layers 4-6 to the numbered list, and add a paragraph about the TS project + RECOVERY_INDEX.

**Step 3: Tests + commit**

```bash
npm test  # expect 80 passing
git add CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 4 script recovery layers 4-6"
```

**Step 4: Push + PR**

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

Report PR URL + final test count.

---

## Per-task acceptance reminder

Before each commit:
1. Tests for that task pass.
2. Full suite passes (no regression).
3. Subagent reports any deviation.
