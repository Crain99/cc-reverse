const recoveryReport = require('./gates/recoveryReport');
const cconV2         = require('./gates/cconV2');
const typedArrays    = require('./gates/typedArrays');
const layeredScripts = require('./gates/layeredScripts');
const ALL = { recoveryReport, cconV2, typedArrays, layeredScripts };
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
