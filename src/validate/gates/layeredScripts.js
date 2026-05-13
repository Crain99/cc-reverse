'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gate: layeredScripts
 *
 * Verifies that script recovery actually produced something proportional to
 * what the rest of the pipeline reported. Prior to PR 9 this gate was
 * informational-only (always returned true) which masked a class of failures
 * where recovery wrote effectively nothing under `assets/Scripts/` (e.g. the
 * cgxfd sample, where the 3.x chunk splitter found no `System.register`
 * chunks because the project actually ships a 2.x browserify bundle).
 *
 * Strict rules (any one failing => gate fails):
 *
 *   1. If `RECOVERY_REPORT.md` declares >= 2 bundles, the count of recovered
 *      `.js`/`.ts` files under `assets/Scripts/` (case-insensitive) must be
 *      >= bundle_count. Rationale: even a single `System.register` per
 *      bundle should yield at least one recovered script per bundle.
 *
 *   2. If `RECOVERY_INDEX.json` exists and declares N entries, the on-disk
 *      `.js`/`.ts` count must be at least 30% of N.
 *
 * Pure-2.x projects (no Scripts dir, no bundles section, no index) remain
 * informational pass.
 */
module.exports = function layeredScripts(outDir) {
  const scriptsDir = findScriptsDir(outDir);
  const jsFiles = walk(scriptsDir, /\.(?:js|ts)$/);

  const bundleCount = readBundleCountFromReport(outDir);
  if (bundleCount >= 2 && jsFiles.length < bundleCount) {
    return {
      ok: false,
      detail: `near-empty script recovery: ${jsFiles.length} recovered file(s) under assets/Scripts/ but RECOVERY_REPORT.md declares ${bundleCount} bundles (expected >= ${bundleCount})`,
    };
  }

  const indexInfo = readRecoveryIndexCount(scriptsDir);
  if (indexInfo && indexInfo.declared > 0) {
    const minRequired = Math.ceil(indexInfo.declared * 0.3);
    if (jsFiles.length < minRequired) {
      return {
        ok: false,
        detail: `RECOVERY_INDEX.json declares ${indexInfo.declared} entries but only ${jsFiles.length} recovered file(s) on disk (< 30% threshold = ${minRequired})`,
      };
    }
  }

  if (jsFiles.length === 0) return true;

  let withImport = 0;
  for (const f of jsFiles) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (/^\s*import\s/m.test(src)) withImport += 1;
    } catch { /* ignore */ }
  }
  return {
    ok: true,
    detail: `${jsFiles.length} recovered file(s); ${withImport} with import statements; bundles=${bundleCount}`,
  };
};

function findScriptsDir(outDir) {
  if (!outDir) return null;
  const assets = path.join(outDir, 'assets');
  if (!fs.existsSync(assets)) return null;
  let found = null;
  try {
    for (const e of fs.readdirSync(assets, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.toLowerCase() === 'scripts') {
        found = path.join(assets, e.name);
        break;
      }
    }
  } catch { /* ignore */ }
  return found;
}

function walk(dir, extRe) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, extRe));
    else if (e.isFile() && extRe.test(e.name) && !e.name.endsWith('.meta')) out.push(p);
  }
  return out;
}

function readBundleCountFromReport(outDir) {
  const reportPath = path.join(outDir, 'RECOVERY_REPORT.md');
  if (!fs.existsSync(reportPath)) return 0;
  let txt;
  try { txt = fs.readFileSync(reportPath, 'utf8'); } catch { return 0; }
  const lines = txt.split(/\r?\n/);
  let inBundles = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+Bundles\b/i.test(line)) { inBundles = true; continue; }
    if (inBundles && /^##\s/.test(line)) break;
    if (!inBundles) continue;
    if (!line.startsWith('|')) continue;
    if (/^\|\s*Name\s*\|/i.test(line)) continue;
    if (/^\|\s*-+/.test(line)) continue;
    count += 1;
  }
  return count;
}

function readRecoveryIndexCount(scriptsDir) {
  if (!scriptsDir) return null;
  const p = path.join(scriptsDir, 'RECOVERY_INDEX.json');
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object') return { declared: 0 };
    return { declared: Object.keys(obj).length };
  } catch {
    return { declared: 0 };
  }
}
