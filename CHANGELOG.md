# Changelog

All notable changes to cc-reverse are documented here.
The format is based on Keep a Changelog.

## [Unreleased]

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
