const fs = require('fs');
const path = require('path');
module.exports = function(outDir) {
  const report = path.join(outDir, 'RECOVERY_REPORT.md');
  if (!fs.existsSync(report)) return 'RECOVERY_REPORT.md missing';
  const md = fs.readFileSync(report, 'utf-8');
  // Match: "- **bundle**: ok=N, failed=N, missed=N" (missed optional for back-compat)
  const totals = [...md.matchAll(/- \*\*(.+?)\*\*: ok=(\d+), failed=(\d+)(?:, missed=(\d+))?/g)];
  const declared = totals.reduce((s, m) => s + parseInt(m[2], 10) + parseInt(m[3], 10) + parseInt(m[4] || '0', 10), 0);
  const actual = countAssets(path.join(outDir, 'assets'));
  if (declared !== actual) return `declared ${declared} vs actual ${actual}`;
  return true;
};
function countAssets(root) {
  let n = 0;
  if (!fs.existsSync(root)) return 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) n += countAssets(f);
    else if (!e.name.endsWith('.meta')) n++;
  }
  return n;
}
