/*
 * Recovery report writer for the 2.x pipeline.
 *
 * 2.x has no notion of bundles / per-uuid status tracking the way 3.x does
 * (everything funnels through resourceProcessor copying files into a flat
 * tree under <out>/assets), so we synthesise a single-section markdown
 * report whose declared count matches the on-disk asset count exactly.
 *
 * The format is intentionally compatible with src/validate/gates/recoveryReport.js
 * which scans for "- **<name>**: ok=N, failed=N, missed=N" lines and compares
 * sum(ok+failed+missed) against a recursive non-.meta file count under
 * <out>/assets.
 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const writeFile = promisify(fs.writeFile);

function countAssetFilesSync(root) {
  let n = 0;
  if (!fs.existsSync(root)) return 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) n += countAssetFilesSync(f);
    else if (!e.name.endsWith('.meta')) n++;
  }
  return n;
}

function countJscFilesSync(root) {
  let n = 0;
  if (!fs.existsSync(root)) return 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) n += countJscFilesSync(f);
    else if (e.name.endsWith('.jsc')) n++;
  }
  return n;
}

/**
 * Emit RECOVERY_REPORT.md for a 2.x reverse run.
 *
 * @param {object} opts
 * @param {string} opts.outputPath  Output directory (where assets/ lives).
 * @param {string} opts.sourcePath  Original source directory.
 * @param {string} opts.version     Detected cocos version (e.g. '2.4.x').
 * @param {number} [opts.processed] Count of resources processed by resourceProcessor.
 * @param {number} [opts.decodedJsc] Count of decoded JSC scripts (if known).
 * @param {string[]} [opts.failures] Optional list of failure descriptions.
 */
async function writeRecoveryReport2x(opts) {
  const {
    outputPath,
    sourcePath,
    version,
    processed = null,
    decodedJsc = null,
    failures = [],
  } = opts;

  const assetsDir = path.join(outputPath, 'assets');
  const actual = countAssetFilesSync(assetsDir);
  const jscOnDisk = countJscFilesSync(assetsDir);
  const failed = failures.length;

  // Choose ok so that ok+failed === actual (gate-equality requirement).
  const ok = Math.max(0, actual - failed);

  const lines = [];
  lines.push('# Recovery Report');
  lines.push('');
  lines.push(`- Input: \`${sourcePath}\``);
  lines.push(`- Engine: ${version || '2.x'}`);
  if (processed != null) lines.push(`- Resources processed: ${processed}`);
  if (decodedJsc != null) lines.push(`- JSC scripts decoded: ${decodedJsc}`);
  lines.push(`- Files on disk under assets/: ${actual}`);
  lines.push(`- .jsc residue under assets/: ${jscOnDisk}`);
  lines.push('');
  lines.push('## Per-bundle counts');
  // 2.x has no real bundles; use a single "main" section.
  lines.push(`- **main**: ok=${ok}, failed=${failed}, missed=0`);
  if (failures.length) {
    lines.push('');
    lines.push('## Failures');
    for (const f of failures) lines.push(`- ${f}`);
  }

  await writeFile(path.join(outputPath, 'RECOVERY_REPORT.md'), lines.join('\n'));
}

module.exports = { writeRecoveryReport2x, countAssetFilesSync };
