# Changelog

All notable changes to cc-reverse are documented here.
The format is based on Keep a Changelog.

## [Unreleased]

### Added (PR 1, Wave 0)
- R1: JSC key extraction now scans `application.js`, `cocos-js/*.js`, `src/settings.json`; supports byte-array key form (`xxteaKey = [0x.., ...]`).
- R3: All 3.x hot-path sync IO replaced with `fs/promises` and guarded by a unit test.
- R4: Per-asset error isolation in `engine3x.unpackBundle`; emits `RECOVERY_REPORT.md` to output root with `ok / failed / missed` counts per bundle.
- vitest test scaffold (replaces jest); `npm run validate <output-dir>` quality-gate runner.
