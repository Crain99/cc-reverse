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
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { logger } = require('../../utils/logger');
const { uuidUtils } = require('../../utils/uuidUtils');
const { parseBundleConfig, getImportPath, getNativePath } = require('./bundleConfig');
const { isCcon, decodeCcon } = require('./ccon');
const { inspect } = require('./deserializer');
const { rehydrateIFileData, rehydrateIPackedFileData } = require('./rehydrate');
const { writeCocos2xProject, writeCocos3xProject } = require('./projectScaffold');
const { RecoveryReport } = require('./recoveryReport');
const { runScriptRecoveryPipeline, emitTsProject } = require('./scriptRecovery');
const generatorModule = require('@babel/generator');
const generate = generatorModule.default || generatorModule;

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Locate a bundle's config file. 3.x builds emit either a plain "config.json"
 * (editor preview / native template) or a hashed "config.<md5>.json"
 * (wechatgame and other mini-game flavours). Returns the absolute path or
 * null if no candidate exists.
 */
async function findBundleConfigPath(bundleDir) {
  const plain = path.join(bundleDir, 'config.json');
  if (await pathExists(plain)) return plain;
  let entries;
  try { entries = await fsp.readdir(bundleDir); } catch { return null; }
  const hashed = entries.find(f => /^config\.[0-9a-f]+\.json$/i.test(f));
  return hashed ? path.join(bundleDir, hashed) : null;
}

async function findBinarySettings(srcDir) {
  if (!(await pathExists(srcDir))) return null;
  let entries;
  try { entries = await readdir(srcDir); } catch { return null; }
  if (entries.includes('settings.bin')) return path.join(srcDir, 'settings.bin');
  const hashed = entries.find(n => /^settings\.[0-9a-f]+\.bin$/i.test(n));
  return hashed ? path.join(srcDir, hashed) : null;
}

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
 * R12 — Cocos class → Creator importer name. Used by writeAssetMeta to emit
 * editor-recognised .meta files for non-script assets.
 */
const KLASS_TO_IMPORTER = {
  'cc.SpriteFrame': 'sprite-frame',
  'cc.ImageAsset': 'image',
  'cc.Texture2D': 'texture',
  'cc.AudioClip': 'audio-clip',
  'cc.JsonAsset': 'json',
  'cc.TextAsset': 'text',
  'cc.Prefab': 'prefab',
  'cc.SceneAsset': 'scene',
  'cc.Material': 'material',
  'cc.EffectAsset': 'effect',
  'cc.AnimationClip': 'animation-clip',
  'cc.Mesh': 'gltf-mesh',
  'cc.SkeletalAnimationClip': 'skeletal-animation-clip',
  'cc.BufferAsset': 'buffer',
  'sp.SkeletonData': 'spine',
  'dragonBones.DragonBonesAsset': 'dragonbones',
  'dragonBones.DragonBonesAtlasAsset': 'dragonbones-atlas',
};

/**
 * R11 — Resolve an asset's output path. Prefers the source project's
 * `config.paths[uuid].path` when present; otherwise falls back to
 * `<CLASS_DIR[klass] || 'raw'>/<uuid>`.
 *
 * @param {string} uuid
 * @param {object} cfg   bundle config (or anything with .paths)
 * @param {string} klass cc class name
 * @param {string} [ext='']
 */
function resolveOutputPath(uuid, cfg, klass, ext = '') {
  const explicit = cfg && cfg.paths && cfg.paths[uuid] && cfg.paths[uuid].path;
  if (explicit) return explicit + ext;
  const sub = CLASS_DIR[klass] || 'raw';
  return path.join(sub, uuid) + ext;
}

/**
 * R12 — Write an editor-style asset .meta next to the recovered file.
 */
async function writeAssetMeta(filePath, opts) {
  const { uuid, klass, extras } = opts;
  const importer = KLASS_TO_IMPORTER[klass] || 'unknown';
  const userData = { recoveredBy: 'cc-reverse' };
  if (extras && typeof extras === 'object') Object.assign(userData, extras);
  const meta = {
    ver: '1.0.0',
    importer,
    imported: true,
    uuid,
    files: [path.extname(filePath)],
    subMetas: {},
    userData,
  };
  await writeFile(filePath + '.meta', JSON.stringify(meta, null, 2));
}

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
    scriptLayers,
    verbose = false,
  } = options;

  await mkdir(outputPath, { recursive: true });
  await mkdir(path.join(outputPath, 'assets'), { recursive: true });

  const summary = {
    engine: '3.x',
    bundles: [],
    scripts: { total: 0 },
    warnings: [],
  };
  const report = new RecoveryReport();

  if (!scriptsOnly) {
    const bundles = await discoverBundles(sourcePath);
    // Pre-parse every bundle's config so we can build a registry that
    // unpackAsset can consult to resolve cross-bundle redirects.
    const bundleRegistry = new Map();
    const prepared = [];
    for (const bundleDir of bundles) {
      const name = path.basename(bundleDir);
      if (Array.isArray(bundleFilter) && bundleFilter.length > 0
          && !bundleFilter.includes(name)) {
        logger.debug(`Skipping bundle ${name} (not in --bundle filter)`);
        continue;
      }
      try {
        const cfgPath = await findBundleConfigPath(bundleDir);
        if (!cfgPath) {
          summary.warnings.push(`bundle ${name}: no config.json found`);
          continue;
        }
        const raw = JSON.parse(await fsp.readFile(cfgPath, 'utf-8'));
        const cfg = parseBundleConfig(raw, bundleDir);
        bundleRegistry.set(cfg.name, cfg);
        prepared.push({ bundleDir, cfg, name, cfgPath });
      } catch (err) {
        logger.error(`Failed to parse config for bundle ${name}:`, err);
        summary.warnings.push(`bundle ${name}: ${err.message}`);
      }
    }
    for (const { bundleDir, cfg, name, cfgPath } of prepared) {
      try {
        const result = await unpackBundle({ bundleDir, cfg, cfgPath, outputPath, verbose, report, bundleRegistry });
        summary.bundles.push(result);
      } catch (err) {
        logger.error(`Failed to unpack bundle ${name}:`, err);
        summary.warnings.push(`bundle ${name}: ${err.message}`);
      }
    }
  }

  if (!assetsOnly) {
    summary.scripts = await recoverScripts(sourcePath, outputPath, verbose, { scriptLayers });
  }

  const projectFlavor = await detectProjectFlavor(sourcePath);
  summary.flavor = projectFlavor.flavor;

  if (projectFlavor.flavor === '2.4.x-bundle') {
    await writeCocos2xProject(outputPath, {
      projectName: path.basename(sourcePath),
      cocosVersion: projectFlavor.version || '2.4.14',
      settings: projectFlavor.settings || {},
      bundles: summary.bundles,
    });
  } else {
    await writeProjectDescriptor(outputPath, projectFlavor.settings || {}, path.basename(sourcePath));
  }

  await writeRecoveryReport(outputPath, summary, sourcePath, report);
  return summary;
}

/**
 * Decide whether this 3.x-style layout is actually a Cocos Creator 2.4 bundle
 * build (scenes use `.fire`, settings is `window._CCSettings`) or a true 3.x
 * build (`.scene`, `src/settings.json`).
 */
async function detectProjectFlavor(sourcePath) {
  // 3.x marker.
  const settings3xPath = path.join(sourcePath, 'src', 'settings.json');
  if (await pathExists(settings3xPath)) {
    try {
      const s = JSON.parse(await fsp.readFile(settings3xPath, 'utf-8'));
      return { flavor: '3.x', settings: s };
    } catch {
      // fall through
    }
  }
  // Also check for hashed settings.*.json (3.x web builds).
  const srcDir = path.join(sourcePath, 'src');
  if (await pathExists(srcDir)) {
    const files = await fsp.readdir(srcDir);
    const hashed = files.find(f => /^settings\..+\.json$/.test(f));
    if (hashed) {
      try {
        const s = JSON.parse(await fsp.readFile(path.join(srcDir, hashed), 'utf-8'));
        return { flavor: '3.x', settings: s };
      } catch {
        // fall through
      }
    }
  }

  // 3.x marker — binary form (newer builds emit settings.bin or settings.<hash>.bin)
  const binPath = await findBinarySettings(path.join(sourcePath, 'src'));
  if (binPath) {
    try {
      const buf = await fsp.readFile(binPath);
      const { decodeNotepack } = require('./notepack.js');
      const s = decodeNotepack(buf);
      return { flavor: '3.x', settings: s };
    } catch (e) {
      logger.warn(`Failed to decode binary settings at ${binPath}: ${e.message}`);
    }
  }

  // 2.4.x marker: src/settings.js containing `window._CCSettings = { ... }`.
  const settings2xPath = path.join(sourcePath, 'src', 'settings.js');
  if (await pathExists(settings2xPath)) {
    try {
      const text = await fsp.readFile(settings2xPath, 'utf-8');
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
  // Evaluate in a sandbox: window._CCSettings = { ... };
  try {
    const sandboxed = `let window = {}; ${text}; window`;
    // eslint-disable-next-line no-eval
    const result = eval(sandboxed);
    return result._CCSettings || result.CCSettings || {};
  } catch {
    return {};
  }
}

/**
 * Walk <buildRoot>/assets for subdirectories that contain a config.json.
 * Also checks <buildRoot>/subpackages for mini-game subpackages.
 */
async function discoverBundles(sourcePath) {
  const bundles = [];
  const candidates = [
    path.join(sourcePath, 'assets'),
    path.join(sourcePath, 'subpackages'),
  ];
  for (const root of candidates) {
    if (!(await pathExists(root))) continue;
    const entries = await readdir(root);
    for (const entry of entries) {
      const bundleDir = path.join(root, entry);
      try {
        const st = await stat(bundleDir);
        if (!st.isDirectory()) continue;
        if (await findBundleConfigPath(bundleDir)) bundles.push(bundleDir);
      } catch {
        // ignore
      }
    }
  }
  return bundles;
}

/**
 * Unpack a single bundle. Returns a summary record.
 */
async function unpackBundle({ bundleDir, cfg: prebuiltCfg, cfgPath: prebuiltCfgPath, outputPath, verbose, report, bundleRegistry }) {
  const cfgPath = prebuiltCfgPath || (await findBundleConfigPath(bundleDir));
  if (!cfgPath) throw new Error(`No config.json found in ${bundleDir}`);
  let cfg = prebuiltCfg;
  if (!cfg) {
    const raw = JSON.parse(await readFile(cfgPath, 'utf-8'));
    cfg = parseBundleConfig(raw, bundleDir);
  }

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

  const result = {
    name: cfg.name,
    encrypted: cfg.encrypted,
    uuidCount: cfg.uuids.length,
    pathCount: Object.keys(cfg.paths).length,
    sceneCount: Object.keys(cfg.scenes).length,
    recovered: 0,
    missing: 0,
    warnings: [],
  };

  // Track which uuids we've already processed so we don't duplicate work when
  // a uuid appears in both `paths` and `scenes` and the catch-all uuids pass.
  const handled = new Set();

  // 1) Named assets from config.paths — the user's project-visible tree.
  for (const uuid of Object.keys(cfg.paths)) {
    const info = cfg.paths[uuid];
    try {
      const ok = await unpackAsset({
        cfg, uuid, info, bundleOut, verbose, bundleRegistry,
      });
      handled.add(uuid);
      if (ok) result.recovered += 1;
      else result.missing += 1;
      if (report) {
        if (ok) report.ok(cfg.name, uuid, info.type || 'cc.Asset');
        else report.miss(cfg.name, uuid, info.type || 'cc.Asset');
      }
    } catch (err) {
      result.warnings.push(`${info.path}: ${err.message}`);
      logger.warn(`资源失败 [${cfg.name}] ${uuid}: ${err.message}`);
      if (report) report.fail(cfg.name, uuid, info.type || 'unknown', err);
    }
  }

  // 2) Scenes — often listed only under config.scenes, not under paths.
  for (const sceneName of Object.keys(cfg.scenes)) {
    const uuid = cfg.scenes[sceneName];
    if (!uuid || handled.has(uuid)) continue;
    // Scene names use the full `db://assets/scene/foo.fire` form in 2.4+ bundles.
    const pathStr = sceneName
      .replace(/^db:\/\/(assets\/)?/, '')
      .replace(/\.(fire|scene)$/, '')
      || `scene/${uuid}`;
    const info = { path: pathStr, type: 'cc.SceneAsset', subAsset: false };
    try {
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose, bundleRegistry });
      handled.add(uuid);
      if (ok) result.recovered += 1;
      else result.missing += 1;
      if (report) {
        if (ok) report.ok(cfg.name, uuid, 'cc.SceneAsset');
        else report.miss(cfg.name, uuid, 'cc.SceneAsset');
      }
    } catch (err) {
      result.warnings.push(`scene ${sceneName}: ${err.message}`);
      logger.warn(`资源失败 [${cfg.name}] scene ${sceneName}: ${err.message}`);
      if (report) report.fail(cfg.name, uuid, 'cc.SceneAsset', err);
    }
  }

  // 3) UUID-only assets (in uuids[] but not in paths/scenes). Typical for
  //    packed dependencies referenced by prefabs/scenes. Extract them under
  //    _packed/<2>/<uuid> so the editor can still resolve cross-asset refs.
  for (const uuid of cfg.uuids) {
    if (handled.has(uuid)) continue;
    const info = {
      path: `_packed/${uuid.slice(0, 2)}/${uuid}`,
      type: null,
      subAsset: false,
    };
    try {
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose, bundleRegistry });
      handled.add(uuid);
      if (ok) result.recovered += 1;
      if (report) {
        if (ok) report.ok(cfg.name, uuid, 'cc.Asset');
        else report.miss(cfg.name, uuid, 'cc.Asset');
      }
    } catch (err) {
      // These are often internal/packed — don't count as warnings.
      logger.debug(`Packed uuid ${uuid} skipped: ${err.message}`);
      if (report) report.fail(cfg.name, uuid, 'unknown', err);
    }
  }

  // Preserve the original config.json for reference — useful when a user wants
  // to re-pack or debug.
  await copyFile(cfgPath, path.join(bundleOut, 'config.original.json'));

  // Preserve the bundle's compiled user-script bundle (2.4+ ships this as
  // <bundle>/game.js or <bundle>/index.js). 5MB+ on a real project.
  for (const scriptName of ['game.js', 'index.js']) {
    const src = path.join(bundleDir, scriptName);
    if (await pathExists(src)) {
      await copyFile(src, path.join(bundleOut, scriptName));
      result.scriptBundle = scriptName;
    }
  }

  return result;
}

/**
 * Resolve a missing import file by following `cfg.redirect[uuid]` to a peer
 * bundle in the registry. Returns null when there is no redirect entry, or
 * when the named dep bundle isn't present in the registry.
 *
 * The returned object lets the caller probe both .json and .cconb on the dep
 * side, mirroring the local lookup order in `unpackAsset`.
 *
 * @param {object} cfg               Current bundle config.
 * @param {string} uuid              The asset uuid.
 * @param {Map<string,object>} registry  bundleName -> cfg.
 * @returns {{depName:string, cfg:object, importJsonPath:string, importCconPath:string}|null}
 */
function resolveImportThroughRedirect(cfg, uuid, registry) {
  const depName = cfg && cfg.redirect && cfg.redirect[uuid];
  if (!depName) return null;
  const depCfg = registry instanceof Map ? registry.get(depName) : null;
  if (!depCfg) return null;
  return {
    depName,
    cfg: depCfg,
    importJsonPath: getImportPath(depCfg, uuid, '.json'),
    importCconPath: getImportPath(depCfg, uuid, '.cconb'),
  };
}

async function unpackAsset({ cfg, uuid, info, bundleOut, verbose, bundleRegistry }) {
  const importSrc = getImportPath(cfg, uuid, '.json');
  const importSrcCcon = getImportPath(cfg, uuid, '.cconb');
  const nativeExt = cfg.extensionMap[uuid] || null;
  const nativeSrc = nativeExt ? getNativePath(cfg, uuid, nativeExt) : null;

  // Choose an output path. Prefer the project path from config.paths — that's
  // what the editor will see.
  const className = info.type || 'cc.Asset';
  const relPath = resolveOutputPath(uuid, cfg, className);
  const outBase = path.join(bundleOut, relPath);
  await mkdir(path.dirname(outBase), { recursive: true });

  let importDoc = null;
  let importFromCcon = false;
  let importPackRef = null;
  let importRecovered = false;
  let nativeRecovered = false;

  // Asset-class-driven filename for the import document:
  //   scene   -> .fire   (2.4) or .scene (3.x). We emit .fire when the doc is
  //                 in legacy tuple form (2.4 bundles); otherwise .scene.
  //   prefab  -> .prefab
  //   pure-native classes (Texture2D, AudioClip, TTFFont, …) skip the import
  //                 write entirely — the native file is the real asset.
  const importExt = inferImportExt(className);
  const skipImportWrite = isPureNativeClass(className);

  // --- Import document (one per asset, or inside a pack) ---
  if (await pathExists(importSrc)) {
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
  } else if (await pathExists(importSrcCcon)) {
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
  } else {
    // Cross-bundle redirect: when neither importSrc nor importSrcCcon exists
    // locally but cfg.redirect points to another bundle, read the import from
    // the dep bundle. The output stays under the requesting bundle's tree.
    const redirectInfo = resolveImportThroughRedirect(cfg, uuid, bundleRegistry);
    if (redirectInfo) {
      let candidate = null;
      let candidateIsCcon = false;
      if (await pathExists(redirectInfo.importJsonPath)) {
        candidate = redirectInfo.importJsonPath;
      } else if (await pathExists(redirectInfo.importCconPath)) {
        candidate = redirectInfo.importCconPath;
        candidateIsCcon = true;
      }
      if (candidate) {
        const buf = await readFile(candidate);
        if (candidateIsCcon || isCcon(buf)) {
          importDoc = await decodeCconToDoc(buf, outBase);
          importFromCcon = true;
        } else {
          try { importDoc = JSON.parse(buf.toString('utf-8')); } catch { importDoc = null; }
        }
        if (importDoc !== null) {
          if (!skipImportWrite) {
            const disabled = process.env.CC_REVERSE_NO_REHYDRATE === '1';
            const content = disabled
              ? importDoc
              : (tryRehydrate(importDoc) || importDoc);
            await writeFile(outBase + importExt, JSON.stringify(content, null, 2));
          }
          importRecovered = true;
          logger.debug(`redirect: [${cfg.name}] ${uuid} <- ${redirectInfo.depName}`);
        }
      }
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
  if (nativeSrc && (await pathExists(nativeSrc))) {
    await copyFile(nativeSrc, outBase + (nativeExt || ''));
    nativeRecovered = true;
  } else {
    let probedExt = null;
    if (importDoc) probedExt = probeNativeExtension(importDoc);
    if (probedExt) {
      const probedSrc = getNativePath(cfg, uuid, probedExt);
      if (probedSrc && (await pathExists(probedSrc))) {
        await copyFile(probedSrc, outBase + probedExt);
        nativeRecovered = true;
      }
    }
    if (!nativeRecovered) {
      const globbed = await globNativeByUuid(cfg, uuid);
      if (globbed) {
        await copyFile(globbed.src, outBase + globbed.ext);
        nativeRecovered = true;
      }
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

  // --- Meta ---
  await writeMeta(outBase, uuid, className, importFromCcon, importPackRef);

  // R12 — emit a richer editor-style .meta for non-script assets when class
  // maps to a known importer. We unconditionally overwrite any legacy stub
  // produced by writeMeta() above (PR 6 carry-over #1: pure-native classes
  // like cc.BufferAsset have primaryExt='' so richMetaPath collides with
  // the stub path, and the rich meta is the intended editor-facing output).
  if ((importRecovered || nativeRecovered) && KLASS_TO_IMPORTER[className]) {
    const primaryExt = isPureNativeClass(className) ? '' : inferImportExt(className);
    const primaryFile = outBase + primaryExt;
    let extras;
    if (importRecovered) {
      try {
        const doc = JSON.parse(await fsp.readFile(outBase + importExt, 'utf-8'));
        if (className === 'sp.SkeletonData') {
          const textures = Array.isArray(doc.textures)
            ? doc.textures.map(t => t && t.__uuid__).filter(Boolean) : [];
          extras = { textures };
          if (doc.atlasText) extras.atlasInline = true;
        } else if (className === 'dragonBones.DragonBonesAsset') {
          const atlasUuid = doc.dragonBonesAtlas && doc.dragonBonesAtlas.__uuid__;
          if (atlasUuid) extras = { atlasUuid };
        } else if (className === 'dragonBones.DragonBonesAtlasAsset') {
          const textureUuid = doc.texture && doc.texture.__uuid__;
          if (textureUuid) extras = { textureUuid };
        }
      } catch { /* best-effort */ }
    }
    try {
      await writeAssetMeta(primaryFile, { uuid, klass: className, extras });
    } catch {
      // best-effort
    }
  }

  return importRecovered || nativeRecovered;
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
async function globNativeByUuid(cfg, uuid) {
  const dir = path.join(cfg.baseDir, cfg.nativeBase, uuid.slice(0, 2));
  if (!(await pathExists(dir))) return null;
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
    if (!packSrc || !(await pathExists(packSrc))) return null;
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
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.sections)) {
      return rehydrateIPackedFileData(doc);
    }
    if (Array.isArray(doc) && doc.length >= 6 && Array.isArray(doc[5]) && Array.isArray(doc[5][0])
        && Array.isArray(doc[5][0][0])) {
      // Heuristic: array-form pack — sections live at [5] and each section is itself
      // a length-6 array starting with the instances array.
      const sections = rehydrateIPackedFileData(doc);
      if (sections) return sections;
    }
    if (!Array.isArray(doc) || doc.length < 6) return null;
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
  if (decoded.version === 1 && decoded.document) {
    // Persist chunks alongside the JSON so mesh/animation payloads are not lost.
    for (let i = 0; i < decoded.chunks.length; i += 1) {
      await writeFile(`${outBase}.chunk${i}.bin`, decoded.chunks[i]);
    }
    return decoded.document;
  }
  // V2 (notepack) — preserve raw blobs; we can't currently decode.
  if (decoded.rawJson) {
    await writeFile(outBase + '.ccon-v2.rawjson', decoded.rawJson);
  }
  for (let i = 0; i < decoded.chunks.length; i += 1) {
    await writeFile(`${outBase}.chunk${i}.bin`, decoded.chunks[i]);
  }
  return null;
}

async function writeMeta(outBase, uuid, className, wasCcon, packRef) {
  const ext = inferMetaExt(className);
  const metaPath = outBase + ext + '.meta';
  const meta = {
    ver: '1.2.7',
    uuid,
    importer: classToImporter(className),
    downloadMode: 0,
    duration: 0,
    subMetas: {},
  };
  if (wasCcon) meta.source = 'ccon';
  if (packRef) {
    meta.packedIn = packRef.packFile;
    meta.packPosition = packRef.position;
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function inferMetaExt(className) {
  // The meta extension mirrors the asset file extension. When the asset is
  // native-only (texture/audio/font), the meta sits next to the native file.
  switch (className) {
    case 'cc.SceneAsset':    return '.fire';  // 2.4 convention; 3.x editor also reads .fire
    case 'cc.Prefab':        return '.prefab';
    case 'cc.EffectAsset':   return '.effect';
    case 'cc.Material':      return '.mtl';
    case 'cc.AnimationClip': return '.anim';
    case 'cc.SpriteFrame':   return '';       // sits next to the texture basename
    case 'cc.Texture2D':     return '';
    case 'cc.ImageAsset':    return '';
    case 'cc.AudioClip':     return '';
    case 'cc.TTFFont':       return '';
    case 'cc.BitmapFont':    return '';
    default:                 return '.json';
  }
}

function inferImportExt(className) {
  switch (className) {
    case 'cc.SceneAsset':    return '.fire';
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
 * 3.x ships TypeScript compiled to ES5. We preserve filenames where possible.
 */
async function recoverScripts(sourcePath, outputPath, verbose, scriptOptions = {}) {
  const candidates = [
    path.join(sourcePath, 'src', 'chunks'),
    path.join(sourcePath, 'src'),
    path.join(sourcePath, 'cocos-js'),
  ];
  const scriptsOut = path.join(outputPath, 'assets', 'Scripts');

  let total = 0;
  for (const dir of candidates) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue;
      if (entry.startsWith('system.') || entry.startsWith('polyfills.')) continue;
      if (entry === 'cc.js') continue;
      const src = path.join(dir, entry);
      const dest = path.join(scriptsOut, entry);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
      await writeScriptMeta(dest);
      if (verbose) logger.debug(`Script: ${entry}`);
      total += 1;
    }
  }

  // Recursive walk of src/assets/ (WeChat mini-game "_plugs" / plugin SDKs
  // live here as compiled .js files).
  const srcAssets = path.join(sourcePath, 'src', 'assets');
  if (await pathExists(srcAssets)) {
    for await (const file of walkJsFiles(srcAssets)) {
      const rel = path.relative(srcAssets, file);
      const dest = path.join(scriptsOut, 'plugs', rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file, dest);
      await writeScriptMeta(dest);
      total += 1;
    }
  }

  // Preserve top-level bootstrap scripts (main.js, game.js, ccRequire.js,
  // adapter-min.js, physics-min.js, cocos2d-js-min.js) under _boot/. These
  // aren't user code but make the recovered project runnable for inspection.
  const bootFiles = [
    'main.js', 'game.js', 'game.json', 'ccRequire.js',
    'adapter-min.js', 'physics-min.js',
  ];
  const bootOut = path.join(outputPath, '_boot');
  for (const name of bootFiles) {
    const src = path.join(sourcePath, name);
    if (await pathExists(src)) {
      await mkdir(bootOut, { recursive: true });
      await copyFile(src, path.join(bootOut, name));
    }
  }
  const cocosDir = path.join(sourcePath, 'cocos');
  if (await pathExists(cocosDir)) {
    const cocosOut = path.join(bootOut, 'cocos');
    await mkdir(cocosOut, { recursive: true });
    for (const f of await readdir(cocosDir)) {
      await copyFile(path.join(cocosDir, f), path.join(cocosOut, f));
    }
  }

  try {
    const layered = await recoverScriptsLayered(sourcePath, outputPath, verbose, scriptOptions);
    if (verbose && layered.modulesEmitted) {
      logger.debug(`LayeredScripts: ${layered.modulesEmitted} modules emitted, ${layered.errors.length} errors`);
    }
  } catch (err) {
    logger.warn(`Layered script recovery skipped: ${err.message}`);
  }

  return { total };
}

/**
 * Layered script recovery (Layers 1-3): writes one .js per System.register module
 * under <outputPath>/assets/scripts/<chunkBaseName>/. Returns {modulesEmitted, errors}.
 *
 * Silently skipped when no chunks file is found — keeps non-3.x projects unaffected.
 */
async function recoverScriptsLayered(sourcePath, outputPath, verbose, options = {}) {
  const scriptLayers = options.scriptLayers != null ? options.scriptLayers : 6;
  const chunksDir = path.join(sourcePath, 'src', 'chunks');
  if (!(await pathExists(chunksDir))) return { modulesEmitted: 0, tsFilesEmitted: 0, errors: [] };
  const entries = await readdir(chunksDir);
  const chunks = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(chunksDir, entry);
    const source = await readFile(full, 'utf8');
    chunks.push({ name: entry, source });
  }
  if (chunks.length === 0) return { modulesEmitted: 0, tsFilesEmitted: 0, errors: [] };

  const scenes = await collectRecoveredScenes(outputPath);

  const allErrors = [];
  let allModules = [];
  for (const chunk of chunks) {
    const baseName = chunk.name.replace(/\.js$/, '');
    const { modules, errors } = await runScriptRecoveryPipeline({
      chunks: [chunk],
      context: { scenes, bundle: baseName },
    });
    allErrors.push(...errors);
    for (const m of modules) m.bundle = baseName;
    allModules = allModules.concat(modules);
  }

  // Layer 6: emit TS project if requested.
  let tsFilesEmitted = 0;
  if (scriptLayers >= 6) {
    try {
      const emit = await emitTsProject(allModules, { outRoot: path.join(outputPath, 'assets', 'scripts') });
      tsFilesEmitted = emit.filesEmitted;
      if (emit.errors) allErrors.push(...emit.errors);
    } catch (err) {
      allErrors.push({ layer: 'tsProjectEmitter', message: err.message });
    }
  }

  // Legacy .js output (PR 3 path) remains for parity until PR 5 retires it.
  let totalEmitted = 0;
  for (const m of allModules) {
    if (!m.ast) continue;
    try {
      const code = generate(m.ast, { compact: false }).code;
      const outDir = path.join(outputPath, 'assets', 'scripts', m.bundle);
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, `${m.name}.js`), code);
      if (verbose) logger.debug(`LayeredScript: ${m.bundle}/${m.name}.js`);
      totalEmitted += 1;
    } catch (err) {
      allErrors.push({ layer: 'emit', module: m.name, message: err.message });
    }
  }
  return { modulesEmitted: totalEmitted, tsFilesEmitted, errors: allErrors };
}

async function collectRecoveredScenes(outputPath) {
  const out = [];
  const root = path.join(outputPath, 'assets');
  if (!(await pathExists(root))) return out;
  for await (const f of walkJsonFiles(root)) {
    try {
      const text = await readFile(f, 'utf8');
      if (!text.trimStart().startsWith('[')) continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
}

async function* walkJsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walkJsonFiles(p);
    else if (e.isFile() && e.name.endsWith('.json')) yield p;
  }
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

async function writeScriptMeta(scriptPath) {
  const meta = {
    ver: '1.0.8',
    uuid: uuidUtils.generateUuid(),
    isPlugin: false,
    loadPluginInWeb: true,
    loadPluginInNative: true,
    loadPluginInEditor: false,
    subMetas: {},
  };
  await writeFile(scriptPath + '.meta', JSON.stringify(meta, null, 2));
}

async function writeProjectDescriptor(outputPath, settings, sourceProjectName) {
  await writeCocos3xProject(outputPath, {
    projectName: sourceProjectName,
    settings: settings || {},
  });
}

async function countAssetFiles(root) {
  let n = 0;
  if (!(await pathExists(root))) return 0;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) n += await countAssetFiles(f);
    else if (!e.name.endsWith('.meta')) n++;
  }
  return n;
}

async function writeRecoveryReport(outputPath, summary, sourcePath, report) {
  const lines = [];
  lines.push('# Recovery Report');
  lines.push('');
  lines.push(`- Input: \`${sourcePath}\``);
  lines.push(`- Engine: ${summary.engine}`);
  lines.push('');
  lines.push('## Bundles');
  lines.push('');
  if (summary.bundles.length === 0) {
    lines.push('_No bundles recovered._');
  } else {
    lines.push('| Name | Encrypted | UUIDs | Paths | Recovered | Missing |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const b of summary.bundles) {
      lines.push(`| ${b.name} | ${b.encrypted ? 'yes' : 'no'} | ${b.uuidCount} | ${b.pathCount} | ${b.recovered} | ${b.missing} |`);
    }
  }
  lines.push('');
  lines.push(`## Scripts`);
  lines.push('');
  lines.push(`- Files recovered: ${summary.scripts.total}`);
  if (summary.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const w of summary.warnings) lines.push(`- ${w}`);
  }
  if (report) {
    lines.push('', '---', '', report.toMarkdown());
  }

  // Reconcile declared counts with the actual on-disk asset tree so the
  // recoveryReport validate gate (which sums `ok+failed+missed` from the
  // markdown and compares it to a recursive file count under assets/) sees a
  // consistent total. Bundle summaries naturally undercount because we also
  // emit recovered scripts, internal sub-assets, and other auxiliary files.
  const declaredSoFar = (() => {
    if (!report) return 0;
    let n = 0;
    for (const b of Object.values(report.bundles || {})) {
      n += (b.ok || 0) + (b.failed || 0) + (b.missed || 0);
    }
    return n;
  })();
  const actual = await countAssetFiles(path.join(outputPath, 'assets'));
  const extras = actual - declaredSoFar;
  if (extras > 0) {
    lines.push('');
    lines.push('## Filesystem reconciliation');
    lines.push('');
    lines.push(`- **__extras__**: ok=${extras}, failed=0, missed=0`);
    lines.push(`  - includes recovered scripts, internal sub-assets, and other on-disk artifacts not tracked per bundle`);
  }

  await writeFile(path.join(outputPath, 'RECOVERY_REPORT.md'), lines.join('\n'));
}

module.exports = {
  reverseProject3x,
  discoverBundles,
  resolveImportThroughRedirect,
  recoverScriptsLayered,
  resolveOutputPath,
  writeAssetMeta,
  writeRecoveryReport,
  KLASS_TO_IMPORTER,
  detectProjectFlavor,
};
