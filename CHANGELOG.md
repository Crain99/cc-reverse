# Changelog

## [Unreleased]

### Fixes
- **Issue #33**: Write meta as `basename+ext+.meta` (e.g. `logo.png.meta`); do not emit orphan `.png.meta` when native PNG was not recovered (2.x SpriteFrame + 3.x pure-native)
- **Issue #32 / #37**: True 3.x builds emit scenes as `.scene` (+ matching meta); classic 2.4 bundle flavor keeps `.fire`
- Prefer colocating classic 2.x SpriteFrame meta with the `rawAssets` PNG path

### Features
- **Issue #23**: Demux packed bundle `index.js` / `game.js` into per-module files under `assets/Scripts` with `.meta` (preserves `cc._RF` UUID mounts); split multi-`System.register` chunks similarly. Raw bundle script still copied for reference; recovered script count includes split modules
- Wire `index.jsc` / `game.jsc` decrypt on the 3.x path via existing `jscDecryptor` + `--key` / auto-key helpers
- Honor bundle `redirect` entries when resolving assets (skip redirected uuids owned by dependency bundles)

### Tests
- Regression fixtures for correct meta names, no orphan meta without PNG, `.scene` for 3.x, `.fire` for 2.4 bundle flavor, and multi-script demux from packed `index.js`

## [2.1.1] - 2026-07-23

### Fixes
- **Issue #31**: Support MD5 Cache bundle configs (`config.<hash>.json`) and hashed entry scripts (`main.<hash>.js`, etc.)
- When `--version-hint 2.4.x` meets a 2.4/3.x bundle layout, route to the bundle pipeline so textures are restored as native files instead of import JSON
- `extensionMap` entries may be uuid indexes; resolve them correctly

## [2.1.0] - 2026-07-23

### Features
- **Script pipeline (2.x)**: browserify / `__require` module slicing without full-file Babel AST; AST fallback retained
- Preserve script UUID mounts from `cc._RF.push` so scene/prefab components rebind to recovered scripts
- Rewrite minified factory requires (`e("./x")`) using deps maps
- **Packed import restoration**: split `packedAssets` JSON into isolated scenes, prefabs, sprite frames, audio, LabelAtlas
- Native asset copy from `raw-assets` via decoded texture/audio UUIDs and `settings.rawAssets` paths
- Standalone prefab/texture recovery for entries only listed in `rawAssets`
- CLI: `--script-format`, `--no-ast-fallback`
- Emit `RECOVERY_REPORT.md` for 2.x and 3.x runs (format/extractor, asset counts, bundle table)

### Performance & reliability
- Bounded concurrency (`mapPool`) for copy / decrypt / unpack / emit
- Safer settings parse via `vm` instead of bare `eval`
- Await queued writes; circular-safe scene serialization
- Clear npm audit vulnerabilities in lockfile

### Tests
- Fixtures and unit tests for script extract/transform, packed assets, recovery report

## [2.0.0] - 2026-04-22

- Initial npm release with Cocos Creator 2.3.x / 2.4.x / 3.x support
