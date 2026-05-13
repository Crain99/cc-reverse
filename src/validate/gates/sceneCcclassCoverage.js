'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gate: sceneCcclassCoverage
 *
 * Scans <outDir>/assets/**\/*.scene for `__type__` string values that look like
 * uuids (the editor uses these to bind component instances back to their
 * ccclass), then checks how many are resolvable through the recovered
 * scripts.
 *
 * A reference is considered "resolved" if either:
 *   - RECOVERY_INDEX.json (under assets/scripts/) maps the uuid to a path, OR
 *   - some <ClassName>.ts.meta under assets/scripts/ carries that uuid.
 *
 * Informational gate — reports counts and a few unresolved sample uuids.
 * Always returns ok:true; downstream gates / RECOVERY_REPORT.md surface the
 * coverage number so a human can spot when bundle splitting silently drops
 * classes (the slgq-out brown-screen failure mode).
 */
module.exports = function sceneCcclassCoverage(outDir) {
  const assetsDir = path.join(outDir, 'assets');
  if (!fs.existsSync(assetsDir)) return true;

  const sceneFiles = walk(assetsDir, /\.scene$/);
  if (sceneFiles.length === 0) return true;

  const refs = new Set();
  for (const f of sceneFiles) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const u of extractTypeUuids(txt)) refs.add(u);
  }
  if (refs.size === 0) {
    return { ok: true, detail: `${sceneFiles.length} scene(s); no __type__ uuid refs found` };
  }

  const known = new Set();
  const scriptsRoot = path.join(assetsDir, 'scripts');
  if (fs.existsSync(scriptsRoot)) {
    const idxPath = path.join(scriptsRoot, 'RECOVERY_INDEX.json');
    if (fs.existsSync(idxPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        for (const u of Object.keys(idx || {})) known.add(u);
      } catch { /* best-effort */ }
    }
    for (const meta of walk(scriptsRoot, /\.ts\.meta$/)) {
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (m && typeof m.uuid === 'string') known.add(m.uuid);
      } catch { /* best-effort */ }
    }
  }

  const total = refs.size;
  const resolved = [...refs].filter((u) => known.has(u)).length;
  const unresolved = [...refs].filter((u) => !known.has(u));
  const sample = unresolved.slice(0, 3).join(', ');
  const pct = total === 0 ? 100 : Math.round((resolved / total) * 100);
  return {
    ok: true,
    detail:
      `${sceneFiles.length} scene(s); ${resolved}/${total} ccclass uuid refs resolved (${pct}%)` +
      (unresolved.length ? `; ${unresolved.length} unresolved e.g. [${sample}]` : ''),
  };
};

function walk(dir, re) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, re));
    else if (e.isFile() && re.test(e.name)) out.push(p);
  }
  return out;
}

// Cocos 3.x scenes embed component class refs as: "__type__":"<uuid-ish>".
// Matches both compressed string-table form (rare in 3.x) and the standard
// inline form. We accept any non-builtin token (skip 'cc.Node', 'cc.Sprite',
// etc.) since the gate's purpose is uuid resolvability, not engine types.
function extractTypeUuids(txt) {
  const out = new Set();
  const re = /"__type__"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const v = m[1];
    if (!v || v.startsWith('cc.')) continue;
    out.add(v);
  }
  return out;
}
