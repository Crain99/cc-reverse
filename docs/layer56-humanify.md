# Layer 5 / Layer 6 / Humanify

This document describes the final three stages of the 3.x script-recovery
pipeline: **Layer 5 (type inference)**, **Layer 6 (TS project emit)**, and
the optional **Layer 7 (humanify rename)**. It assumes you've read the
top-level pipeline overview in `src/core/cocos3x/scriptRecovery/`.

## Pipeline recap

```
chunk(s)                              Layer 0  recoverScriptsLayered
  └─ webcrack(unminify)  one-shot     pre-pass (chunk-level)
  └─ chunkSplitter                    Layer 1
     └─ esmRebuilder                  Layer 2
        └─ classRestorer              Layer 3  (skip webcrack if preminified)
           └─ ccclassNamer            Layer 4  (uuid + ccclass name)
              └─ typeInferer          Layer 5  (scene-driven field types)
                 └─ tsProjectEmitter  Layer 6  (.ts + .ts.meta + RECOVERY_INDEX)
                    └─ humanify       Layer 7  (opt-in identifier rename)
```

`recoverScriptsLayered` lives in `src/core/cocos3x/engine3x.js`. It loads
chunks from two source layouts:

- **Source A**: `src/chunks/*.js` — canonical 3.x web build.
- **Source B**: `subpackages/<bundle>/{game,index}.js` — WeChat / Bilibili
  mini-game layout. Hundreds of `System.register(...)` calls live here;
  without scanning subpackages the splitter sees zero modules and scenes
  fall back to the brown UnknownNode screen.

The webcrack(unminify) pre-pass runs once per chunk before splitting,
producing equivalent output to per-module unminify in a fraction of the
time (slgq main: 38 s vs. 14 min). Modules carry `preminified: true`
and Layer 3 skips its own webcrack hop.

## Layer 5 — typeInferer

`src/core/cocos3x/scriptRecovery/typeInferer.js`

**Purpose**: walk recovered scenes to learn the runtime type of each
`@property` field on each ccclass, so Layer 6 can emit accurate TS
type annotations.

**Inputs**:
- `modules[]` — Layer-4 output, each module carries `ccclassName` + `uuid`.
- `context.scenes` — array of recovered `.scene` JSON, collected by
  `collectRecoveredScenes(outputPath)`.

**Output**: same modules, with `mod.fieldTypes = { fieldName: typeStr }`
populated from observed scene-data shapes. The map is **partial** —
fields that never appear in a scene are left untyped.

**Heuristic**: `__type__` payloads on `@property` values yield
`Component`/`Node`/`SpriteFrame`/etc.; primitive scene values yield
`number`/`string`/`boolean`. Nested arrays infer element types from the
first non-null entry.

## Layer 6 — tsProjectEmitter

`src/core/cocos3x/scriptRecovery/tsProjectEmitter.js`

**Per-module pipeline**:
1. `babel-generator(mod.ast)` → JS source.
2. (only if `mod.fieldTypes` non-empty) lazy-init `ts-morph` and apply
   `prop.setType()` for matching field names.
3. (only if `CC_REVERSE_TS_FORMAT=1`) prettier format.
4. Write `<outRoot>/<bundle>/<className>.ts`.
5. Write `<outRoot>/<bundle>/<className>.ts.meta` with the **stable uuid
   captured from `_RF.push(module, uuid, name)`**. This uuid is the
   load-bearing field — scenes reference components via
   `__type__: "<uuid>"`, so this MUST match what the original bundle
   used. Without it, components in `game.scene` fall back to UnknownNode
   and the canvas renders as the brown clear-color.
6. Append `recoveryIndex[uuid] = { path, className }`.

**Final writes**:
- `<outRoot>/tsconfig.json` — TS config (target ES2020, decorators).
- `<outRoot>/RECOVERY_INDEX.json` — `{ uuid → { path, className } }` map,
  consumed by the `sceneCcclassCoverage` validate gate and useful for
  external tooling that needs to look up which file a scene reference
  resolves to.

**Performance notes**:
- Both `ts-morph` and `prettier` are heavy. `ts-morph` is lazy-loaded and
  skipped entirely when a module has no `fieldTypes` (the common case in
  mini-game bundles where the type-inferer didn't find scene-driven
  bindings). Prettier is OFF by default; opt in with
  `CC_REVERSE_TS_FORMAT=1` when the recovered TS will be hand-edited.
- On slgq (~970 modules) this fast path takes <1 s; with prettier it
  was ~16 min.

## Layer 7 — humanify (opt-in)

`src/core/cocos3x/scriptRecovery/humanify.js`

Drives the user-installed [`humanify`](https://github.com/jehna/humanify)
CLI to rename minified identifiers in-place inside `<outRoot>/assets/`.

```bash
# Local model (default)
node bin/cc-reverse.js humanify /path/to/out

# OpenAI-compatible
node bin/cc-reverse.js humanify /path/to/out \
  --provider openai --base-url https://... --api-key ... --model gpt-4o-mini
```

Returns `{ ok, reason, outDir }`. Failure modes:
- `humanify` binary not on `$PATH` → `reason: 'humanify not installed'`.
- Provider misconfigured → bubbles humanify's stderr.

The renamer only touches `assets/` to keep `_runtime/`, `_boot/`, and
adapters untouched.

## Validate gates added in PR #14

`src/validate/gates/`

- **`tsProject`** — confirms `<out>/assets/scripts/tsconfig.json` exists
  and counts `*.ts` files.
- **`recoveryIndex`** — confirms `RECOVERY_INDEX.json` is valid JSON.
- **`sceneCcclassCoverage`** — scans `assets/**/*.scene` for
  `"__type__":"<uuid>"` patterns (skipping `cc.*`), checks each uuid
  against `RECOVERY_INDEX.json` + walked `.ts.meta` uuids, reports
  `M scene(s); X/Y ccclass uuid refs resolved (Z%)`.

The coverage gate is **informational** (always returns ok) but its detail
string is surfaced in `RECOVERY_REPORT.md` under
"## Scene ccclass coverage" so a regression to the brown-screen pattern
is visible at a glance.

## Extension points

If you need to add a Layer or change emit shape:

- **Layer ordering** lives in
  `src/core/cocos3x/scriptRecovery/pipeline.js`. Each layer is a pure
  function `(ast, mod) => ast` (Layers 2/3) or `(modules, context) =>
  modules` (Layers 4/5).
- **emit shape**: `buildTsMeta(uuid, className)` is the single source of
  truth for the `.meta` JSON. The schema is pinned to
  `ver: '4.0.21'` (typescript importer in cocos-test-projects v3.8.7) —
  bumping the engine target may require updating it.
- **scene scan**: `collectRecoveredScenes(outputPath)` walks
  `<out>/assets/**/*.scene`. Add new scene-like extensions there if you
  need to support `.prefab` field inference too.
