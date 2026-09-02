# Changelog

## [Unreleased]

### Fixes
- Route engine/vendor scripts (_virtual_cc-*, spine/bullet, builtin-pipeline*, rollup helpers, bundle stubs, cocos-js) under assets/Scripts/_vendor/
- Recovery report: game vs vendor script counts; bundle Named vs Packed columns
- Decode Creator compressed uuids that carry `@subAsset` / `@mip@format` suffixes so `native/<2>/<decoded>@….png` lookups succeed (was leaving ids compressed when length ≠ 22)
- Use `@suffix` as ImageAsset `subMetas` id (`6c48a` / `f9941`) so Texture2D + SpriteFrame no longer collide into one meta slot
- Strip `/texture` / `/spriteFrame` / `@6c48a|@f9941` from output file paths; fold uuid-only `@` siblings onto parent ImageAsset (named path or `_packed/<2>/<base>`)
- Sweep leftover `native/` files and report per-bundle native image counts (explicit “import descriptors only” note for web-mobile builds with zero image bytes)
- Normalize `config.paths` `db://` **and** `db:/` (single-slash) prefixes so recovered assets are not written under a literal `db:` directory (real Creator 3.8 web-mobile)
- Treat Creator 3.x rollup `System.register("chunks:///_virtual/...")` packs as SystemJS (not browserify); demux one file per register id (`Foo.ts`) with aliased `._RF.push` UUID metas — no more bogus `setters.ts`
- Skip anonymous / variable-id `System.register` wrappers (nested rollup shell + `mid`/`cid` reexports) so recovery no longer emits empty `module_N.js` stubs
- **Issue #33**: Write meta as `basename+ext+.meta` (e.g. `logo.png.meta`); do not emit orphan `.png.meta` when native PNG was not recovered (2.x SpriteFrame + 3.x pure-native)
- **Issue #32 / #37**: True 3.x builds emit scenes as `.scene` (+ matching meta); classic 2.4 bundle flavor keeps `.fire`
- Prefer colocating classic 2.x SpriteFrame meta with the `rawAssets` PNG path
- **Issue #32**: Fold `Texture2D` / `SpriteFrame` marked `subAsset` into parent `ImageAsset` `.png.meta` `subMetas` (Creator layout) instead of orphan `logo@xxxx` / `spriteFrame.json` folders
- Strip trailing RootInfo from rehydrated IFileData so Prefab/Scene emit dense `[{__type__:...}]` source JSON; rehydrate packed Prefab pack sections end-to-end
- Demuxed / copied scripts prefer stable UUID from `cc._RF.push` (decoded) over random meta UUIDs — improves #37 script rebind

### Features
- **Issue #23**: Demux packed bundle `index.js` / `game.js` into per-module files under `assets/Scripts` with `.meta` (preserves `cc._RF` UUID mounts); split multi-`System.register` chunks similarly. Raw bundle script still copied for reference; recovered script count includes split modules
- Wire `index.jsc` / `game.jsc` decrypt on the 3.x path via existing `jscDecryptor` + `--key` / auto-key helpers
- Honor bundle `redirect` entries when resolving assets (skip redirected uuids owned by dependency bundles)

### Tests
- Vendor script classification + demux under _vendor/; report game/vendor + Named/Packed
- Regression fixtures for correct meta names, no orphan meta without PNG, `.scene` for 3.x, `.fire` for 2.4 bundle flavor, and multi-script demux from packed `index.js`
- ImageAsset subMetas folding, packed Prefab rehydrate, redirect skip count, System.register demux RF UUID stability

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
