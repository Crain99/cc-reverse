'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gate: tsProject
 * Informational. Walks <outDir>/assets/scripts/ for .ts files and notes
 * whether tsconfig.json is present. Always passes.
 */
module.exports = function tsProject(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  if (!fs.existsSync(root)) return true;
  const tsFiles = walk(root);
  const hasTsconfig = fs.existsSync(path.join(root, 'tsconfig.json'));
  // Informational; always pass. Counts kept for future structured detail.
  void tsFiles;
  void hasTsconfig;
  return true;
};

function walk(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
