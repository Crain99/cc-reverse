# Changelog

## [Unreleased]

## [2.1.2] - 2026-09-02

### Fixes
- **3.x script demux**: Treat Creator 3.x rollup `System.register("chunks:///_virtual/...")` packs as SystemJS; demux one file per register id (e.g. `Foo.ts`) with stable `cc._RF.push` UUID metas — no more bogus `setters.ts` / empty `module_N.js` stubs
- Demux **MD5-cache** bundle scripts (`index.<hash>.js` / `game.<hash>.js`); emit fused `chunks:///main.js` packs as game `main.pack.js` (not a vendor stub)
- Park engine/vendor scripts (`_virtual_cc-*`, spine/bullet, builtin-pipeline*, rollup helpers, cocos-js) under `assets/Scripts/_vendor/`
- Normalize `config.paths` `db://` **and** `db:/` (single-slash) so assets are not written under a literal `db:` directory
- Strip leading `assets/` after `db:/` normalize — no double `assets/<bundle>/assets/...` prefix
- Decode compressed uuids that carry `@subAsset` / `@mip@format` suffixes so `native/...@….png` lookups succeed
- Use `@suffix` as ImageAsset `subMetas` id; strip `/texture` / `/spriteFrame` / `@6c48a|@f9941` from output paths; fold uuid-only `@` siblings onto parent ImageAsset (named or `_packed/`)
- Sweep leftover `native/` files; report per-bundle native image counts (and an explicit “import descriptors only” note for web-mobile with zero image bytes)
- **Issue #33**: Write meta as `basename+ext+.meta` (e.g. `logo.png.meta`); do not emit orphan `.png.meta` when native PNG was not recovered
- **Issue #32 / #37**: True 3.x builds emit scenes as `.scene` (+ matching meta); classic 2.4 bundle flavor keeps `.fire`
- Fold `Texture2D` / `SpriteFrame` `subAsset` into parent `ImageAsset` `.png.meta` `subMetas` (Creator layout)
- Strip trailing RootInfo from rehydrated IFileData; rehydrate packed Prefab pack sections end-to-end
- Clearer recovery report: game vs vendor script counts; bundle Named vs Packed columns

### Features
- **Issue #23**: Demux packed bundle `index.js` / `game.js` into per-module files under `assets/Scripts` with `.meta` (preserves `cc._RF` UUID mounts)
- Wire `index.jsc` / `game.jsc` decrypt on the 3.x path via existing `jscDecryptor` + `--key` / auto-key helpers
- Honor bundle `redirect` entries when resolving assets

### Tests
- Vendor script classification + demux under `_vendor/`; report game/vendor + Named/Packed
- Regression fixtures for meta names, no orphan meta without PNG, `.scene` for 3.x, `.fire` for 2.4, System.register demux, ImageAsset subMetas, packed Prefab rehydrate, MD5 index demux, `db:/` path strip

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
