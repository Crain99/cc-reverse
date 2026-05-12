# Changelog

All notable changes to cc-reverse are documented here.
The format is based on Keep a Changelog.

## [Unreleased]

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
