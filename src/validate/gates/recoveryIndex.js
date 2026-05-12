'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gate: recoveryIndex
 * Reads <outDir>/assets/scripts/RECOVERY_INDEX.json and verifies every
 * entry's `path` resolves to a file under assets/scripts/. Informational
 * pass when the index is absent (e.g. scriptLayers < 6).
 */
module.exports = function recoveryIndex(outDir) {
  const root = path.join(outDir, 'assets', 'scripts');
  const indexPath = path.join(root, 'RECOVERY_INDEX.json');
  if (!fs.existsSync(indexPath)) return true; // informational pass
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    return `RECOVERY_INDEX.json unreadable: ${err.message}`;
  }
  const missing = [];
  for (const [uuid, entry] of Object.entries(idx || {})) {
    if (!entry || typeof entry.path !== 'string') {
      missing.push(uuid);
      continue;
    }
    if (!fs.existsSync(path.join(root, entry.path))) {
      missing.push(`${uuid} -> ${entry.path}`);
    }
  }
  if (missing.length) {
    const list = missing.slice(0, 10).join(', ');
    const more = missing.length > 10 ? ` (+${missing.length - 10} more)` : '';
    return `${missing.length} missing entries: ${list}${more}`;
  }
  return true;
};
