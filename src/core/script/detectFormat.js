/*
 * Detect how a 2.x script bundle (project.js / game.js) is packed.
 * Uses cheap string probes only — never full AST.
 */

/**
 * @typedef {'browserify' | 'webpack' | 'cocos-rf' | 'unknown'} ScriptBundleFormat
 */

/**
 * @param {string} code
 * @returns {ScriptBundleFormat}
 */
function detectScriptBundleFormat(code) {
  if (!code || typeof code !== 'string') return 'unknown';

  // Sample head+tail so huge files stay cheap.
  const head = code.slice(0, 64 * 1024);
  const midStart = Math.max(0, Math.floor(code.length / 2) - 16 * 1024);
  const mid = code.slice(midStart, midStart + 32 * 1024);
  const tail = code.slice(Math.max(0, code.length - 32 * 1024));
  const sample = head + '\n' + mid + '\n' + tail;

  // Cocos browserify / prelude: window.__require = function ... }({ "path":[function(
  if (
    /__require\s*=/.test(sample)
    && /:\s*\[\s*function\s*\(/.test(sample)
  ) {
    return 'browserify';
  }

  // Plain browserify bundle without __require name.
  // Shape: }({ "a":[function(require,module,exports){...},{deps}], ... },{},[entry]);
  if (
    /:\s*\[\s*function\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(sample)
    && /\}\s*,\s*\{\s*\}\s*,\s*\[/.test(sample)
  ) {
    return 'browserify';
  }

  // Numeric-id browserify: 1:[function(require,module,exports){
  if (
    /(?:^|[,{])\s*\d+\s*:\s*\[\s*function\s*\(/.test(sample)
    && /\}\s*,\s*\{\s*\}\s*,\s*\[/.test(sample)
  ) {
    return 'browserify';
  }

  // Webpack-ish: webpackJsonp / __webpack_require__ / installedModules
  if (
    /__webpack_require__|webpackJsonp|installedModules/.test(sample)
    && /function\s*\(\s*module\s*,\s*exports\s*,\s*__webpack_require__\s*\)/.test(sample)
  ) {
    return 'webpack';
  }

  // Modules contain cc._RF but no clear bundle wrapper — treat as cocos-rf source soup.
  if (/cc\s*\.\s*_RF\s*\.\s*push\s*\(/.test(sample)) {
    return 'cocos-rf';
  }

  // Generic modules object with function factories — still browserify-like.
  if (/:\s*\[\s*function\s*\(/.test(sample) && (sample.match(/:\s*\[\s*function\s*\(/g) || []).length >= 2) {
    return 'browserify';
  }

  return 'unknown';
}

module.exports = { detectScriptBundleFormat };
