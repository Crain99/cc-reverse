/*
 * Cocos Creator 3.x reverse-engineering orchestrator.
 *
 * High-level flow:
 *   1. Discover bundles under <buildRoot>/assets/<name>/config.json
 *      (plus subpackages and the runtime settings.json).
 *   2. Optionally decrypt each bundle's index.jsc if encrypted === true.
 *   3. For each bundle, parse config.json, iterate `paths`, and for every
 *      uuid:
 *        - Locate its import/<uuid>.json (or .cconb); parse for class + deps.
 *        - Locate its native file if one exists (from extensionMap or
 *          _native hints inside the document).
 *        - Copy both into the output tree, preserving the original project
 *          path from `config.paths[uuid].path` so the result mirrors the
 *          editor's asset layout.
 *   4. Recover user scripts from src/chunks/*.js (SystemJS modules).
 *   5. Emit a minimal project.json so Cocos Creator 3.x recognises the output.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const vm = require('vm');
const { logger } = require('../../utils/logger');
const { uuidUtils } = require('../../utils/uuidUtils');
const { forEachPool, getMaxParallel } = require('../../utils/asyncPool');
const {
  parseBundleConfig,
  normalizeDbAssetPath,
  getImportPath,
  getNativePath,
  findBundleConfigPath,
  hasBundleConfig,
} = require('./bundleConfig');
const { isCcon, decodeCcon } = require('./ccon');
const { inspect } = require('./deserializer');
const { rehydrateIFileData } = require('./rehydrate');
const { writeCocos2xProject } = require('./projectScaffold');
const { writeRecoveryReport } = require('../../utils/recoveryReport');
const { decryptJscBuffer } = require('../jscDecryptor');
const { recoverScripts2x } = require('../script');

const readFile = fsp.readFile;
const writeFile = fsp.writeFile;
const mkdir = fsp.mkdir;
const copyFile = fsp.copyFile;
const readdir = fsp.readdir;
const stat = fsp.stat;

/**
 * Native extensions we know how to detect from a JSON document's `_native`
 * field or the bundle's extensionMap.
 */
const KNOWN_NATIVE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.pvr', '.pkm', '.astc',
  '.mp3', '.ogg', '.wav', '.m4a',
  '.txt', '.json', '.xml', '.plist',
  '.bin', '.cconb', '.ccon',
  '.ttf', '.otf', '.fnt',
  '.atlas', '.skel',
]);

/**
 * Class name → output subdirectory convention. Unknown classes land in `raw`.
 */
const CLASS_DIR = {
  'cc.SceneAsset': 'scene',
  'cc.Prefab': 'prefab',
  'cc.SpriteFrame': 'texture',
  'cc.ImageAsset': 'texture',
  'cc.Texture2D': 'texture',
  'cc.TextureCube': 'texture',
  'cc.AudioClip': 'audio',
  'cc.TextAsset': 'text',
  'cc.JsonAsset': 'json',
  'cc.BufferAsset': 'buffer',
  'cc.Mesh': 'mesh',
  'cc.Material': 'material',
  'cc.EffectAsset': 'effect',
  'cc.AnimationClip': 'animation',
  'cc.SkeletalAnimationClip': 'animation',
  'cc.Skeleton': 'skeleton',
  'cc.ParticleAsset': 'particle',
  'cc.Terrain': 'terrain',
  'cc.TerrainAsset': 'terrain',
  'cc.LabelAtlas': 'font',
  'cc.BitmapFont': 'font',
  'cc.TTFFont': 'font',
  'sp.SkeletonData': 'spine',
  'dragonBones.DragonBonesAsset': 'dragonbones',
  'dragonBones.DragonBonesAtlasAsset': 'dragonbones',
};

/**
 * Main entry point for 3.x projects. Invoked from reverseEngine when the
 * detector decides we're in 3.x territory.
 *
 * @param {object} options
 * @param {string} options.sourcePath
 * @param {string} options.outputPath
 * @param {string[]} [options.bundleFilter]  if provided, only these bundles.
 * @param {boolean}  [options.assetsOnly]
 * @param {boolean}  [options.scriptsOnly]
 * @param {string}   [options.key]  XXTEA key for encrypted bundle index files.
 * @param {boolean}  [options.verbose]
 */
async function reverseProject3x(options) {
  const {
    sourcePath,
    outputPath,
    bundleFilter,
    assetsOnly = false,
    scriptsOnly = false,
    verbose = false,
    key = null,
  } = options;

  await mkdir(outputPath, { recursive: true });
  await mkdir(path.join(outputPath, 'assets'), { recursive: true });

  const projectFlavor = detectProjectFlavor(sourcePath);

  const summary = {
    engine: '3.x',
    bundles: [],
    scripts: { total: 0 },
    warnings: [],
  };

  if (!scriptsOnly) {
    const bundles = await discoverBundles(sourcePath);
    for (const bundleDir of bundles) {
      const name = path.basename(bundleDir);
      if (Array.isArray(bundleFilter) && bundleFilter.length > 0
          && !bundleFilter.includes(name)) {
        logger.debug(`Skipping bundle ${name} (not in --bundle filter)`);
        continue;
      }
      try {
        const result = await unpackBundle({
          bundleDir,
          outputPath,
          verbose,
          flavor: projectFlavor.flavor,
          key,
          warnings: summary.warnings,
        });
        summary.bundles.push(result);
      } catch (err) {
        logger.error(`Failed to unpack bundle ${name}:`, err);
        summary.warnings.push(`bundle ${name}: ${err.message}`);
      }
    }
  }

  if (!assetsOnly) {
    summary.scripts = await recoverScripts(sourcePath, outputPath, verbose, {
      key,
      warnings: summary.warnings,
    });
  }

  summary.flavor = projectFlavor.flavor;

  if (projectFlavor.flavor === '2.4.x-bundle') {
    await writeCocos2xProject(outputPath, {
      projectName: path.basename(sourcePath),
      cocosVersion: projectFlavor.version || '2.4.14',
      settings: projectFlavor.settings || {},
      bundles: summary.bundles,
    });
  } else {
    await writeProjectDescriptor(outputPath);
  }

  summary.reportPath = await writeRecoveryReport(outputPath, summary, sourcePath);
  return summary;
}

/**
 * Decide whether this 3.x-style layout is actually a Cocos Creator 2.4 bundle
 * build (scenes use `.fire`, settings is `window._CCSettings`) or a true 3.x
 * build (`.scene`, `src/settings.json`).
 */
function detectProjectFlavor(sourcePath) {
  // 3.x marker.
  const settings3xPath = path.join(sourcePath, 'src', 'settings.json');
  if (fs.existsSync(settings3xPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settings3xPath, 'utf-8'));
      return { flavor: '3.x', settings: s };
    } catch {
      // fall through
    }
  }
  // Also check for hashed settings.*.json (3.x web builds).
  const srcDir = path.join(sourcePath, 'src');
  if (fs.existsSync(srcDir)) {
    const files = fs.readdirSync(srcDir);
    const hashed = files.find(f => /^settings\..+\.json$/.test(f));
    if (hashed) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(srcDir, hashed), 'utf-8'));
        return { flavor: '3.x', settings: s };
      } catch {
        // fall through
      }
    }
  }

  // 2.4.x marker: src/settings.js containing `window._CCSettings = { ... }`.
  const settings2xPath = path.join(sourcePath, 'src', 'settings.js');
  if (fs.existsSync(settings2xPath)) {
    try {
      const text = fs.readFileSync(settings2xPath, 'utf-8');
      if (text.includes('_CCSettings') || text.includes('CCSettings')) {
        const settings = parseCCSettingsScript(text);
        return { flavor: '2.4.x-bundle', settings, version: settings.CCSettings?.engineVersion };
      }
    } catch {
      // fall through
    }
  }

  return { flavor: 'unknown', settings: {} };
}

function parseCCSettingsScript(text) {
  // Evaluate in a vm sandbox: window._CCSettings = { ... };
  try {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(text, sandbox, { timeout: 2000, displayErrors: false });
    return sandbox.window._CCSettings || sandbox.window.CCSettings || {};
  } catch {
    // Fallback: extract object literal
    try {
      const m = text.match(/(?:window\.)?_?CCSettings\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (m) {
        return vm.runInNewContext(`(${m[1]})`, {}, { timeout: 1000 }) || {};
      }
    } catch {
      // ignore
    }
    return {};
  }
}

/**
 * Walk <buildRoot>/assets for subdirectories that contain config.json
 * (or MD5-cache config.<hash>.json). Also checks subpackages/.
 */
async function discoverBundles(sourcePath) {
  const bundles = [];
  const candidates = [
    path.join(sourcePath, 'assets'),
    path.join(sourcePath, 'subpackages'),
  ];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundleDir = path.join(root, entry.name);
      if (hasBundleConfig(bundleDir)) bundles.push(bundleDir);
    }
  }
  return bundles;
}

/**
 * Unpack a single bundle. Returns a summary record.
 */
async function unpackBundle({ bundleDir, outputPath, verbose, flavor, key, warnings }) {
  const cfgPath = findBundleConfigPath(bundleDir);
  if (!cfgPath) {
    throw new Error(`No config.json / config.<hash>.json in ${bundleDir}`);
  }
  if (verbose && path.basename(cfgPath) !== 'config.json') {
    logger.debug(`Using hashed bundle config: ${path.basename(cfgPath)}`);
  }
  const raw = JSON.parse(await readFile(cfgPath, 'utf-8'));
  const cfg = parseBundleConfig(raw, bundleDir);

  // Decrypt index.jsc / game.jsc into adjacent .js when needed (in-memory write
  // into the output tree later; also materialize .js beside source when missing
  // so demux can read it). Honors --key / auto key from reverseEngine.
  await maybeDecryptBundleScripts(bundleDir, key, warnings);

  logger.info(`Bundle "${cfg.name}": ${cfg.uuids.length} uuids, ${Object.keys(cfg.paths).length} paths`);

  const bundleOut = path.join(outputPath, 'assets', cfg.name);
  await mkdir(bundleOut, { recursive: true });

  // Build uuid → { packUuid, position } so we can recover packed assets.
  // packs[packUuid] = [uuidIndex, uuidIndex, ...] where uuidIndex -> cfg.uuids[i].
  cfg._packIndex = {};
  for (const packUuid of Object.keys(cfg.packs)) {
    const children = cfg.packs[packUuid];
    for (let i = 0; i < children.length; i += 1) {
      const childUuid = children[i];
      cfg._packIndex[childUuid] = { packUuid, position: i };
    }
  }
  // Remember pack files we've already copied so we only copy once per bundle.
  cfg._copiedPacks = new Set();

  // Index ImageAsset children (Texture2D / SpriteFrame marked subAsset) so we
  // can fold them into the parent .png.meta subMetas instead of orphan folders.
  const subIndex = indexImageSubAssets(cfg);
  cfg._imageSubByParent = subIndex.byParent;
  cfg._foldedSubUuids = subIndex.childUuids;

  const result = {
    name: cfg.name,
    encrypted: cfg.encrypted,
    uuidCount: cfg.uuids.length,
    pathCount: Object.keys(cfg.paths).length,
    sceneCount: Object.keys(cfg.scenes).length,
    recovered: 0,
    namedRecovered: 0,
    packedRecovered: 0,
    missing: 0,
    redirected: 0,
    nativeFiles: 0,
    nativeImages: 0,
    sampleNativePaths: [],
    warnings: [],
  };
  // Shared across concurrent unpackAsset calls — only push samples under lock-free cap.
  cfg._nativeStats = result;

  // Track which uuids we've already processed so we don't duplicate work when
  // a uuid appears in both `paths` and `scenes` and the catch-all uuids pass.
  const handled = new Set();
  const concurrency = getMaxParallel();

  const shouldSkipRedirect = (uuid) => {
    if (cfg.redirect && cfg.redirect[uuid]) {
      handled.add(uuid);
      result.redirected += 1;
      if (verbose) {
        logger.debug(`Skipping redirected ${uuid} → bundle ${cfg.redirect[uuid]}`);
      }
      return true;
    }
    return false;
  };

  // 1) Named assets from config.paths — the user's project-visible tree.
  const pathUuids = Object.keys(cfg.paths);
  await forEachPool(pathUuids, concurrency, async (uuid) => {
    if (shouldSkipRedirect(uuid)) return;
    // Folded into parent ImageAsset .meta — do not emit orphan texture folders.
    if (cfg._foldedSubUuids && cfg._foldedSubUuids.has(uuid)) {
      handled.add(uuid);
      return;
    }
    const info = cfg.paths[uuid];
    try {
      const ok = await unpackAsset({
        cfg, uuid, info, bundleOut, verbose, flavor,
      });
      handled.add(uuid);
      if (ok) {
        result.recovered += 1;
        result.namedRecovered += 1;
      } else result.missing += 1;
    } catch (err) {
      result.warnings.push(`${info.path}: ${err.message}`);
      logger.debug(`Asset ${uuid} (${info.path}) failed: ${err.message}`);
    }
  });

  // 2) Scenes — often listed only under config.scenes, not under paths.
  const sceneJobs = [];
  for (const sceneName of Object.keys(cfg.scenes)) {
    const uuid = cfg.scenes[sceneName];
    if (!uuid || handled.has(uuid)) continue;
    if (shouldSkipRedirect(uuid)) continue;
    // Scene names use `db://assets/...` or `db:/assets/...` (3.8 web-mobile).
    const pathStr = normalizeDbAssetPath(sceneName)
      .replace(/\.(fire|scene)$/i, '')
      || `scene/${uuid}`;
    sceneJobs.push({
      uuid,
      sceneName,
      info: { path: pathStr, type: 'cc.SceneAsset', subAsset: false },
    });
  }
  await forEachPool(sceneJobs, concurrency, async ({ uuid, sceneName, info }) => {
    try {
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose, flavor });
      handled.add(uuid);
      if (ok) {
        result.recovered += 1;
        result.namedRecovered += 1;
      } else result.missing += 1;
    } catch (err) {
      result.warnings.push(`scene ${sceneName}: ${err.message}`);
    }
  });

  // 3) UUID-only assets (in uuids[] but not in paths/scenes). Typical for
  //    packed dependencies referenced by prefabs/scenes. Extract them under
  //    _packed/<2>/<uuid> so the editor can still resolve cross-asset refs.
  const packedJobs = cfg.uuids.filter((uuid) => !handled.has(uuid));
  await forEachPool(packedJobs, concurrency, async (uuid) => {
    if (shouldSkipRedirect(uuid)) return;
    if (cfg._foldedSubUuids && cfg._foldedSubUuids.has(uuid)) {
      handled.add(uuid);
      return;
    }
    const info = {
      path: `_packed/${uuid.slice(0, 2)}/${uuid}`,
      type: null,
      subAsset: false,
    };
    try {
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose, flavor });
      handled.add(uuid);
      if (ok) {
        result.recovered += 1;
        result.packedRecovered += 1;
      }
    } catch (err) {
      // These are often internal/packed — don't count as warnings.
      logger.debug(`Packed uuid ${uuid} skipped: ${err.message}`);
    }
  });

  // 4) Sweep native/ for files whose uuid never appeared in config.uuids
  //    (or whose decode previously missed). Copy leftovers under _packed.
  await sweepOrphanNatives(cfg, bundleOut, handled, result);

  if (result.nativeImages === 0) {
    logger.info(
      `Bundle "${cfg.name}": no native image bytes recovered `
      + `(import JSON/cconb descriptors only — common for web-mobile)`,
    );
  } else {
    logger.info(
      `Bundle "${cfg.name}": ${result.nativeImages} native image(s), `
      + `${result.nativeFiles} native file(s) total`,
    );
  }

  // Preserve the original config.json for reference — useful when a user wants
  // to re-pack or debug.
  await copyFile(cfgPath, path.join(bundleOut, 'config.original.json'));

  // Preserve the bundle's compiled user-script bundle (2.4+ ships this as
  // <bundle>/game.js or <bundle>/index.js). Demux happens in recoverScripts.
  for (const scriptName of ['game.js', 'index.js']) {
    const src = path.join(bundleDir, scriptName);
    if (fs.existsSync(src)) {
      await copyFile(src, path.join(bundleOut, scriptName));
      result.scriptBundle = scriptName;
    }
  }

  return result;
}

async function unpackAsset({ cfg, uuid, info, bundleOut, verbose, flavor }) {
  const importSrc = getImportPath(cfg, uuid, '.json');
  const importSrcCcon = getImportPath(cfg, uuid, '.cconb');
  const nativeExt = cfg.extensionMap[uuid] || null;
  const nativeSrc = nativeExt ? getNativePath(cfg, uuid, nativeExt) : null;

  // Choose an output path. Prefer the project path from config.paths — that's
  // what the editor will see. Strip `/texture` / `@6c48a` subAsset segments so
  // natives never land under a fake `…/texture.png` leaf.
  const className = info.type || 'cc.Asset';
  const outDir = classOutputDir(className);
  const rawRel = normalizeDbAssetPath(info.path) || `${outDir}/${uuid}`;
  const relPath = normalizeAssetFilePath(rawRel) || rawRel;
  const outBase = path.join(bundleOut, relPath);
  await mkdir(path.dirname(outBase), { recursive: true });

  let importDoc = null;
  let importFromCcon = false;
  let importPackRef = null;
  let importRecovered = false;
  let nativeRecovered = false;
  let recoveredNativeExt = null;

  // Asset-class-driven filename for the import document:
  //   scene   -> .scene (true 3.x) or .fire (2.4 / classic)
  //   prefab  -> .prefab
  //   pure-native classes (Texture2D, AudioClip, TTFFont, …) skip the import
  //                 write entirely — the native file is the real asset.
  const importExt = inferImportExt(className, flavor);
  const skipImportWrite = isPureNativeClass(className);

  // --- Import document (one per asset, or inside a pack) ---
  if (fs.existsSync(importSrc)) {
    const buf = await readFile(importSrc);
    if (isCcon(buf)) {
      importDoc = await decodeCconToDoc(buf, outBase);
      importFromCcon = true;
    } else {
      try {
        importDoc = JSON.parse(buf.toString('utf-8'));
      } catch {
        importDoc = null;
      }
    }
    if (importDoc !== null) {
      if (!skipImportWrite) {
        // Rehydrate IFileData tuples back to editor source format
        // (`[{__type__, ...}, ...]` with {__id__}/{__uuid__} refs). Falls
        // back to the raw document when the shape isn't recognised or when
        // CC_REVERSE_NO_REHYDRATE=1 is set.
        const disabled = process.env.CC_REVERSE_NO_REHYDRATE === '1';
        const content = disabled
          ? importDoc
          : (tryRehydrate(importDoc) || importDoc);
        await writeFile(outBase + importExt, JSON.stringify(content, null, 2));
      }
      importRecovered = true;
    }
  } else if (fs.existsSync(importSrcCcon)) {
    const buf = await readFile(importSrcCcon);
    importDoc = await decodeCconToDoc(buf, outBase);
    importFromCcon = true;
    if (importDoc !== null) {
      if (!skipImportWrite) {
        const disabled = process.env.CC_REVERSE_NO_REHYDRATE === '1';
        const content = disabled
          ? importDoc
          : (tryRehydrate(importDoc) || importDoc);
        await writeFile(outBase + importExt, JSON.stringify(content, null, 2));
      }
      importRecovered = true;
    }
  }

  if (importDoc && verbose) {
    const info2 = inspect(importDoc);
    if (info2.rootClass) logger.debug(`  ${info.path}  (${info2.rootClass})`);
  }

  // --- Native asset (independent of import) ---
  //   1. extensionMap entry from config.json (3.x native builds).
  //   2. `_native` value embedded in the import document (legacy plain form).
  //   3. Glob native/<prefix>/<uuid>.* on disk — this is how 2.4+ bundle
  //      builds ship, since their extensionMap is often empty.
  if (nativeSrc && fs.existsSync(nativeSrc)) {
    await copyFile(nativeSrc, outBase + (nativeExt || ''));
    nativeRecovered = true;
    recoveredNativeExt = nativeExt || '';
  } else {
    let probedExt = null;
    if (importDoc) probedExt = probeNativeExtension(importDoc);
    if (probedExt) {
      const probedSrc = getNativePath(cfg, uuid, probedExt);
      if (probedSrc && fs.existsSync(probedSrc)) {
        await copyFile(probedSrc, outBase + probedExt);
        nativeRecovered = true;
        recoveredNativeExt = probedExt;
      }
    }
    if (!nativeRecovered) {
      const globbed = await globNativeByUuid(cfg, uuid);
      if (globbed) {
        await copyFile(globbed.src, outBase + globbed.ext);
        nativeRecovered = true;
        recoveredNativeExt = globbed.ext;
      }
    }
  }

  if (nativeRecovered && cfg._nativeStats) {
    cfg._nativeStats.nativeFiles += 1;
    const extLower = (recoveredNativeExt || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.pvr', '.pkm', '.astc'].includes(extLower)) {
      cfg._nativeStats.nativeImages += 1;
    }
    const samples = cfg._nativeStats.sampleNativePaths;
    if (samples.length < 8) {
      samples.push(relPath + (recoveredNativeExt || ''));
    }
  }

  // --- Packed asset (extract section from IPackedFileData) ---
  if (!importRecovered && cfg._packIndex && cfg._packIndex[uuid]) {
    const { packUuid, position } = cfg._packIndex[uuid];
    const section = await extractPackSection(cfg, packUuid, position);
    if (section) {
      const disabled = process.env.CC_REVERSE_NO_REHYDRATE === '1';
      const content = disabled
        ? section
        : (tryRehydrate(section) || section);
      await writeFile(outBase + importExt, JSON.stringify(content, null, 2));
      importPackRef = { packUuid, position };
      importRecovered = true;
    }
  }

  // --- Meta (basename+ext+.meta beside recovered file; no orphans) ---
  await writeMeta(outBase, uuid, className, {
    wasCcon: importFromCcon,
    packRef: importPackRef,
    flavor,
    importExt,
    importRecovered,
    nativeExt: recoveredNativeExt,
    nativeRecovered,
    assetPath: info.path || null,
    subMetas: buildImageSubMetas(cfg, info),
  });

  return importRecovered || nativeRecovered;
}


/**
 * Map Texture2D / SpriteFrame entries marked `subAsset` onto their parent
 * ImageAsset (or Texture2D) path. Creator 3.x stores these as:
 *   textures/logo@6c48a   or   textures/logo/texture|spriteFrame
 */
function indexImageSubAssets(cfg) {
  const byParent = new Map();
  const childUuids = new Set();
  const paths = cfg.paths || {};

  const addChild = (parentPath, uuid, type, relPath) => {
    if (!parentPath || !uuid || childUuids.has(uuid)) return;
    const displayName = displayNameOfSubAsset(relPath || uuid, type);
    if (!byParent.has(parentPath)) byParent.set(parentPath, []);
    byParent.get(parentPath).push({
      uuid,
      type: type || null,
      path: relPath || null,
      displayName,
    });
    childUuids.add(uuid);
  };

  // 1) Named subAssets from config.paths (Texture2D / SpriteFrame).
  for (const uuid of Object.keys(paths)) {
    const info = paths[uuid];
    if (!info) continue;
    const parentPath = parentPathOfSubAsset(info.path);
    // Require a recognizable parent path shape — the release `paths` third
    // field is often `1` even for ImageAsset/SceneAsset, so don't trust the
    // flag alone.
    if (!parentPath) continue;
    if (!info.subAsset && info.type !== 'cc.Texture2D' && info.type !== 'cc.SpriteFrame') {
      continue;
    }
    addChild(parentPath, uuid, info.type, info.path);
  }

  // 2) UUID-only `@6c48a` / `@f9941` siblings (common in scene bundles where
  //    the ImageAsset has no addressable path). Fold onto the parent's path
  //    when known, otherwise onto the same `_packed/<2>/<base>` slot the
  //    catch-all pass uses for the parent ImageAsset.
  const uuidSet = new Set(cfg.uuids || []);
  for (const uuid of cfg.uuids || []) {
    if (childUuids.has(uuid)) continue;
    const at = uuid.indexOf('@');
    if (at <= 0) continue;
    const suffix = uuid.slice(at + 1);
    // Skip multi-@ compressed format variants (uuid@mip@astc) — those are
    // separate native blobs, not ImageAsset subMetas.
    if (!suffix || suffix.includes('@')) continue;
    const base = uuid.slice(0, at);
    if (!uuidSet.has(base) && !paths[base]) continue;

    let parentPath = null;
    if (paths[base] && paths[base].path) {
      parentPath = parentPathOfSubAsset(paths[base].path) || paths[base].path;
    } else {
      parentPath = `_packed/${base.slice(0, 2)}/${base}`;
    }
    const typeHint = /^f9941$/i.test(suffix)
      ? 'cc.SpriteFrame'
      : (/^6c48a$/i.test(suffix) ? 'cc.Texture2D' : null);
    addChild(parentPath, uuid, typeHint, paths[uuid] ? paths[uuid].path : null);
  }

  return { byParent, childUuids };
}

function parentPathOfSubAsset(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  const at = relPath.lastIndexOf('@');
  if (at > 0) return relPath.slice(0, at);
  const m = relPath.match(/^(.*)\/(texture|spriteFrame|sprite-frame)$/i);
  return m ? m[1] : null;
}

/**
 * Choose the on-disk file path for an asset. Strips Creator ImageAsset subAsset
 * segments (`/texture`, `/spriteFrame`, `@6c48a`, `@f9941`) so natives never
 * land at `UI_res/headimage/texture.png`. Does NOT strip mip/format suffixes
 * like `@b47c0@40c10` — those are distinct native blobs.
 */
function normalizeAssetFilePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return relPath;
  const slash = relPath.match(/^(.*)\/(texture|spriteFrame|sprite-frame)$/i);
  if (slash) return slash[1];
  const atKnown = relPath.match(/^(.*)@(6c48a|f9941)$/i);
  if (atKnown) return atKnown[1];
  return relPath;
}

function displayNameOfSubAsset(relPath, type) {
  if (type === 'cc.Texture2D') return 'texture';
  if (type === 'cc.SpriteFrame') return 'spriteFrame';
  if (!relPath) return 'sub';
  const at = relPath.lastIndexOf('@');
  if (at > 0) return relPath.slice(at + 1) || 'sub';
  const base = path.basename(relPath);
  if (/^sprite-?frame$/i.test(base)) return 'spriteFrame';
  if (/^texture$/i.test(base)) return 'texture';
  return base || 'sub';
}

function shortMetaId(uuid) {
  const s = String(uuid || '');
  // Creator sub-assets use the @suffix as the meta id (6c48a / f9941). Using the
  // compressed-base prefix collided Texture2D + SpriteFrame into one slot.
  const at = s.lastIndexOf('@');
  if (at >= 0 && at < s.length - 1) {
    return (s.slice(at + 1) || '00000').toLowerCase();
  }
  const hex = s.replace(/-/g, '');
  return (hex.slice(0, 5) || '00000').toLowerCase();
}

/**
 * Build Creator-layout subMetas for an ImageAsset / texture parent from folded
 * child uuids. Returns null when nothing to fold.
 */
function buildImageSubMetas(cfg, info) {
  if (!cfg || !info || !info.path) return null;
  if (!cfg._imageSubByParent) return null;
  const children = cfg._imageSubByParent.get(info.path);
  if (!children || children.length === 0) return null;

  const subMetas = {};
  for (const child of children) {
    const id = shortMetaId(child.uuid);
    const name = child.displayName || 'sub';
    const importer = classToImporter(child.type) || 'asset';
    subMetas[id] = {
      ver: '1.0.1',
      uuid: child.uuid,
      importer,
      displayName: name,
      id,
      name,
      userData: {},
      subMetas: {},
    };
  }
  return subMetas;
}

function classOutputDir(className) {
  if (!className) return 'raw';
  return CLASS_DIR[className] || 'raw';
}

/**
 * Look for a `_native` string inside a legacy plain-form 3.x document and
 * return its extension (if any).
 */
/**
 * Last-resort: scan native/<2>/ for any file whose basename matches `uuid`.
 * Returns { src, ext } or null.
 */
/**
 * Copy native files that were never claimed by a uuid in config.uuids.
 * Filenames look like `<uuid>[@mip][@fmt].<ext>` under native/<2>/.
 */
async function sweepOrphanNatives(cfg, bundleOut, handled, result) {
  const nativeRoot = path.join(cfg.baseDir, cfg.nativeBase);
  if (!fs.existsSync(nativeRoot)) return;

  let prefixes;
  try {
    prefixes = await readdir(nativeRoot, { withFileTypes: true });
  } catch {
    return;
  }

  // Build a set of uuid stems we already recovered natives for (exact + base).
  const claimed = new Set();
  for (const u of handled) {
    if (!u) continue;
    claimed.add(u);
    const at = u.indexOf('@');
    if (at > 0) claimed.add(u.slice(0, at));
  }

  for (const pref of prefixes) {
    if (!pref.isDirectory()) continue;
    const dir = path.join(nativeRoot, pref.name);
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = entry.match(/^([0-9a-fA-F-]{36}(?:@[0-9a-zA-Z]+)*)(\.[^.]+)$/);
      if (!m) continue;
      const fileUuid = m[1];
      const ext = m[2];
      // Skip if this exact uuid was handled, or its base ImageAsset was handled
      // and this is a simple @6c48a/@f9941 meta-only id without its own bytes
      // already claimed via glob on the parent… Still copy distinct @mip@fmt.
      if (handled.has(fileUuid)) continue;
      const base = fileUuid.indexOf('@') > 0 ? fileUuid.slice(0, fileUuid.indexOf('@')) : fileUuid;
      // If the exact file was already copied as the native of `fileUuid` or
      // `base` (same basename), skip. We detect via output existence.
      const rel = `_packed/${fileUuid.slice(0, 2)}/${fileUuid}`;
      const dest = path.join(bundleOut, rel + ext);
      if (fs.existsSync(dest)) continue;
      // Also skip when parent ImageAsset already took a same-ext native at its
      // path and this entry is only `@6c48a`/`@f9941` (no extra mip/format).
      const suffix = fileUuid.includes('@') ? fileUuid.slice(fileUuid.indexOf('@') + 1) : '';
      if (suffix && !suffix.includes('@') && /^(6c48a|f9941)$/i.test(suffix)) {
        continue; // meta-only subAsset ids — no separate native expected
      }
      if (claimed.has(fileUuid)) continue;

      const src = path.join(dir, entry);
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
        result.nativeFiles += 1;
        const extLower = ext.toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp', '.pvr', '.pkm', '.astc'].includes(extLower)) {
          result.nativeImages += 1;
        }
        if (result.sampleNativePaths.length < 8) {
          result.sampleNativePaths.push(rel + ext);
        }
        // Mark handled so we don't double-count if called twice.
        handled.add(fileUuid);
        logger.debug(`Orphan native: ${rel}${ext}`);
      } catch (err) {
        logger.debug(`Orphan native skip ${entry}: ${err.message}`);
      }
    }
  }
}

async function globNativeByUuid(cfg, uuid) {
  const dir = path.join(cfg.baseDir, cfg.nativeBase, uuid.slice(0, 2));
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  // Match both "<uuid>.<ext>" and "<uuid>.<ver>.<ext>"
  for (const entry of entries) {
    if (!entry.startsWith(uuid)) continue;
    const rest = entry.slice(uuid.length);
    if (rest === '' || rest[0] !== '.') continue;
    // Strip version segment if present.
    const lastDot = rest.lastIndexOf('.');
    const ext = lastDot >= 0 ? rest.slice(lastDot) : rest;
    if (!KNOWN_NATIVE_EXTS.has(ext.toLowerCase())) {
      // Still copy unknown extensions — better than dropping the file.
    }
    return { src: path.join(dir, entry), ext };
  }
  return null;
}

/**
 * Attempt to rehydrate an IFileData tuple back to source-format JSON.
 * Returns the rehydrated array on success, null if the document isn't in a
 * form we can process (we fall back to writing the raw document as-is).
 */
/**
 * Extract one asset section out of an IPackedFileData and splice it together
 * with the pack's shared header to form a standalone IFileData tuple.
 *
 * IPackedFileData layout:
 *   [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections[]]
 * Each section is the "data area" of an IFileData:
 *   [instances, instanceTypes, refs, dependObjs, dependKeys, dependUuidIndices]
 *
 * Results are cached per-bundle so we only parse each pack file once.
 */
async function extractPackSection(cfg, packUuid, position) {
  if (!cfg._packCache) cfg._packCache = new Map();
  let pack = cfg._packCache.get(packUuid);
  if (!pack) {
    const packSrc = getImportPath(cfg, packUuid, '.json');
    if (!packSrc || !fs.existsSync(packSrc)) return null;
    try {
      pack = JSON.parse(await readFile(packSrc, 'utf-8'));
    } catch {
      pack = null;
    }
    cfg._packCache.set(packUuid, pack);
  }
  if (!Array.isArray(pack) || pack.length < 6) return null;

  const sections = pack[5];
  if (!Array.isArray(sections) || position < 0 || position >= sections.length) {
    return null;
  }
  const section = sections[position];
  if (!Array.isArray(section)) return null;

  // Splice shared header + section data into a standalone IFileData.
  // Section layout (same order as File.Instances onwards):
  //   [instances, instanceTypes, refs, dependObjs, dependKeys, dependUuidIndices]
  return [
    pack[0],                              // version
    pack[1],                              // sharedUuids
    pack[2],                              // sharedStrings
    pack[3],                              // sharedClasses
    pack[4],                              // sharedMasks
    section[0] || [],                     // instances
    section[1] || 0,                      // instanceTypes
    section[2] || null,                   // refs
    section[3] || [],                     // dependObjs
    section[4] || [],                     // dependKeys
    section[5] || [],                     // dependUuidIndices
  ];
}

function tryRehydrate(doc) {
  try {
    if (!Array.isArray(doc) || doc.length < 6) return null;
    // Skip IPackedFileData ({ sections: [...] }) for now — would need to
    // split each section out to its own file. Preserving raw JSON is fine.
    if (doc && typeof doc === 'object' && Array.isArray(doc.sections)) return null;
    return rehydrateIFileData(doc);
  } catch {
    return null;
  }
}

function probeNativeExtension(doc) {
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (typeof obj._native === 'string' && obj._native.length > 0) {
      const n = obj._native;
      const m = n.match(/(\.[A-Za-z0-9]{2,5})$/);
      if (m && KNOWN_NATIVE_EXTS.has(m[1].toLowerCase())) return m[1];
    }
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const r = visit(it, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      const r = visit(obj[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return visit(doc, 0);
}

async function decodeCconToDoc(buf, outBase) {
  const decoded = decodeCcon(buf);
  // Both v1 (JSON) and v2 (notepack) yield a `document` when decodable.
  if (decoded.document) {
    // Persist chunks alongside the JSON so mesh/animation payloads are not lost.
    for (let i = 0; i < decoded.chunks.length; i += 1) {
      await writeFile(`${outBase}.chunk${i}.bin`, decoded.chunks[i]);
    }
    return decoded.document;
  }
  // Undecodable v2 body — preserve the raw blob so nothing is silently lost.
  if (decoded.rawJson) {
    logger.warn(`CCON v2 body could not be decoded, kept raw: ${path.basename(outBase)}.ccon-v2.rawjson`);
    await writeFile(outBase + '.ccon-v2.rawjson', decoded.rawJson);
  }
  for (let i = 0; i < decoded.chunks.length; i += 1) {
    await writeFile(`${outBase}.chunk${i}.bin`, decoded.chunks[i]);
  }
  return null;
}

async function writeMeta(outBase, uuid, className, opts = {}) {
  const {
    wasCcon = false,
    packRef = null,
    flavor = null,
    importExt = null,
    importRecovered = false,
    nativeExt = null,
    nativeRecovered = false,
    subMetas = null,
  } = opts;

  // Decide which file the meta sits beside: basename + ext + '.meta'
  // (e.g. logo.png.meta, Main.scene.meta). Never emit orphan .png.meta when
  // the native was not recovered (#33).
  let fileExt = null;

  if (isPureNativeClass(className)) {
    if (!nativeRecovered) return;
    fileExt = nativeExt || '';
  } else if (className === 'cc.SpriteFrame' && nativeRecovered) {
    // Prefer colocating with the actual PNG when present.
    fileExt = nativeExt || '.png';
  } else if (importRecovered) {
    fileExt = importExt || inferImportExt(className, flavor);
  } else if (nativeRecovered) {
    fileExt = nativeExt || '';
  } else {
    return;
  }

  const metaPath = outBase + fileExt + '.meta';
  const meta = {
    ver: '1.2.7',
    uuid,
    importer: classToImporter(className),
    downloadMode: 0,
    duration: 0,
    subMetas: (subMetas && typeof subMetas === 'object') ? subMetas : {},
  };
  if (wasCcon) meta.source = 'ccon';
  if (packRef) {
    meta.packedIn = packRef.packFile || packRef.packUuid;
    meta.packPosition = packRef.position;
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function inferMetaExt(className, flavor) {
  // Kept for callers/tests: mirrors the primary asset file extension.
  return inferImportExt(className, flavor);
}

function inferImportExt(className, flavor) {
  switch (className) {
    case 'cc.SceneAsset':
      // True 3.x builds use .scene; 2.4 bundle / classic keep .fire (#32).
      return flavor === '3.x' ? '.scene' : '.fire';
    case 'cc.Prefab':        return '.prefab';
    case 'cc.EffectAsset':   return '.effect';
    case 'cc.Material':      return '.mtl';
    case 'cc.AnimationClip': return '.anim';
    default:                 return '.json';
  }
}

function isPureNativeClass(className) {
  switch (className) {
    case 'cc.Texture2D':
    case 'cc.ImageAsset':
    case 'cc.TextureCube':
    case 'cc.AudioClip':
    case 'cc.TTFFont':
    case 'cc.BitmapFont':
    case 'cc.LabelAtlas':
      return true;
    default:
      return false;
  }
}

function classToImporter(className) {
  if (!className) return 'asset';
  const map = {
    'cc.SceneAsset': 'scene',
    'cc.Prefab': 'prefab',
    'cc.SpriteFrame': 'sprite-frame',
    'cc.ImageAsset': 'image',
    'cc.Texture2D': 'texture',
    'cc.AudioClip': 'audio-clip',
    'cc.TextAsset': 'text',
    'cc.JsonAsset': 'json',
    'cc.Mesh': 'mesh',
    'cc.Material': 'material',
    'cc.EffectAsset': 'effect',
    'cc.AnimationClip': 'animation-clip',
    'sp.SkeletonData': 'spine',
  };
  return map[className] || 'asset';
}

/**
 * Recover user scripts from src/chunks (SystemJS) into assets/Scripts.
 *
 * Engine/vendor noise (cocos-js wasm wrappers, builtin-pipeline, rollup helpers,
 * bundle entry stubs) lands under assets/Scripts/_vendor/ so game scripts stay
 * easy to browse.
 *
 * 3.x ships TypeScript compiled to ES5. We preserve filenames where possible.
 */
async function recoverScripts(sourcePath, outputPath, verbose, extras = {}) {
  const { key = null, warnings = [] } = extras;
  const scriptsOut = path.join(outputPath, 'assets', 'Scripts');
  const concurrency = getMaxParallel();
  let total = 0;
  let game = 0;
  let vendor = 0;

  const tallyEmit = (rel) => {
    total += 1;
    if (isUnderVendor(rel)) vendor += 1;
    else game += 1;
  };

  // 1) src/chunks (+ other dirs): copy single SystemJS modules; split when a
  //    file contains multiple System.register calls (#23 / multi-chunk packs).
  //    Entire cocos-js/ tree is treated as vendor (spine/bullet/_virtual_cc).
  const candidates = [
    { dir: path.join(sourcePath, 'src', 'chunks'), forceVendor: false },
    { dir: path.join(sourcePath, 'src'), forceVendor: false },
    { dir: path.join(sourcePath, 'cocos-js'), forceVendor: true },
  ];
  const copyJobs = [];

  for (const { dir, forceVendor } of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      if (entry.name.startsWith('system.') || entry.name.startsWith('polyfills.')) continue;
      if (entry.name === 'cc.js') continue;
      if (entry.name === 'settings.js') continue;
      const rel = scriptOutRel(entry.name, { forceVendor });
      copyJobs.push({
        src: path.join(dir, entry.name),
        dest: path.join(scriptsOut, rel),
        rel,
        label: entry.name,
        forceVendor,
      });
    }
  }

  // Recursive walk of src/assets/ (WeChat mini-game "_plugs" / plugin SDKs)
  const srcAssets = path.join(sourcePath, 'src', 'assets');
  if (fs.existsSync(srcAssets)) {
    for await (const file of walkJsFiles(srcAssets)) {
      const rel = path.posix.join('plugs', path.relative(srcAssets, file).split(path.sep).join('/'));
      copyJobs.push({
        src: file,
        dest: path.join(scriptsOut, rel),
        rel,
        label: rel,
        forceVendor: false,
      });
    }
  }

  await forEachPool(copyJobs, concurrency, async ({ src, dest, rel, label }) => {
    let code;
    try {
      code = await readFile(src, 'utf-8');
    } catch {
      return;
    }
    const registers = countSystemRegisters(code);
    if (registers > 1) {
      const split = await splitAndEmitSystemRegisters(code, scriptsOut, verbose);
      total += split.total;
      game += split.game;
      vendor += split.vendor;
      if (verbose) logger.debug(`Script chunk demux: ${label} → ${split.total} modules`);
      return;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, code);
    await writeScriptMeta(dest, extractRfUuid(code));
    tallyEmit(rel);
    if (verbose) logger.debug(`Script: ${rel}`);
  });

  // 2) Demux packed bundle index.js / game.js into assets/Scripts (#23).
  //    Still keep the raw copy under assets/<bundle>/ from unpackBundle.
  const bundleRoots = [
    path.join(sourcePath, 'assets'),
    path.join(sourcePath, 'subpackages'),
  ];
  for (const root of bundleRoots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundleDir = path.join(root, entry.name);
      await maybeDecryptBundleScripts(bundleDir, key, warnings);
      for (const scriptName of ['index.js', 'game.js']) {
        const src = path.join(bundleDir, scriptName);
        if (!fs.existsSync(src)) continue;
        let code;
        try {
          code = await readFile(src, 'utf-8');
        } catch {
          continue;
        }
        // Skip tiny stubs
        if (code.length < 80) continue;
        try {
          // Rollup / SystemJS packs (Creator 3.x web-mobile): never treat as
          // browserify — that yields a single bogus `setters.ts`.
          const registers = countSystemRegisters(code);
          if (registers > 0) {
            const written = await splitAndEmitSystemRegisters(code, scriptsOut, verbose);
            total += written.total;
            game += written.game;
            vendor += written.vendor;
            if (verbose || written.total > 0) {
              logger.info(
                `Demux ${entry.name}/${scriptName}: ${written.total} System.register modules `
                + `(game=${written.game}, vendor=${written.vendor})`,
              );
            }
            continue;
          }
          const result = await recoverScripts2x(code, {
            outputPath,
            verbose,
            noAstFallback: false,
          });
          const written = (result && result.written) || 0;
          total += written;
          game += written;
          if (verbose || written > 0) {
            logger.info(
              `Demux ${entry.name}/${scriptName}: ${written} modules `
              + `(extractor=${result.extractor}, format=${result.format})`,
            );
          }
        } catch (err) {
          const msg = `demux ${entry.name}/${scriptName}: ${err.message}`;
          warnings.push(msg);
          logger.debug(msg);
        }
      }
    }
  }

  // Preserve top-level bootstrap scripts under _boot/.
  const bootFiles = [
    'main.js', 'game.js', 'game.json', 'ccRequire.js',
    'adapter-min.js', 'physics-min.js',
  ];
  const bootOut = path.join(outputPath, '_boot');
  for (const name of bootFiles) {
    const src = path.join(sourcePath, name);
    if (fs.existsSync(src)) {
      await mkdir(bootOut, { recursive: true });
      await copyFile(src, path.join(bootOut, name));
    }
  }
  const cocosDir = path.join(sourcePath, 'cocos');
  if (fs.existsSync(cocosDir)) {
    const cocosOut = path.join(bootOut, 'cocos');
    await mkdir(cocosOut, { recursive: true });
    const cocosEntries = await readdir(cocosDir, { withFileTypes: true });
    await forEachPool(
      cocosEntries.filter((e) => e.isFile()),
      concurrency,
      async (e) => {
        await copyFile(path.join(cocosDir, e.name), path.join(cocosOut, e.name));
      },
    );
  }

  if (verbose || vendor > 0) {
    logger.info(`Scripts: ${game} game, ${vendor} vendor → assets/Scripts/_vendor/`);
  }

  return { total, game, vendor };
}

/**
 * Decrypt bundle index.jsc / game.jsc to sibling .js when the plain JS is
 * missing. Uses existing jscDecryptor + --key / auto-key from reverseEngine.
 */
async function maybeDecryptBundleScripts(bundleDir, key, warnings) {
  for (const base of ['index', 'game']) {
    const jscPath = path.join(bundleDir, `${base}.jsc`);
    const jsPath = path.join(bundleDir, `${base}.js`);
    if (!fs.existsSync(jscPath)) continue;
    if (fs.existsSync(jsPath)) continue;
    if (!key) {
      const msg = `${path.basename(bundleDir)}/${base}.jsc present but no decrypt key`;
      logger.warn(msg);
      if (Array.isArray(warnings)) warnings.push(msg);
      continue;
    }
    try {
      const data = await readFile(jscPath);
      const decrypted = decryptJscBuffer(data, key);
      if (!decrypted || decrypted.length === 0) {
        const msg = `Failed to decrypt ${base}.jsc in ${path.basename(bundleDir)}`;
        logger.warn(msg);
        if (Array.isArray(warnings)) warnings.push(msg);
        continue;
      }
      await writeFile(jsPath, decrypted);
      logger.info(`Decrypted ${path.basename(bundleDir)}/${base}.jsc → ${base}.js`);
    } catch (err) {
      const msg = `decrypt ${base}.jsc: ${err.message}`;
      logger.warn(msg);
      if (Array.isArray(warnings)) warnings.push(msg);
    }
  }
}

function countSystemRegisters(code) {
  if (!code) return 0;
  const matches = code.match(/System\s*\.\s*register\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * Split a multi-register SystemJS chunk into per-module files under scriptsOut.
 * Only string-literal register ids are emitted (chunks:///_virtual/Foo.ts → Foo.ts);
 * anonymous / variable-id rollup wrappers are skipped.
 * Engine/vendor modules go under scriptsOut/_vendor/.
 *
 * @returns {{ total: number, game: number, vendor: number }}
 */
async function splitAndEmitSystemRegisters(code, scriptsOut, verbose) {
  const parts = splitSystemRegisterSource(code);
  let total = 0;
  let game = 0;
  let vendor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const safe = sanitizeScriptFileName(part.id || `module_${i}`);
    const rel = scriptOutRel(safe);
    const dest = path.join(scriptsOut, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    // Avoid clobbering an already-emitted module with the same id.
    let finalDest = dest;
    let finalRel = rel;
    if (fs.existsSync(finalDest)) {
      const ext = path.extname(safe) || '.js';
      const stem = rel.slice(0, rel.length - ext.length);
      finalRel = `${stem}_${i}${ext}`;
      finalDest = path.join(scriptsOut, finalRel);
    }
    await writeFile(finalDest, part.code);
    await writeScriptMeta(finalDest, part.uuid);
    total += 1;
    if (isUnderVendor(finalRel)) vendor += 1;
    else game += 1;
    if (verbose) logger.debug(`SystemJS split: ${finalRel}`);
  }
  return { total, game, vendor };
}

function splitSystemRegisterSource(code) {
  const markerRe = /System\s*\.\s*register\s*\(/g;
  const starts = [];
  let m;
  while ((m = markerRe.exec(code)) !== null) {
    starts.push(m.index);
  }
  if (starts.length === 0) return [];

  // Only emit registers with a string literal id (chunks:///_virtual/Foo.ts).
  // Skip anonymous / variable-id registers (rollup wrappers like
  // System.register([], ...) and System.register(mid, [cid], ...)) — those
  // previously became bogus module_N.js stubs, and nested wrappers truncated
  // the outer shell at the inner register start.
  const parts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const endStmt = findRegisterStatementEnd(code.slice(from));
    if (endStmt <= 0) continue; // incomplete / unclosed
    const chunk = code.slice(from, from + endStmt).trim();
    const idMatch = chunk.match(
      /^System\s*\.\s*register\s*\(\s*['"]([^'"]+)['"]\s*,/,
    );
    if (!idMatch) continue;
    const uuid = extractRfUuid(chunk);
    parts.push({
      id: idMatch[1],
      uuid,
      code: chunk.endsWith('\n') ? chunk : `${chunk}\n`,
    });
  }
  return parts;
}
function findRegisterStatementEnd(chunk) {
  // Find matching paren for System.register( ... ) then optional ';'
  const open = chunk.indexOf('(');
  if (open < 0) return -1;
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = open; i < chunk.length; i += 1) {
    const ch = chunk[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        if (chunk[end] === ';') end += 1;
        return end;
      }
    }
  }
  return -1;
}

function extractRfUuid(code) {
  if (!code) return null;
  // Minified 3.x packs alias `cc` (e.g. `s._RF.push(...)`) — match any receiver.
  const rf = code.match(
    /(?:[A-Za-z_$][\w$]*\s*\.\s*)?_RF\s*\.\s*push\s*\(\s*[^,]+,\s*['"]([0-9a-fA-F-]{22,36}|[A-Za-z0-9+/=]{20,24})['"]/,
  );
  return rf ? rf[1] : null;
}

/**
 * Basename patterns for engine/vendor noise that should not clutter Scripts/.
 * Matched after sanitizeScriptFileName (extension stripped for comparison).
 */
const VENDOR_SCRIPT_BASENAMES = new Set([
  'main', 'internal', 'resources', 'env', 'import-map',
  'rollupPluginModLoBabelHelpers',
  'debug-view-runtime-control',
]);

/**
 * @param {string} relPathOrId  sanitized relative path or register id
 * @returns {boolean}
 */
function isEngineVendorScript(relPathOrId) {
  const raw = String(relPathOrId || '');
  // Strip known virtual prefixes when callers pass a raw register id.
  let p = raw
    .replace(/^chunks:\/\/\/_virtual\//i, '')
    .replace(/^chunks:\/\//i, '');
  const base = path.basename(p).replace(/\.(tsx?|jsx?)$/i, '');
  if (!base) return false;
  if (VENDOR_SCRIPT_BASENAMES.has(base)) return true;
  if (/^_virtual_cc/i.test(base)) return true;
  if (/^spine([.\-_]|$)/i.test(base)) return true;
  if (/^bullet([.\-_]|$)/i.test(base)) return true;
  if (/^rollupPluginModLoBabelHelpers/i.test(base)) return true;
  if (/^builtin-pipeline/i.test(base)) return true;
  return false;
}

function isUnderVendor(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  return n === '_vendor' || n.startsWith('_vendor/');
}

/**
 * Place engine/vendor scripts under `_vendor/` (posix-style relative path).
 * @param {string} sanitizedRel
 * @param {{ forceVendor?: boolean }} [opts]
 * @returns {string}
 */
function scriptOutRel(sanitizedRel, opts = {}) {
  const forceVendor = !!(opts && opts.forceVendor);
  let rel = String(sanitizedRel || 'module.js').replace(/^[/\\]+/, '');
  rel = rel.split(/[/\\]+/).filter(Boolean).join('/');
  if (!rel) rel = 'module.js';
  if (isUnderVendor(rel)) return rel;
  if (forceVendor || isEngineVendorScript(rel)) {
    return `_vendor/${rel}`;
  }
  return rel;
}

/**
 * Derive a filesystem path under assets/Scripts from a System.register id.
 * `chunks:///_virtual/Foo.ts` → `Foo.ts`
 * `chunks:///_virtual/game/Bar.ts` → `game/Bar.ts`
 */
function sanitizeScriptFileName(id) {

  let p = String(id || 'module');
  p = p
    .replace(/^chunks:\/\/\/_virtual\//i, '')
    .replace(/^chunks:\/\//i, '')
    .replace(/^file:\/\/\//i, '')
    .replace(/^db:\/\/assets\//i, '')
    .replace(/^db:\/+/i, '')
    .replace(/^assets\//i, '')
    .replace(/^src\//i, '');
  p = p.replace(/^[/\\]+/, '').replace(/\0/g, '');

  let ext = '';
  const extMatch = p.match(/\.(tsx?|jsx?)$/i);
  if (extMatch) {
    ext = extMatch[0];
    p = p.slice(0, -ext.length);
  } else {
    ext = '.js';
  }

  const parts = p.split(/[/\\]+/)
    .map((seg) => seg.replace(/\.\./g, '_').replace(/[?%*:|"<>]/g, '_'))
    .filter(Boolean);
  if (parts.length === 0) parts.push('module');
  return `${parts.join('/')}${ext}`;
}

async function* walkJsFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkJsFiles(full);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      yield full;
    }
  }
}

async function writeScriptMeta(scriptPath, uuidHint) {
  let uuid = uuidHint || null;
  if (uuid && uuid.length === 22) {
    uuid = uuidUtils.decodeUuid(uuid) || uuid;
  }
  if (!uuid) uuid = uuidUtils.generateUuid();
  const meta = {
    ver: '1.0.8',
    uuid,
    isPlugin: false,
    loadPluginInWeb: true,
    loadPluginInNative: true,
    loadPluginInEditor: false,
    subMetas: {},
  };
  await writeFile(scriptPath + '.meta', JSON.stringify(meta, null, 2));
}

async function writeProjectDescriptor(outputPath) {
  const descriptor = {
    name: 'recovered-cocos3-project',
    version: '3.0.0',
    engine: 'cocos-creator-3',
    packages: ['assets'],
    recoveredBy: 'cc-reverse',
  };
  await writeFile(
    path.join(outputPath, 'project.json'),
    JSON.stringify(descriptor, null, 2),
  );
}

// writeRecoveryReport imported from ../../utils/recoveryReport

module.exports = {
  reverseProject3x,
  discoverBundles,
  inferImportExt,
  inferMetaExt,
  writeMeta,
  splitSystemRegisterSource,
  splitAndEmitSystemRegisters,
  countSystemRegisters,
  sanitizeScriptFileName,
  isEngineVendorScript,
  scriptOutRel,
  indexImageSubAssets,
  parentPathOfSubAsset,
  normalizeAssetFilePath,
  buildImageSubMetas,
  shortMetaId,
  extractRfUuid,
};

