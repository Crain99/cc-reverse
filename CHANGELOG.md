# Changelog

All notable changes to cc-reverse are documented here.
The format is based on Keep a Changelog.

## [Unreleased]

## PR 8 — E2E harness + CLI dispatch fix + 首轮 golden 基线

- **fix(report): align RECOVERY_REPORT declared count with filesystem.** `engine3x.writeRecoveryReport` now reconciles bundle-summary totals against a recursive non-`.meta` file count under `<out>/assets`, emitting an `__extras__` row when the bundle counter undercounts (recovered scripts, internal sub-assets, etc.). Resolves the `declared N vs actual M` failures on `slgq-reverse` (45 vs 62) and `cgxfd-reverse` (29 vs 33). Tests in `test/unit/3x-recoveryReport-declared.test.js`.
- **fix(2x): emit `RECOVERY_REPORT.md` for cocos2x flow.** New `src/core/cocos2x/recoveryReport2x.js` writes a single-section markdown report whose declared count matches disk; wired into `reverseEngine.js` after `projectGenerator.generateProject()`. Resolves `RECOVERY_REPORT.md missing` on `dabaoyiqie-reverse`. Tests in `test/unit/2x-recoveryReport.test.js`. Post-fix: `npm test` 131 pass (was 123); `npm run e2e` all three samples 6/6 gates.
- **CLI dispatch fix (`src/index.js`):** root program now has an `.action()` handler so `node bin/cc-reverse.js -p <path> -o <out>` actually enters `reverseProject` instead of silently printing `--help` (commander v11 requires an explicit root action when subcommands are registered). `--path` validation and the `CC_SOURCE_PATH` env var fallback are preserved.
- **`validate` subcommand:** registered on the root program (`cc-reverse validate <outDir>`) as a unified entry point alongside the existing `bin/validate.js` shim, which is kept for back-compat.
- **E2E harness (`test/e2e/`):**
  - `run-sample.js` — `runSample(samplePath, outBase)` shells out to the CLI for both unpack and `validate`, writing a combined `.e2e-report.json`.
  - `golden.test.js` — vitest-parameterised over three real samples under `~/mini/` (slgq-reverse / dabaoyiqie-reverse / cgxfd-reverse). Missing samples are gracefully `test.skip`'d so CI and other dev machines don't break. Asserts only that unpack exits 0; quality-gate regressions (a baseline-`passed` gate now failing) fail the test, improvements emit a console warning.
  - `test/baselines/.gitkeep` — placeholder; first-run manifests are written to `<out>/.suggested-baseline.json` for human review before commit.
- **First baseline report:** `docs/e2e-baseline-report-2026-05-12.md` — captures real numbers from all three samples (5/6 gates pass each; only `recoveryReport` declared-vs-actual asset count mismatch remains as a known gap).
- **README:** added "Running E2E (golden samples)" section documenting the `~/mini/<sample>` convention and `npm run e2e`.

## PR 6 — Wave 3 (R14–R16) extended asset coverage + PR 5 carry-overs

- **R14 — Spine `sp.SkeletonData` recovery:** mapped to the `spine` importer in `KLASS_TO_IMPORTER`. Rich `.meta` carries `userData.textures` (uuid array) and `userData.atlasInline` flag, sourced from the rehydrated import doc.
- **R15 — DragonBones recovery:** `dragonBones.DragonBonesAsset` → `dragonbones`, `dragonBones.DragonBonesAtlasAsset` → `dragonbones-atlas`. Cross-uuid extras (`atlasUuid` on the asset, `textureUuid` on the atlas) emitted in `.meta` so editor reimport can re-link the pair.
- **R16 — Binary `settings.bin` decoding:** `detectProjectFlavor` now probes `src/settings.bin` (and hashed `settings.<hash>.bin`) after the JSON form, decoding via the existing notepack subset (`src/core/cocos3x/notepack.js`). JSON form still takes precedence when both are present.
- **Carry-over fixes (PR 5 reviews):**
  - Pure-native classes (e.g. `cc.BufferAsset`, `cc.Mesh`) no longer lose their rich `.meta` to the legacy stub — the `pathExists` guard is gone for `KLASS_TO_IMPORTER`-mapped classes; rich meta is the intended editor-facing output.
  - `pickCocosVersion` `version` branch tightened from `/^\d+\./` to `/^3\./`, so a 2.4.x string can't accidentally feed the 3.x scaffold; helper exported for unit testing.
- **`writeAssetMeta`:** now accepts an optional `extras` object merged into `userData`. Back-compat preserved (callers without `extras` keep the prior `{ recoveredBy: 'cc-reverse' }` shape).
- **Tests:** 105 → **123 passing** (33 files), no regressions.

## PR 5 — Wave 2 (R9–R12) + Layer 7 humanify + carry-over fixes

- **R9 — Dynamic 3.x project metadata:** `project.json`, `package.json`, and `settings/project.json` are now derived from the source build's `src/settings.json` (engine version, project name, design resolution, launch scene). Hardcoded constants removed. Implemented in new `writeCocos3xProject` in `src/core/cocos3x/projectScaffold.js`; wired through `engine3x.writeProjectDescriptor`.
- **R10 — No static `typeDefinitions` in 3.x:** explicitly pinned by `test/unit/cocos3x.no-static-types.test.js`. 3.x rehydration is fully driven by each document's own `sharedClasses`; the 2.x hardcoded type table is no longer in the 3.x dep graph. Doc-comment in `rehydrate.js` calls out the boundary.
- **R11 — Smarter class→dir mapping:** new `resolveOutputPath(uuid, cfg, klass, ext)` helper falls back to `<CLASS_DIR[klass]>/<uuid>` when `config.paths[uuid].path` is missing or empty. Source paths preserved when present.
- **R12 — Richer `.meta` for non-script assets:** new `writeAssetMeta` emits class-aware `{ ver, importer, imported, uuid, files, subMetas, userData }` shapes. Importer keyed off Cocos class (`cc.SpriteFrame` → `sprite-frame`, `cc.AudioClip` → `audio-clip`, etc.). Script `.meta` emitter unchanged.
- **Layer 7 — humanify wrapper (opt-in):** new `cc-reverse humanify <outDir>` CLI subcommand shells out to the user-installed [`humanify`](https://github.com/jehna/humanify) CLI. No hard dep — wrapper detects missing binary and exits 1 with install instructions. Two providers: `local` (default, offline LLM) and `openai` (OpenAI-compatible via `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `--model`). Output → `<outDir>/humanified/`. The `copilot-api` route is documented in the README as a user-borne risk path and is **never** wired programmatically.
- **Carry-over fixes (PR 3/4 reviews):**
  - `tsProject` gate now surfaces `<n> .ts file(s); tsconfig.json present|absent` in `detail`; `runGates` threads `detail` through both `passed` and `failed` entries.
  - `recoveryIndex` gate now enumerates all missing entries (capped at 10, with `+N more` suffix) instead of only the first.
  - `ccclassNamer` test coverage: class self-reference rename + bare `_RF.push` (no `cclegacy` prefix) + `@ccclass` no-arg.
  - `typeInferer` test coverage: `__uuid__` miss → `any`, `__id__` out-of-bounds → `any`, multi-module uuidMap aggregation for cross-module `__uuid__` lookup.
- **Tests:** 80 → **105 passing** (27 files), no regressions.

## PR 4 — Script Recovery Layers 4-6 (ccclassNamer + typeInferer + tsProjectEmitter)

- **Layer 4 (ccclassNamer):** scans `_RF.push(module, uuid, name)` calls and `@ccclass('Name')` decorators to recover the original class name and build a `uuidMap` (className -> UUID) per module.
- **Layer 5 (typeInferer):** indexes recovered scenes / prefabs (`assets/<bundle>/**/*.scene|*.prefab`) and infers field types (`Map<className, Map<fieldName, typeName>>`) from `__type__` references in node component data.
- **Layer 6 (tsProjectEmitter):** consumes the post-Layer-5 AST plus `ccclassName` / `uuidMap` / `fieldTypes` and emits a buildable TypeScript project under `assets/scripts/<bundle>/<module>.ts` via `ts-morph`, formatted with `prettier`. Writes a top-level `tsconfig.json` and a `RECOVERY_INDEX.json` mapping ccclass -> { uuid, file }.
- **CLI flag:** `--script-layers <1-6>` (default 6) on `bin/cc-reverse.js` — caps the pipeline at the requested layer for debugging / partial recovery.
- **Engine wiring:** `engine3x.recoverScripts` runs the full 6-layer pipeline when `scriptLayers >= 6`, emitting both the legacy raw `.js` copy under `assets/Scripts/` (PR 5 retires it) and the new `.ts` project under `assets/scripts/<bundle>/`. Both layouts coexist in this release.
- **New gates:** `recoveryIndex` (validates `RECOVERY_INDEX.json` shape; passes when absent so `--script-layers < 6` runs are still green) and `tsProject` (validates the emitted `tsconfig.json` + at least one `.ts` file when scripts were recovered).
- New deps: `ts-morph@^21.0.1`, `prettier@^3.0.0`. Run `npm install` after pulling.
- 80 tests passing (21 files), no regressions to PR 1-3.

## PR 3 — Wave / Script Recovery Layers 1-3 (webcrack integration)

- **Layer 1 (chunkSplitter):** parses `src/chunks/*.js` and splits each `System.register(...)` call into a discrete module with deps and setter bindings.
- **Layer 2 (esmRebuilder):** rewrites SystemJS execute body into top-level `import` / `export` statements; drops `_export("name", void 0)` placeholders.
- **Layer 3 (classRestorer):** drives webcrack `unminify` to collapse `__extends` IIFEs back into native `class extends` syntax; folds `__decorate([...], Class)` assignments into `@decorator class Class { ... }`.
- **Pipeline driver** with fail-closed semantics — any layer crash leaves downstream layers running on the last good AST.
- **Integration:** `engine3x.recoverScripts` now also emits layered output under `assets/scripts/<chunk>/<module>.js` alongside the legacy raw copy under `assets/Scripts/`.
- **New gate:** `layeredScripts` (informational) — reports counts of layered files and how many include `import` statements.
- New dep: `webcrack@^2.16.0`.

### Added (PR 2, Wave 1)
- R5: CCON v2 (notepack) decoder — `.cconb` files at version 2 now produce real documents.
- R6: Full IPackedFileData rehydrate — multi-section packs are split and each section rehydrated.
- R7: TypedArray DataTypeID coverage in rehydrate (DataTypeID 13 + 14, 9 ctors).
- R8: Cross-bundle redirect resolution — assets routed via `cfg.redirect` now read from the dep bundle.
- Validate gates: `cconV2`, `typedArrays`.

### Added (PR 1, Wave 0)
- R1: JSC key extraction now scans `application.js`, `cocos-js/*.js`, `src/settings.json`; supports byte-array key form (`xxteaKey = [0x.., ...]`).
- R3: All 3.x hot-path sync IO replaced with `fs/promises` and guarded by a unit test.
- R4: Per-asset error isolation in `engine3x.unpackBundle`; emits `RECOVERY_REPORT.md` to output root with `ok / failed / missed` counts per bundle.
- vitest test scaffold (replaces jest); `npm run validate <output-dir>` quality-gate runner.
