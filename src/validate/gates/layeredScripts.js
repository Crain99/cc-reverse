'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gate: layeredScripts
 * Informational gate. Walks <outDir>/assets/scripts/ recursively and counts
 * .js files plus how many include a top-level `import` statement (an indicator
 * that Layer 2 ESM rebuilding succeeded). Always returns true; the count is
 * intended to surface in PR 5 once runGates supports structured detail.
 */
module.exports = function layeredScripts(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  const files = walk(root);
  if (files.length === 0) {
    // Informational: not all projects have layered scripts (e.g. 2.x).
    return true;
  }
  let withImport = 0;
  for (const f of files) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (/^\s*import\s/m.test(src)) withImport += 1;
    } catch { /* ignore */ }
  }
  // Informational; always pass.
  return true;
};

function walk(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
};
