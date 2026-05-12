const recoveryReport = require('./gates/recoveryReport');
const ALL = { recoveryReport };
function runGates(outputDir, { gates = Object.keys(ALL) } = {}) {
  const results = { passed: [], failed: [] };
  for (const name of gates) {
    const g = ALL[name];
    if (!g) continue;
    try {
      const ok = g(outputDir);
      (ok === true ? results.passed : results.failed).push({ name, detail: ok });
    } catch (e) { results.failed.push({ name, detail: e.message }); }
  }
  return results;
}
module.exports = { runGates };
