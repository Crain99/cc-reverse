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
const path = require('path');
const { promisify } = require('util');
const { logger } = require('../../utils/logger');
const { uuidUtils } = require('../../utils/uuidUtils');
const { parseBundleConfig, getImportPath, getNativePath } = require('./bundleConfig');
const { isCcon, decodeCcon } = require('./ccon');
const { inspect } = require('./deserializer');
const { rehydrateIFileData } = require('./rehydrate');
const { writeCocos2xProject } = require('./projectScaffold');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

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
  } = options;

  await mkdir(outputPath, { recursive: true });
  await mkdir(path.join(outputPath, 'assets'), { recursive: true });

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
        const result = await unpackBundle({ bundleDir, outputPath, verbose });
        summary.bundles.push(result);
      } catch (err) {
        logger.error(`Failed to unpack bundle ${name}:`, err);
        summary.warnings.push(`bundle ${name}: ${err.message}`);
      }
    }
  }

  if (!assetsOnly) {
    summary.scripts = await recoverScripts(sourcePath, outputPath, verbose);
  }

  const projectFlavor = detectProjectFlavor(sourcePath);
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

  await writeRecoveryReport(outputPath, summary, sourcePath);
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
    if (!fs.existsSync(root)) continue;
    const entries = await readdir(root);
    for (const entry of entries) {
      const bundleDir = path.join(root, entry);
      try {
        const st = await stat(bundleDir);
        if (!st.isDirectory()) continue;
        const cfgPath = path.join(bundleDir, 'config.json');
        if (fs.existsSync(cfgPath)) bundles.push(bundleDir);
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
async function unpackBundle({ bundleDir, outputPath, verbose }) {
  const cfgPath = path.join(bundleDir, 'config.json');
  const raw = JSON.parse(await readFile(cfgPath, 'utf-8'));
  const cfg = parseBundleConfig(raw, bundleDir);

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
        cfg, uuid, info, bundleOut, verbose,
      });
      handled.add(uuid);
      if (ok) result.recovered += 1;
      else result.missing += 1;
    } catch (err) {
      result.warnings.push(`${info.path}: ${err.message}`);
      logger.debug(`Asset ${uuid} (${info.path}) failed: ${err.message}`);
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
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose });
      handled.add(uuid);
      if (ok) result.recovered += 1;
      else result.missing += 1;
    } catch (err) {
      result.warnings.push(`scene ${sceneName}: ${err.message}`);
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
      const ok = await unpackAsset({ cfg, uuid, info, bundleOut, verbose });
      handled.add(uuid);
      if (ok) result.recovered += 1;
    } catch (err) {
      // These are often internal/packed — don't count as warnings.
      logger.debug(`Packed uuid ${uuid} skipped: ${err.message}`);
    }
  }

  // Preserve the original config.json for reference — useful when a user wants
  // to re-pack or debug.
  await copyFile(cfgPath, path.join(bundleOut, 'config.original.json'));

  // Preserve the bundle's compiled user-script bundle (2.4+ ships this as
  // <bundle>/game.js or <bundle>/index.js). 5MB+ on a real project.
  for (const scriptName of ['game.js', 'index.js']) {
    const src = path.join(bundleDir, scriptName);
    if (fs.existsSync(src)) {
      await copyFile(src, path.join(bundleOut, scriptName));
      result.scriptBundle = scriptName;
    }
  }

  return result;
}

async function unpackAsset({ cfg, uuid, info, bundleOut, verbose }) {
  const importSrc = getImportPath(cfg, uuid, '.json');
  const importSrcCcon = getImportPath(cfg, uuid, '.cconb');
  const nativeExt = cfg.extensionMap[uuid] || null;
  const nativeSrc = nativeExt ? getNativePath(cfg, uuid, nativeExt) : null;

  // Choose an output path. Prefer the project path from config.paths — that's
  // what the editor will see.
  const className = info.type || 'cc.Asset';
  const outDir = classOutputDir(className);
  const relPath = info.path || `${outDir}/${uuid}`;
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
  } else {
    let probedExt = null;
    if (importDoc) probedExt = probeNativeExtension(importDoc);
    if (probedExt) {
      const probedSrc = getNativePath(cfg, uuid, probedExt);
      if (probedSrc && fs.existsSync(probedSrc)) {
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
async function recoverScripts(sourcePath, outputPath, verbose) {
  const candidates = [
    path.join(sourcePath, 'src', 'chunks'),
    path.join(sourcePath, 'src'),
    path.join(sourcePath, 'cocos-js'),
  ];
  const scriptsOut = path.join(outputPath, 'assets', 'Scripts');

  let total = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
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
  if (fs.existsSync(srcAssets)) {
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
    if (fs.existsSync(src)) {
      await mkdir(bootOut, { recursive: true });
      await copyFile(src, path.join(bootOut, name));
    }
  }
  const cocosDir = path.join(sourcePath, 'cocos');
  if (fs.existsSync(cocosDir)) {
    const cocosOut = path.join(bootOut, 'cocos');
    await mkdir(cocosOut, { recursive: true });
    for (const f of await readdir(cocosDir)) {
      await copyFile(path.join(cocosDir, f), path.join(cocosOut, f));
    }
  }

  return { total };
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

async function writeRecoveryReport(outputPath, summary, sourcePath) {
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
  await writeFile(path.join(outputPath, 'RECOVERY_REPORT.md'), lines.join('\n'));
}

module.exports = { reverseProject3x, discoverBundles };
