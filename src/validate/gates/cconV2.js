const fs = require('fs');
const path = require('path');

/**
 * Gate: cconV2
 * Fails when the unpacker produced any `.ccon-v2.rawjson` sentinel files,
 * i.e. CCON v2 bodies that the notepack decoder could not handle.
 * Returns true on success, an error string on failure.
 */
module.exports = function cconV2(outDir) {
  const found = [];
  walk(outDir, p => { if (p.endsWith('.ccon-v2.rawjson')) found.push(p); });
  if (found.length === 0) return true;
  return `${found.length} undecoded CCON v2 file(s) — first: ${found[0]}`;
};

function walk(dir, visit) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, visit);
    else visit(f);
  }
}
