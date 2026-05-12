const fs = require('fs');
const path = require('path');

const CTORS = [
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'Uint8ClampedArray',
];
const RE = new RegExp(`"__type__":"(?:${CTORS.join('|')})"`, 'g');
const SCAN_EXTS = new Set(['.json', '.scene', '.prefab']);

/**
 * Gate: typedArrays
 * Informational gate. Walks the output directory and counts TypedArray
 * source-format markers (e.g. {"__type__":"Float32Array",...}).
 * Always returns true; the count surfaces in PR 5 once runGates supports
 * structured detail.
 */
module.exports = function typedArrays(outDir) {
  let count = 0;
  walk(outDir, p => {
    const ext = path.extname(p);
    if (!SCAN_EXTS.has(ext)) return;
    let body;
    try { body = fs.readFileSync(p, 'utf-8'); } catch { return; }
    const m = body.match(RE);
    if (m) count += m.length;
  });
  // Informational; always pass.
  return true;
};

function walk(dir, visit) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, visit);
    else visit(f);
  }
}
