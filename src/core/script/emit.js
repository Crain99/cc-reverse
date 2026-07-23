/*
 * Write recovered scripts + .meta files under assets/Scripts.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uuidUtils } = require('../../utils/uuidUtils');
const { logger } = require('../../utils/logger');
const { forEachPool, getMaxParallel } = require('../../utils/asyncPool');

/**
 * @typedef {import('./types').TransformResult} TransformResult
 * @typedef {import('./types').ModuleRecord} ModuleRecord
 */

/**
 * @param {Array<{ record: ModuleRecord, transformed: TransformResult }>} items
 * @param {object} options
 * @param {string} options.outputPath  project output root
 * @param {boolean} [options.verbose]
 * @returns {Promise<{ written: number, failed: number }>}
 */
async function emitModules(items, options) {
  const outputPath = options.outputPath || (global.paths && global.paths.output);
  if (!outputPath) {
    throw new Error('emitModules: outputPath is required');
  }

  const scriptsRoot = path.join(outputPath, 'assets', 'Scripts');
  await fsp.mkdir(scriptsRoot, { recursive: true });

  let written = 0;
  let failed = 0;
  const concurrency = getMaxParallel();

  await forEachPool(items, concurrency, async (item) => {
    const { transformed } = item;
    try {
      const rel = transformed.outPath || 'module.ts';
      const abs = path.join(scriptsRoot, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, transformed.code, 'utf-8');

      const uuid = resolveMetaUuid(transformed, item.record);
      const meta = {
        ver: '1.0.8',
        uuid,
        isPlugin: false,
        loadPluginInWeb: true,
        loadPluginInNative: true,
        loadPluginInEditor: false,
        subMetas: {},
      };
      await fsp.writeFile(`${abs}.meta`, JSON.stringify(meta, null, 2), 'utf-8');

      written += 1;
      if (options.verbose || global.verbose) {
        logger.debug(`Script: ${rel}`);
      }
    } catch (err) {
      failed += 1;
      logger.error(`Failed to emit script ${transformed.outPath}:`, err.message || err);
    }
  });

  return { written, failed };
}

/**
 * Prefer decoded Cocos uuid; fall back to deterministic decode of filename / random.
 */
function resolveMetaUuid(transformed, record) {
  const raw = transformed.uuid || (record && record.uuid);
  if (raw) {
    // 22-char compressed → standard
    if (typeof raw === 'string' && raw.length === 22) {
      return uuidUtils.decodeUuid(raw) || raw;
    }
    return raw;
  }

  // Stable-ish from outPath basename
  const base = path.basename(transformed.outPath || 'module', '.ts');
  try {
    return uuidUtils.decodeUuid(uuidUtils.original_uuid(base));
  } catch {
    return uuidUtils.generateUuid();
  }
}

module.exports = { emitModules, resolveMetaUuid };
