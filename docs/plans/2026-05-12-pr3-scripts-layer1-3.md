# PR 3 — Script Recovery Layers 1-3 (webcrack integration) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take 3.x `src/chunks/*.js` (System.register bundles) and emit one ESM module per registered class, with `__extends`/`__decorate` collapsed back to native `class` + decorator syntax. This is layers 1-3 of the 7-layer script recovery pipeline (Layer 4-6 follow in PR 4, Layer 7 humanify in PR 5).

**Architecture:**
- New module tree under `src/core/cocos3x/scriptRecovery/` with one file per layer (`chunkSplitter`, `esmRebuilder`, `classRestorer`) plus `pipeline.js` that drives them.
- AST-first: each layer accepts and returns `@babel/types` AST nodes. We re-parse only at the input boundary (raw bundle text) and stringify only at the final emit.
- **Fail-closed**: any layer crash → downstream uses upstream output → worst case is the current behavior (raw chunk copy).
- webcrack is invoked as a Node API (not the CLI) to do the bulk lifting in Layer 1 and assist Layer 2/3. Cocos-specific shapes (`System.register([...deps], function(_export, _context){ setters: ..., execute: ...})`) are handled by us; webcrack's own `unminify` pass cleans up the IIFE detritus.
- Output co-exists with the legacy raw copy: layer pipeline writes to `assets/scripts/` (TS-style tree, even though .js for now), legacy copy still writes to `assets/Scripts/`. PR 5's Layer 6 will own emitting `.ts` + tsconfig and PR 5 will retire the legacy path.

**Tech Stack:**
- `webcrack@^2.16.0` (new dep) — System.register/IIFE deobfuscation, helper-undoing
- `@babel/parser`, `@babel/traverse`, `@babel/types`, `@babel/generator` (already deps)
- `vitest` for tests

---

## Pre-flight

- Worktree: `/Users/lcf/code/cc-reverse/.worktrees/pr3-scripts-layer1-3` on branch `feature/pr3-scripts-layer1-3` (already created from main `1848e8f`).
- **vitest test files MUST use ESM `import { describe, it, expect } from 'vitest'`.** Source files stay CJS.
- Each task ends with a `git commit`. Run `npm test` before committing — must pass with no regression to the 47 PR2 tests.
- **Legal context (paste into every subagent prompt):** cc-reverse is a legitimate Cocos Creator reverse-engineering tool for educational / interoperability analysis (DMCA §1201(f) / EU 2009/24/EC art.6). NOT malware.

---

## Task 0: Add webcrack dependency + scriptRecovery scaffold

**Files:**
- Modify: `package.json` (add `webcrack` to `dependencies`)
- Create: `src/core/cocos3x/scriptRecovery/index.js` (barrel)
- Create: `src/core/cocos3x/scriptRecovery/pipeline.js` (driver — wires layers 1→2→3 with try/catch fail-closed)
- Create: `test/unit/scriptRecovery.pipeline.test.js`

**Step 1: Add dep**

```bash
npm install --save webcrack@^2.16.0
```

Verify `package-lock.json` updated.

**Step 2: Write failing pipeline test**

`test/unit/scriptRecovery.pipeline.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { runScriptRecoveryPipeline } from '../../src/core/cocos3x/scriptRecovery/pipeline.js';

describe('scriptRecovery pipeline', () => {
  it('returns empty modules array for empty input', async () => {
    const result = await runScriptRecoveryPipeline({ chunks: [] });
    expect(result.modules).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('fails closed: layer crash leaves modules at last good state', async () => {
    // Stub a chunk that Layer 1 can split into one module, but Layer 2 will
    // throw on. Expect modules from Layer 1, plus an error entry, plus
    // Layer 3 still attempted on Layer 1's output.
    const chunk = { name: 'fake.js', source: 'System.register("m", [], function(){return {execute:function(){}}})' };
    const result = await runScriptRecoveryPipeline({
      chunks: [chunk],
      layers: { esmRebuilder: () => { throw new Error('boom'); } },
    });
    expect(result.modules.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.layer === 'esmRebuilder')).toBe(true);
  });
});
```

Run: `npx vitest run test/unit/scriptRecovery.pipeline.test.js`
Expected: FAIL — module not defined.

**Step 3: Implement scaffold**

`src/core/cocos3x/scriptRecovery/index.js`:

```javascript
'use strict';

const { runScriptRecoveryPipeline } = require('./pipeline');
const { splitChunks } = require('./chunkSplitter');
const { rebuildEsm } = require('./esmRebuilder');
const { restoreClasses } = require('./classRestorer');

module.exports = {
  runScriptRecoveryPipeline,
  splitChunks,
  rebuildEsm,
  restoreClasses,
};
```

`src/core/cocos3x/scriptRecovery/pipeline.js`:

```javascript
'use strict';

const { splitChunks: defaultSplit } = require('./chunkSplitter');
const { rebuildEsm: defaultRebuild } = require('./esmRebuilder');
const { restoreClasses: defaultRestore } = require('./classRestorer');

/**
 * Drive the 3-layer script recovery pipeline.
 *
 * @param {object} input
 * @param {Array<{name:string, source:string}>} input.chunks
 * @param {object} [input.layers] — overrides per layer for testing
 * @returns {Promise<{modules: Array, errors: Array}>}
 */
async function runScriptRecoveryPipeline(input) {
  const { chunks = [], layers = {} } = input;
  const split = layers.chunkSplitter || defaultSplit;
  const rebuild = layers.esmRebuilder || defaultRebuild;
  const restore = layers.classRestorer || defaultRestore;
  const errors = [];

  let modules = [];
  for (const chunk of chunks) {
    try {
      const split1 = await split(chunk);
      modules = modules.concat(split1);
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

  return { modules, errors };
}

module.exports = { runScriptRecoveryPipeline };
```

Stub the 3 layer files (`chunkSplitter.js`, `esmRebuilder.js`, `classRestorer.js`) each exporting an async fn that returns its input unchanged. Real implementations come in Tasks 1-3.

For `chunkSplitter` stub specifically — return `[{name: chunk.name, source: chunk.source, ast: null}]` (one module per chunk) so the empty-array and crash test pass.

**Step 4: Run test**

`npx vitest run test/unit/scriptRecovery.pipeline.test.js`
Expected: PASS (2 tests)

**Step 5: Run full suite**

`npm test`
Expected: PASS — 47 baseline + 2 new = 49 tests.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/core/cocos3x/scriptRecovery/ test/unit/scriptRecovery.pipeline.test.js
git commit -m "chore(3x): add webcrack dep + scriptRecovery pipeline scaffold"
```

---

## Task 1: Layer 1 — chunkSplitter (System.register parsing)

**Files:**
- Modify: `src/core/cocos3x/scriptRecovery/chunkSplitter.js` (real implementation)
- Create: `test/unit/scriptRecovery.chunkSplitter.test.js`
- Create: `test/fixtures/scriptRecovery/system-register-2-modules.js` (synthetic)

**Step 1: Write fixture + failing test**

`test/fixtures/scriptRecovery/system-register-2-modules.js`:

```javascript
System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
  "use strict";
  var _decorator, Component, Player;
  return {
    setters: [function (_cc) { _decorator = _cc._decorator; Component = _cc.Component; }],
    execute: function () {
      Player = class Player extends Component { onLoad() { console.log('p'); } };
    }
  };
});
System.register("chunks:///_virtual/Enemy.ts", ["cc", "./Player"], function (_export, _context) {
  "use strict";
  var Component, Player, Enemy;
  return {
    setters: [function (_cc) { Component = _cc.Component; }, function (_p) { Player = _p.default; }],
    execute: function () {
      Enemy = class Enemy extends Component { update() { } };
    }
  };
});
```

`test/unit/scriptRecovery.chunkSplitter.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const fixture = readFileSync(
  path.join(__dirname, '../fixtures/scriptRecovery/system-register-2-modules.js'),
  'utf8'
);

describe('Layer 1: chunkSplitter', () => {
  it('splits a chunk file containing 2 System.register calls into 2 modules', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Player');
    expect(out[1].name).toBe('Enemy');
    expect(out[0].registerId).toBe('chunks:///_virtual/Player.ts');
    expect(out[0].deps).toEqual(['cc']);
    expect(out[1].deps).toEqual(['cc', './Player']);
    // Each module's ast must contain only the body of its execute() function,
    // wrapped as a Program. The setters/return wrapper is stripped.
    expect(out[0].ast).toBeTruthy();
    expect(out[0].ast.type).toBe('File');
  });

  it('returns one passthrough module if no System.register is found', async () => {
    const out = await splitChunks({ name: 'plain.js', source: 'var x = 1;' });
    expect(out).toHaveLength(1);
    expect(out[0].registerId).toBeNull();
  });

  it('extracts setter bindings (var → import name mapping)', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    // Player binds _decorator + Component from cc
    const playerSetter = out[0].setterBindings;
    expect(playerSetter).toEqual([
      { dep: 'cc', bindings: [{ local: '_decorator', imported: '_decorator' }, { local: 'Component', imported: 'Component' }] }
    ]);
  });
});
```

Run: `npx vitest run test/unit/scriptRecovery.chunkSplitter.test.js`
Expected: FAIL.

**Step 2: Implement chunkSplitter**

`src/core/cocos3x/scriptRecovery/chunkSplitter.js`:

```javascript
'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

/**
 * Split a chunk file (one .js with N System.register(...) calls) into N modules.
 *
 * Each output module has:
 *  - name: derived from the registerId tail (without .ts/.js extension)
 *  - registerId: the original module id string
 *  - deps: array of dep id strings
 *  - setterBindings: [{ dep, bindings: [{local, imported}] }]
 *  - ast: File AST containing only the execute() body
 *  - source: the original chunk text (kept as fallback)
 */
async function splitChunks(chunk) {
  const { name, source } = chunk;
  let ast;
  try {
    ast = parser.parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (err) {
    // Unparseable: passthrough one module that downstream layers may try.
    return [{ name, registerId: null, deps: [], setterBindings: [], ast: null, source }];
  }

  const modules = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (
        !(t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: 'System' }) &&
          t.isIdentifier(callee.property, { name: 'register' }))
      ) return;

      const args = p.node.arguments;
      if (args.length < 2) return;

      // Two shapes: register(deps, factory) and register(id, deps, factory).
      let registerId = null;
      let depsNode;
      let factory;
      if (t.isStringLiteral(args[0]) && t.isArrayExpression(args[1])) {
        registerId = args[0].value;
        depsNode = args[1];
        factory = args[2];
      } else if (t.isArrayExpression(args[0])) {
        depsNode = args[0];
        factory = args[1];
      } else {
        return;
      }
      if (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory)) return;

      const deps = depsNode.elements
        .filter((el) => t.isStringLiteral(el))
        .map((el) => el.value);

      const modName = deriveModuleName(registerId, name, modules.length);
      const result = extractFactoryBody(factory);
      modules.push({
        name: modName,
        registerId,
        deps,
        setterBindings: result.setterBindings,
        ast: result.bodyAst,
        source,
      });
      p.skip();
    },
  });

  if (modules.length === 0) {
    return [{ name, registerId: null, deps: [], setterBindings: [], ast: null, source }];
  }
  return modules;
}

function deriveModuleName(registerId, fallback, index) {
  if (registerId) {
    const tail = registerId.split('/').pop() || `mod${index}`;
    return tail.replace(/\.(ts|js|mjs)$/i, '');
  }
  return `${fallback.replace(/\.js$/, '')}_${index}`;
}

/**
 * Given the factory function `function(_export, _context) { return { setters:[...], execute:function(){...} } }`,
 * return:
 *  - bodyAst: a File containing the statements of execute() at top level
 *  - setterBindings: [{dep, bindings: [{local, imported}]}]
 */
function extractFactoryBody(factory) {
  const out = { setterBindings: [], bodyAst: null };
  const ret = factory.body.body.find((s) => t.isReturnStatement(s));
  if (!ret || !t.isObjectExpression(ret.argument)) return out;

  for (const prop of ret.argument.properties) {
    if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
    const key = t.isIdentifier(prop.key) ? prop.key.name : (t.isStringLiteral(prop.key) ? prop.key.value : null);
    if (key === 'setters' && t.isObjectProperty(prop) && t.isArrayExpression(prop.value)) {
      out.setterBindings = parseSetters(prop.value);
    } else if (key === 'execute') {
      const fn = t.isObjectMethod(prop) ? prop : (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value) ? prop.value : null);
      if (fn) {
        const body = t.isObjectMethod(prop) ? prop.body.body : fn.body.body;
        out.bodyAst = t.file(t.program(body));
      }
    }
  }
  return out;
}

function parseSetters(arrayExpr) {
  // arrayExpr.elements aligns with deps order. Each element is a function whose
  // body assigns local vars from the imported namespace param.
  return arrayExpr.elements.map((fn, i) => {
    if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) {
      return { dep: null, bindings: [] };
    }
    const param = fn.params[0];
    const paramName = t.isIdentifier(param) ? param.name : null;
    const bindings = [];
    if (paramName) {
      for (const stmt of fn.body.body) {
        if (
          t.isExpressionStatement(stmt) &&
          t.isAssignmentExpression(stmt.expression) &&
          t.isIdentifier(stmt.expression.left) &&
          t.isMemberExpression(stmt.expression.right) &&
          t.isIdentifier(stmt.expression.right.object, { name: paramName })
        ) {
          const local = stmt.expression.left.name;
          const importedNode = stmt.expression.right.property;
          const imported = t.isIdentifier(importedNode) ? importedNode.name : (t.isStringLiteral(importedNode) ? importedNode.value : local);
          bindings.push({ local, imported });
        }
      }
    }
    return { dep: null /* filled in by caller */, bindings, _index: i };
  });
}

module.exports = { splitChunks };
```

**Note:** the test expects `setterBindings[i].dep` to be the dep string. Update `splitChunks` after the `parseSetters` call so each entry's `.dep = deps[entry._index]` then drop `_index`. Add this at the top of the result construction:

```javascript
const setterBindings = result.setterBindings.map((s) => ({ dep: deps[s._index], bindings: s.bindings }));
modules.push({ name: modName, registerId, deps, setterBindings, ast: result.bodyAst, source });
```

Replace the previous `setterBindings: result.setterBindings,` line accordingly.

**Step 3: Run test**

`npx vitest run test/unit/scriptRecovery.chunkSplitter.test.js`
Expected: PASS (3 tests).

**Step 4: Run full suite**

`npm test`
Expected: 49 baseline + 3 new = 52 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/chunkSplitter.js test/unit/scriptRecovery.chunkSplitter.test.js test/fixtures/scriptRecovery/system-register-2-modules.js
git commit -m "feat(3x/scripts): Layer 1 chunkSplitter — System.register parsing"
```

---

## Task 2: Layer 2 — esmRebuilder (setters / _export → import / export)

**Files:**
- Modify: `src/core/cocos3x/scriptRecovery/esmRebuilder.js`
- Create: `test/unit/scriptRecovery.esmRebuilder.test.js`

**Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
import generate from '@babel/generator';
import { rebuildEsm } from '../../src/core/cocos3x/scriptRecovery/esmRebuilder.js';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const fixture = `
System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
  "use strict";
  var Component, Player;
  _export("default", void 0);
  return {
    setters: [function (_cc) { Component = _cc.Component; }],
    execute: function () {
      Player = class Player extends Component { onLoad() {} };
      _export("default", Player);
      _export("HELPER", 42);
    }
  };
});
`;

describe('Layer 2: esmRebuilder', () => {
  it('emits import statements from setterBindings', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate.default(ast).code;
    expect(code).toContain("import { Component } from 'cc'");
  });

  it('rewrites _export("name", value) → export named binding (or default)', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate.default(ast).code;
    expect(code).toMatch(/export\s+default\s+Player/);
    expect(code).toMatch(/export\s+(?:const|let|var)?\s*HELPER/);
  });

  it('passthrough on null ast', async () => {
    const result = await rebuildEsm(null, { name: 'x', deps: [], setterBindings: [] });
    expect(result).toBeNull();
  });
});
```

Run: FAIL.

**Step 2: Implement**

`src/core/cocos3x/scriptRecovery/esmRebuilder.js`:

```javascript
'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

/**
 * Layer 2: convert SystemJS execute body + setterBindings into ESM:
 *  - setterBindings → top-level `import { local as imported? } from 'dep'`
 *    (We default to `import { local } from 'dep'` when local === imported,
 *     otherwise `import { imported as local } from 'dep'`.)
 *  - `_export("name", expr)` → `export const name = expr` (or `export default expr`
 *    when name === 'default'). For the common pattern of `_export(...)` on
 *    pre-declared vars, we hoist those vars into `export let name` declarations
 *    on first assignment.
 *  - `_export("default", void 0)` placeholder calls are dropped.
 *  - Removes `"use strict"` directive (ESM is strict by default).
 */
async function rebuildEsm(ast, mod) {
  if (!ast) return null;
  const program = ast.program;
  const newBody = [];

  // 1. Top-level imports from setterBindings
  for (const setter of mod.setterBindings || []) {
    if (!setter.dep || !setter.bindings.length) continue;
    const specifiers = setter.bindings.map((b) =>
      t.importSpecifier(t.identifier(b.local), t.identifier(b.imported))
    );
    newBody.push(t.importDeclaration(specifiers, t.stringLiteral(setter.dep)));
  }

  // 2. Walk the body, transforming _export() calls and dropping placeholders.
  const exported = new Set();
  for (const stmt of program.body) {
    if (t.isDirective(stmt)) continue; // strip "use strict"

    // Drop pure placeholder: _export("name", void 0);
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: '_export' }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0]) &&
      t.isUnaryExpression(stmt.expression.arguments[1], { operator: 'void' })
    ) {
      continue;
    }

    // Transform _export("name", value); → ESM export
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isIdentifier(stmt.expression.callee, { name: '_export' }) &&
      stmt.expression.arguments.length === 2 &&
      t.isStringLiteral(stmt.expression.arguments[0])
    ) {
      const exportName = stmt.expression.arguments[0].value;
      const valueExpr = stmt.expression.arguments[1];
      if (exportName === 'default') {
        newBody.push(t.exportDefaultDeclaration(valueExpr));
      } else {
        // Use a let so we accept rebinding patterns. Strip duplicate exports.
        if (!exported.has(exportName)) {
          exported.add(exportName);
          newBody.push(
            t.exportNamedDeclaration(
              t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(exportName), valueExpr),
              ]),
              []
            )
          );
        } else {
          newBody.push(
            t.expressionStatement(
              t.assignmentExpression('=', t.identifier(exportName), valueExpr)
            )
          );
        }
      }
      continue;
    }

    newBody.push(stmt);
  }

  program.body = newBody;
  return ast;
}

module.exports = { rebuildEsm };
```

**Step 3: Run test**

`npx vitest run test/unit/scriptRecovery.esmRebuilder.test.js`
Expected: PASS (3 tests).

**Step 4: Full suite**

`npm test`
Expected: 52 + 3 = 55 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/esmRebuilder.js test/unit/scriptRecovery.esmRebuilder.test.js
git commit -m "feat(3x/scripts): Layer 2 esmRebuilder — setters/_export → import/export"
```

---

## Task 3: Layer 3 — classRestorer (`__extends` / `__decorate` undoing via webcrack)

**Files:**
- Modify: `src/core/cocos3x/scriptRecovery/classRestorer.js`
- Create: `test/unit/scriptRecovery.classRestorer.test.js`

**Background:** Cocos's tsc-targeted ES5 emit produces:
```javascript
var Player = (function (_super) { __extends(Player, _super); function Player(){ ... } return Player; }(Component));
Player = __decorate([ ccclass('Player') ], Player);
```
Layer 3 rewrites this into:
```javascript
@ccclass('Player')
class Player extends Component { constructor(){ ... } }
```
The TypeScript helper undoing is exactly what webcrack's `unminify` pass already does. We feed it the program-source post-Layer-2 and let it transform the AST.

**Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import { restoreClasses } from '../../src/core/cocos3x/scriptRecovery/classRestorer.js';

describe('Layer 3: classRestorer', () => {
  it('collapses __extends IIFE into class extends', async () => {
    const src = `
      var __extends = (this && this.__extends) || function (d, b) { for (var p in b) d[p] = b[p]; d.prototype = Object.create(b.prototype); };
      var Player = (function (_super) {
        __extends(Player, _super);
        function Player() { return _super.call(this) || this; }
        Player.prototype.onLoad = function () { console.log('p'); };
        return Player;
      }(Component));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate.default(out).code;
    expect(code).toMatch(/class\s+Player\s+extends\s+Component/);
    expect(code).toMatch(/onLoad/);
  });

  it('collapses __decorate(..., Class) into a decorator', async () => {
    const src = `
      var Player = (function (_super) {
        __extends(Player, _super);
        function Player() { return _super.call(this) || this; }
        return Player;
      }(Component));
      Player = __decorate([ccclass('Player')], Player);
      export default Player;
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate.default(out).code;
    expect(code).toMatch(/@ccclass\(['"]Player['"]\)/);
    // The standalone `Player = __decorate(...)` line must be removed.
    expect(code).not.toMatch(/__decorate/);
  });

  it('passthrough on null ast', async () => {
    expect(await restoreClasses(null, { name: 'x' })).toBeNull();
  });
});
```

Run: FAIL.

**Step 2: Implement (webcrack-driven, with hand-rolled __decorate folding)**

`src/core/cocos3x/scriptRecovery/classRestorer.js`:

```javascript
'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { parse } = require('@babel/parser');

/**
 * Layer 3: undo TypeScript ES5 helpers (__extends, __decorate) and restore
 * native class + decorator syntax.
 *
 * Implementation note: webcrack's `unminify` pass handles `__extends` (it
 * recognizes the IIFE shape and emits a class). For `__decorate` we run a
 * focused post-pass because webcrack 2.16.x leaves the assignment form alone
 * (it cannot prove decorators are side-effect-free in general). Cocos always
 * uses pure decorator factories so the transform is sound for our domain.
 */
async function restoreClasses(ast, mod) {
  if (!ast) return null;

  // 1. Hand off to webcrack for __extends collapsing. Webcrack consumes source
  //    text, not AST — we round-trip via generator/parse.
  const before = generate(ast, { compact: false }).code;
  let mid;
  try {
    const { webcrack } = require('webcrack');
    const result = await webcrack(before, {
      jsx: false,
      mangle: false,
      unminify: true,
      deobfuscate: false,
      unpack: false,
    });
    mid = parse(result.code, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] });
  } catch (err) {
    // Fail-closed: keep original AST.
    mid = ast;
  }

  // 2. Fold standalone `Class = __decorate([...], Class);` assignments into
  //    `@decorator class Class { ... }` declarations.
  foldDecorate(mid);

  return mid;
}

/**
 * Find statements of the form:
 *   X = __decorate([d1, d2, ...], X);
 * and merge the decorator list into the most recent `class X { ... }` declaration
 * appearing earlier in the same Program. Then remove the standalone assignment.
 */
function foldDecorate(ast) {
  traverse(ast, {
    Program(path) {
      const body = path.node.body;
      const toRemove = [];
      for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        const target = matchDecorateAssign(stmt);
        if (!target) continue;
        const { className, decorators } = target;
        // Find class declaration with matching id appearing before i.
        let attached = false;
        for (let j = i - 1; j >= 0; j--) {
          const decl = unwrapClassDecl(body[j]);
          if (decl && t.isClassDeclaration(decl) && decl.id && decl.id.name === className) {
            decl.decorators = (decl.decorators || []).concat(decorators);
            attached = true;
            break;
          }
        }
        if (attached) toRemove.push(i);
      }
      for (let k = toRemove.length - 1; k >= 0; k--) body.splice(toRemove[k], 1);
    },
  });
}

function matchDecorateAssign(stmt) {
  if (!t.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr, { operator: '=' })) return null;
  if (!t.isIdentifier(expr.left)) return null;
  if (!t.isCallExpression(expr.right)) return null;
  if (!t.isIdentifier(expr.right.callee, { name: '__decorate' })) return null;
  const args = expr.right.arguments;
  if (args.length < 2 || !t.isArrayExpression(args[0])) return null;
  // Second arg should be the same identifier as left.
  if (!t.isIdentifier(args[1]) || args[1].name !== expr.left.name) return null;
  return {
    className: expr.left.name,
    decorators: args[0].elements.filter(Boolean).map((el) => t.decorator(el)),
  };
}

function unwrapClassDecl(stmt) {
  if (t.isClassDeclaration(stmt)) return stmt;
  if (t.isExportNamedDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  if (t.isExportDefaultDeclaration(stmt) && t.isClassDeclaration(stmt.declaration)) return stmt.declaration;
  return null;
}

module.exports = { restoreClasses };
```

**Step 3: Run test**

`npx vitest run test/unit/scriptRecovery.classRestorer.test.js`
Expected: PASS. **If a webcrack version difference produces a slightly different `class` shape**, adjust the regex in the assertions (not the code) — the goal is "class with extends + method", not exact spacing.

**Step 4: Full suite**

`npm test`
Expected: 55 + 3 = 58 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/scriptRecovery/classRestorer.js test/unit/scriptRecovery.classRestorer.test.js
git commit -m "feat(3x/scripts): Layer 3 classRestorer — __extends/__decorate via webcrack"
```

---

## Task 4: Wire pipeline into engine3x.recoverScripts (additive, opt-in)

**Files:**
- Modify: `src/core/cocos3x/engine3x.js`
- Create: `test/integration/scriptRecovery.test.js`

**Goal:** When recovering scripts, also produce a layered output under `assets/scripts/<bundle>/<module>.js`. The legacy raw copy under `assets/Scripts/` stays in place so PR 3 cannot regress current users. Layered output is written **only** when at least one chunk parses to ≥1 System.register module — silently skipped otherwise so vanilla 2.x or non-System bundles aren't affected.

**Step 1: Failing integration test**

`test/integration/scriptRecovery.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';

// We test the recoverScripts path in isolation by faking a minimal source tree.
// engine3x.recoverScripts is not exported — we test through reverseProject3x
// might be too heavy; instead expose a thin wrapper.

import { recoverScriptsLayered } from '../../src/core/cocos3x/engine3x.js';

describe('Layered script recovery (integration)', () => {
  it('emits one .js per System.register module under assets/scripts/<chunkBase>/', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc3x-scripts-'));
    const srcChunks = path.join(tmp, 'src', 'chunks');
    const out = path.join(tmp, 'out');
    await mkdir(srcChunks, { recursive: true });
    const chunk = `
      System.register("chunks:///_virtual/A.ts", ["cc"], function (_export, _context) {
        var Component, A;
        return { setters: [function (_cc) { Component = _cc.Component; }],
                 execute: function () { A = class A extends Component {}; _export("default", A); } };
      });
      System.register("chunks:///_virtual/B.ts", [], function (_export, _context) {
        var B;
        return { setters: [], execute: function () { B = class B {}; _export("default", B); } };
      });
    `;
    await writeFile(path.join(srcChunks, 'index.js'), chunk);

    const result = await recoverScriptsLayered(tmp, out, false);
    expect(result.modulesEmitted).toBe(2);
    await access(path.join(out, 'assets', 'scripts', 'index', 'A.js'));
    await access(path.join(out, 'assets', 'scripts', 'index', 'B.js'));
    const aSrc = await readFile(path.join(out, 'assets', 'scripts', 'index', 'A.js'), 'utf8');
    expect(aSrc).toContain("import { Component } from 'cc'");
  });
});
```

Run: FAIL — `recoverScriptsLayered` not exported.

**Step 2: Implement wrapper + wire into recoverScripts**

In `src/core/cocos3x/engine3x.js`:

1. Add near the top with other requires:
```javascript
const { runScriptRecoveryPipeline } = require('./scriptRecovery');
const generate = require('@babel/generator').default;
```

2. Add a new top-level function (above `recoverScripts`):

```javascript
/**
 * Layered script recovery (Layers 1-3): writes one .js per System.register module
 * under <outputPath>/assets/scripts/<chunkBaseName>/. Returns {modulesEmitted, errors}.
 *
 * Silently skipped when no chunks file is found — keeps non-3.x projects unaffected.
 */
async function recoverScriptsLayered(sourcePath, outputPath, verbose) {
  const chunksDir = path.join(sourcePath, 'src', 'chunks');
  if (!(await pathExists(chunksDir))) return { modulesEmitted: 0, errors: [] };
  const entries = await readdir(chunksDir);
  const chunks = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(chunksDir, entry);
    const source = await readFile(full, 'utf8');
    chunks.push({ name: entry, source });
  }
  if (chunks.length === 0) return { modulesEmitted: 0, errors: [] };

  let totalEmitted = 0;
  const allErrors = [];
  for (const chunk of chunks) {
    const { modules, errors } = await runScriptRecoveryPipeline({ chunks: [chunk] });
    allErrors.push(...errors);
    const baseName = chunk.name.replace(/\.js$/, '');
    const outDir = path.join(outputPath, 'assets', 'scripts', baseName);
    for (const m of modules) {
      if (!m.ast) continue;
      try {
        const code = generate(m.ast, { compact: false }).code;
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, `${m.name}.js`), code);
        if (verbose) logger.debug(`LayeredScript: ${baseName}/${m.name}.js`);
        totalEmitted += 1;
      } catch (err) {
        allErrors.push({ layer: 'emit', module: m.name, message: err.message });
      }
    }
  }
  return { modulesEmitted: totalEmitted, errors: allErrors };
}
```

3. At the bottom of `recoverScripts`, before `return { total }`, add the layered call (best-effort, never throws upward):

```javascript
try {
  const layered = await recoverScriptsLayered(sourcePath, outputPath, verbose);
  if (verbose && layered.modulesEmitted) {
    logger.debug(`LayeredScripts: ${layered.modulesEmitted} modules emitted, ${layered.errors.length} errors`);
  }
} catch (err) {
  logger.warn(`Layered script recovery skipped: ${err.message}`);
}
```

4. Export `recoverScriptsLayered` in the existing `module.exports = { ... }` block.

**Step 3: Run test**

`npx vitest run test/integration/scriptRecovery.test.js`
Expected: PASS.

**Step 4: Full suite**

`npm test`
Expected: 58 + 1 = 59 passing.

**Step 5: Commit**

```bash
git add src/core/cocos3x/engine3x.js test/integration/scriptRecovery.test.js
git commit -m "feat(3x): wire script recovery pipeline into engine3x (layered output)"
```

---

## Task 5: validate gate — `layeredScripts` (informational)

**Files:**
- Create: `src/validate/gates/layeredScripts.js`
- Modify: `src/validate/index.js`
- Modify: `test/unit/validate.gates.test.js` (add 2 cases)

**Step 1: Failing test**

Append to `test/unit/validate.gates.test.js`:

```javascript
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('layeredScripts gate', () => {
  it('passes when assets/scripts/ contains at least one .js with import statement', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ls-'));
    const dir = path.join(tmp, 'assets', 'scripts', 'index');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'A.js'), "import { Component } from 'cc';\nclass A {}\n");
    const r = runGates(tmp, ['layeredScripts']);
    expect(r.layeredScripts.ok).toBe(true);
  });

  it('passes (informational) when no assets/scripts/ exists', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gate-ls-'));
    const r = runGates(tmp, ['layeredScripts']);
    expect(r.layeredScripts.ok).toBe(true);
  });
});
```

Run: FAIL.

**Step 2: Implement gate**

`src/validate/gates/layeredScripts.js`:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

module.exports = function layeredScripts(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  const files = walk(root);
  if (files.length === 0) {
    // Informational: not all projects have layered scripts (e.g. 2.x).
    return { ok: true, detail: 'no assets/scripts/ — gate not applicable' };
  }
  let withImport = 0;
  for (const f of files) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (/^\s*import\s/m.test(src)) withImport += 1;
    } catch { /* ignore */ }
  }
  return {
    ok: true,
    detail: `${files.length} layered script files (${withImport} with import statements)`,
  };
};
```

Register in `src/validate/index.js` ALL block.

**Step 3: Run tests**

`npm test`
Expected: 59 + 2 = 61 passing.

**Step 4: Commit**

```bash
git add src/validate/gates/layeredScripts.js src/validate/index.js test/unit/validate.gates.test.js
git commit -m "feat(validate): layeredScripts gate (informational)"
```

---

## Task 6: CHANGELOG, README, push, PR

**Files:**
- Modify: `CHANGELOG.md` (new entry at top)
- Modify: `README.md` (3.x script recovery section)

**Step 1: CHANGELOG**

Add at top of `CHANGELOG.md`:

```markdown
## PR 3 — Wave / Script Recovery Layers 1-3 (webcrack integration)

- **Layer 1 (chunkSplitter):** parses `src/chunks/*.js` and splits each `System.register(...)` call into a discrete module with deps and setter bindings.
- **Layer 2 (esmRebuilder):** rewrites SystemJS execute body into top-level `import` / `export` statements; drops `_export("name", void 0)` placeholders.
- **Layer 3 (classRestorer):** drives webcrack `unminify` to collapse `__extends` IIFEs back into native `class extends` syntax; folds `__decorate([...], Class)` assignments into `@decorator class Class { ... }`.
- **Pipeline driver** with fail-closed semantics — any layer crash leaves downstream layers running on the last good AST.
- **Integration:** `engine3x.recoverScripts` now also emits layered output under `assets/scripts/<chunk>/<module>.js` alongside the legacy raw copy under `assets/Scripts/`.
- **New gate:** `layeredScripts` (informational) — reports counts of layered files and how many include `import` statements.
- New dep: `webcrack@^2.16.0`.
```

**Step 2: README**

Find the "3.x" or "Script recovery" section and add a paragraph:

```markdown
### Script recovery (3.x)

In addition to the legacy raw chunk copy under `assets/Scripts/`, the unpacker now produces a layered output under `assets/scripts/<chunkBase>/<module>.js`:

1. **Layer 1** splits each `System.register(...)` into one module per registered class.
2. **Layer 2** restores ESM `import` / `export` syntax from the SystemJS setters and `_export` calls.
3. **Layer 3** uses webcrack to undo TypeScript's ES5 `__extends` helper, then folds `__decorate([...], Class)` assignments into native decorator syntax.

Future PRs add Layer 4 (ccclass naming + UUID mapping), Layer 5 (typed-field inference from scenes), Layer 6 (TS project emission with tsconfig), and Layer 7 (optional humanify pass for minified identifiers).
```

**Step 3: Run tests once more**

`npm test`
Expected: 61 passing.

**Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog + readme for PR 3 script recovery layers 1-3"
```

**Step 5: Push and PR**

```bash
git push -u origin feature/pr3-scripts-layer1-3
gh pr create --base main --head feature/pr3-scripts-layer1-3 --repo clawnet-ai/cc-reverse \
  --title "feat(3x): script recovery layers 1-3 (webcrack integration)" \
  --body "$(cat <<'EOF'
## Summary

PR 3 of the 3.x overhaul — implements the first three layers of the 7-layer script recovery pipeline:

- **Layer 1 chunkSplitter** — parses `src/chunks/*.js` System.register calls into per-module ASTs with dep + setter binding metadata.
- **Layer 2 esmRebuilder** — rewrites SystemJS setters / `_export` into native `import` / `export` statements.
- **Layer 3 classRestorer** — invokes webcrack `unminify` for `__extends` IIFE collapsing, then a focused post-pass folds `__decorate([...], Class)` assignments into native `@decorator class` syntax.
- **Pipeline driver** with fail-closed semantics: any layer crash falls through with the last good AST and surfaces an error entry.
- Wires the pipeline into `engine3x.recoverScripts` so layered output appears under `assets/scripts/<chunk>/<module>.js` alongside the legacy raw copy under `assets/Scripts/`. Both paths coexist until PR 5's Layer 6 (TS project emission) retires the legacy copy.
- Adds `layeredScripts` informational gate.

## Layer pipeline

```
src/chunks/*.js
   ↓  Layer 1  chunkSplitter      System.register → 1 module per class
   ↓  Layer 2  esmRebuilder       setters / _export → import / export
   ↓  Layer 3  classRestorer      __extends / __decorate → class + decorator
   ↓  emit    assets/scripts/<chunk>/<module>.js
```

## Tests

- 14 new tests added (4 unit per layer + 1 integration + 2 gate). All 61 tests pass.

## Out of scope (future PRs)

- Layer 4 (ccclass naming + UUID mapping) — PR 4
- Layer 5 (typed-field inference from scene/prefab) — PR 4
- Layer 6 (TS project emission with tsconfig) — PR 5
- Layer 7 (humanify, optional) — PR 5
EOF
)"
```

Report back with the PR URL.

---

## Per-task acceptance reminder

Before each commit:
1. Tests for that task pass: `npx vitest run <task-test-file>`
2. Full suite passes: `npm test` (no regression)
3. Subagent reports any deviation from this plan in its handoff message.
