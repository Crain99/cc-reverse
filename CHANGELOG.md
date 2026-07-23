# Changelog

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
