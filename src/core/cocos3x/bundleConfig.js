/*
 * Cocos Creator 3.x bundle config.json parser.
 *
 * Port of `processOptions()` from cocos-engine:
 *   cocos/asset/asset-manager/config.ts (Config.init / processOptions)
 *
 * Given a `config.json` object and its base directory, produces a flat asset
 * table that the rest of the pipeline can iterate: for each uuid, the asset's
 * class name, original project path, and resolved import/native file paths.
 */
const path = require('path');
const { uuidUtils } = require('../../utils/uuidUtils');

/**
 * Inflate a raw config.json per the same logic the runtime uses at load time.
 *
 * @param {object} raw     Parsed config.json.
 * @param {string} baseDir Absolute path to the bundle directory (the one that
 *                         contains config.json + import/ + native/).
 * @returns {BundleConfig}
 */
function parseBundleConfig(raw, baseDir) {
  const debug = raw.debug === true;
  const importBase = raw.importBase || 'import';
  const nativeBase = raw.nativeBase || 'native';
  const name = raw.name || path.basename(baseDir);
  const types = Array.isArray(raw.types) ? raw.types : [];
  const deps = Array.isArray(raw.deps) ? raw.deps : [];
  const uuidsRaw = Array.isArray(raw.uuids) ? raw.uuids : [];

  // Expand compressed uuids unless the config is in debug mode.
  const uuids = uuidsRaw.map(u => (debug ? u : uuidUtils.decodeUuid(u)));

  // Versions: flat [idx, ver, idx, ver, ...] arrays per kind.
  const importVersions = indexedVersionMap(raw.versions && raw.versions.import, uuids);
  const nativeVersions = indexedVersionMap(raw.versions && raw.versions.native, uuids);

  // Paths: { "<uuidIndex>": [relPath, typeIndex, subAssetFlag?] }
  const rawPaths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const paths = {};
  for (const key of Object.keys(rawPaths)) {
    const entry = rawPaths[key];
    const uuidIdx = parseInt(key, 10);
    if (!Array.isArray(entry) || Number.isNaN(uuidIdx)) continue;
    const uuid = uuids[uuidIdx];
    if (!uuid) continue;
    const relPath = entry[0];
    const typeIndex = entry[1];
    const subAssetFlag = entry[2];
    paths[uuid] = {
      path: relPath,
      type: typeIndex != null ? types[typeIndex] : null,
      subAsset: subAssetFlag === 1 || subAssetFlag === true,
    };
  }

  // Scenes: { name: "<uuidIndex>" } -> { name: uuid }
  const rawScenes = raw.scenes && typeof raw.scenes === 'object' ? raw.scenes : {};
  const scenes = {};
  for (const sceneName of Object.keys(rawScenes)) {
    const idx = parseInt(rawScenes[sceneName], 10);
    const uuid = Number.isNaN(idx) ? rawScenes[sceneName] : uuids[idx];
    if (uuid) scenes[sceneName] = uuid;
  }

  // Packs: { packUuid(compressed): [childUuidIdx or childUuid] }
  const rawPacks = raw.packs && typeof raw.packs === 'object' ? raw.packs : {};
  const packs = {};
  for (const packKey of Object.keys(rawPacks)) {
    const packUuid = debug ? packKey : uuidUtils.decodeUuid(packKey);
    const children = rawPacks[packKey];
    if (!Array.isArray(children)) continue;
    packs[packUuid] = children.map(c => {
      const idx = parseInt(c, 10);
      if (!Number.isNaN(idx) && uuids[idx]) return uuids[idx];
      return debug ? c : uuidUtils.decodeUuid(c);
    });
  }

  // Extension map: { ".png": [uuid(compressed), ...] }
  const rawExtMap = raw.extensionMap && typeof raw.extensionMap === 'object'
    ? raw.extensionMap : {};
  const extensionMap = {};
  for (const ext of Object.keys(rawExtMap)) {
    const list = rawExtMap[ext];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const uuid = debug ? c : uuidUtils.decodeUuid(c);
      if (uuid) extensionMap[uuid] = ext;
    }
  }

  // Redirect: flat [idx, bundleIdx, idx, bundleIdx, ...]
  const redirectList = Array.isArray(raw.redirect) ? raw.redirect : [];
  const redirect = {};
  for (let i = 0; i < redirectList.length; i += 2) {
    const idx = parseInt(redirectList[i], 10);
    const bundleIdx = parseInt(redirectList[i + 1], 10);
    if (Number.isNaN(idx) || Number.isNaN(bundleIdx)) continue;
    const uuid = uuids[idx];
    const depName = deps[bundleIdx];
    if (uuid && depName) redirect[uuid] = depName;
  }

  return {
    name,
    baseDir,
    importBase,
    nativeBase,
    deps,
    types,
    uuids,
    paths,
    scenes,
    packs,
    versions: { import: importVersions, native: nativeVersions },
    extensionMap,
    redirect,
    encrypted: raw.encrypted === true,
    debug,
  };
}

function indexedVersionMap(flat, uuids) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i < flat.length; i += 2) {
    const idx = parseInt(flat[i], 10);
    const ver = flat[i + 1];
    if (Number.isNaN(idx) || ver == null) continue;
    const uuid = uuids[idx];
    if (uuid) out[uuid] = String(ver);
  }
  return out;
}

/**
 * Reconstruct the on-disk path for an import (asset JSON) file.
 * Mirrors `getUrlWithUuid` + `combine()` from url-transformer.ts + helper.ts.
 *
 * @param {BundleConfig} cfg
 * @param {string}       uuid
 * @param {string}       [extension='.json']  defaults to .json; pass '.cconb' if
 *                       the ext-map says so.
 * @returns {string|null} absolute file path (the file may or may not exist).
 */
function getImportPath(cfg, uuid, extension) {
  if (!uuid) return null;
  const ext = extension || '.json';
  const ver = cfg.versions.import[uuid];
  const name = ver ? `${uuid}.${ver}${ext}` : `${uuid}${ext}`;
  return path.join(cfg.baseDir, cfg.importBase, uuid.slice(0, 2), name);
}

/**
 * Reconstruct the on-disk path for a native (raw) asset file.
 *
 * @param {BundleConfig} cfg
 * @param {string}       uuid
 * @param {string}       ext   extension including dot (e.g. '.png').
 * @returns {string|null}
 */
function getNativePath(cfg, uuid, ext) {
  if (!uuid) return null;
  if (!ext) return null;
  const ver = cfg.versions.native[uuid];
  const name = ver ? `${uuid}.${ver}${ext}` : `${uuid}${ext}`;
  return path.join(cfg.baseDir, cfg.nativeBase, uuid.slice(0, 2), name);
}

module.exports = { parseBundleConfig, getImportPath, getNativePath };
