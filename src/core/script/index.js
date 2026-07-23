/*
 * 2.x script recovery orchestrator.
 *
 * Flow:
 *   detect format → extract modules (slice or AST fallback)
 *   → transform each module → emit assets/Scripts/**
 */

const { detectScriptBundleFormat } = require('./detectFormat');
const { extractBrowserifyModules } = require('./extractors/browserify');
const { extractWithAst } = require('./extractors/fallbackAst');
const { transformModule, idToOutPath } = require('./transform');
const { emitModules } = require('./emit');
const { logger } = require('../../utils/logger');

/**
 * @typedef {import('./types').ModuleRecord} ModuleRecord
 * @typedef {import('./types').ScriptBundleFormat} ScriptBundleFormat
 */

/**
 * Recover user scripts from a 2.x compiled project.js (or similar) bundle.
 *
 * @param {string} code
 * @param {object} [options]
 * @param {string} [options.outputPath]
 * @param {boolean} [options.verbose]
 * @param {ScriptBundleFormat|string} [options.forceFormat]  skip detection
 * @param {boolean} [options.noAstFallback=false]
 * @returns {Promise<{
 *   format: ScriptBundleFormat,
 *   modules: number,
 *   written: number,
 *   failed: number,
 *   extractor: string,
 * }>}
 */
async function recoverScripts2x(code, options = {}) {
  const verbose = options.verbose || global.verbose;
  const outputPath = options.outputPath || (global.paths && global.paths.output);

  const format = options.forceFormat || detectScriptBundleFormat(code);
  if (verbose) {
    logger.info(`脚本包格式: ${format}`);
  }

  let records = [];
  let extractor = 'none';

  if (format === 'browserify') {
    records = extractBrowserifyModules(code);
    extractor = 'browserify';
  } else if (format === 'webpack') {
    // Phase B: no dedicated webpack slicer yet — AST fallback understands factory objects.
    records = options.noAstFallback ? [] : extractWithAst(code);
    extractor = records.length ? 'fallback-ast' : 'none';
  } else if (format === 'cocos-rf') {
    // Source soup with cc._RF — try browserify first (sometimes nested), else AST.
    records = extractBrowserifyModules(code);
    extractor = 'browserify';
    if (records.length === 0 && !options.noAstFallback) {
      records = extractWithAst(code);
      extractor = 'fallback-ast';
    }
  } else {
    // unknown
    records = extractBrowserifyModules(code);
    extractor = records.length ? 'browserify' : 'none';
    if (records.length === 0 && !options.noAstFallback) {
      records = extractWithAst(code);
      extractor = records.length ? 'fallback-ast' : 'none';
    }
  }

  // If preferred extractor returned nothing, optionally fall back
  if (records.length === 0 && extractor !== 'fallback-ast' && !options.noAstFallback) {
    logger.warn(`提取器 ${extractor || format} 未得到模块，回退到 AST`);
    records = extractWithAst(code);
    extractor = 'fallback-ast';
  }

  if (records.length === 0) {
    logger.warn('未从脚本包中恢复任何模块');
    return {
      format,
      modules: 0,
      written: 0,
      failed: 0,
      extractor,
    };
  }

  // Pre-compute outPath so dep rewrites can resolve relatives
  for (const rec of records) {
    rec.outPath = idToOutPath(rec.id);
  }
  const byId = new Map(records.map((r) => [String(r.id), r]));

  const items = records.map((record) => ({
    record,
    transformed: transformModule(record, { byId }),
  }));

  // Keep transformed outPath on record for consistency
  for (const item of items) {
    item.record.outPath = item.transformed.outPath;
    if (item.transformed.uuid) item.record.uuid = item.transformed.uuid;
  }

  const { written, failed } = await emitModules(items, {
    outputPath,
    verbose,
  });

  logger.info(`脚本恢复完成: ${written} 写入, ${failed} 失败 (extractor=${extractor}, format=${format})`);

  return {
    format,
    modules: records.length,
    written,
    failed,
    extractor,
  };
}

/**
 * Extract modules without writing (for tests / tooling).
 * @param {string} code
 * @param {object} [options]
 * @returns {{ format: ScriptBundleFormat, records: ModuleRecord[], extractor: string }}
 */
function extractModulesOnly(code, options = {}) {
  const format = options.forceFormat || detectScriptBundleFormat(code);
  let records = [];
  let extractor = 'none';

  if (format === 'browserify' || format === 'cocos-rf') {
    records = extractBrowserifyModules(code);
    extractor = 'browserify';
  }

  if (records.length === 0 && !options.noAstFallback) {
    records = extractWithAst(code);
    extractor = records.length ? 'fallback-ast' : extractor;
  }

  if (records.length === 0 && format === 'unknown' && !options.noAstFallback) {
    records = extractWithAst(code);
    extractor = records.length ? 'fallback-ast' : extractor;
  }

  for (const rec of records) {
    rec.outPath = idToOutPath(rec.id);
  }

  return { format, records, extractor };
}

module.exports = {
  recoverScripts2x,
  extractModulesOnly,
  detectScriptBundleFormat,
};
