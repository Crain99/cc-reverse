/*
 * @Description: Explicit reverse-engineering context (replaces ad-hoc globals)
 */

/**
 * Holds per-run state so concurrent reverse jobs don't stomp shared globals.
 * During migration we still mirror key fields onto `global` for legacy modules.
 */
class ReverseContext {
  /**
   * @param {object} options
   * @param {string} options.sourcePath
   * @param {string} options.outputPath
   * @param {boolean} [options.verbose]
   * @param {boolean} [options.silent]
   * @param {string} [options.versionHint]
   * @param {string} [options.key]
   * @param {string[]} [options.bundle]
   * @param {boolean} [options.assetsOnly]
   * @param {boolean} [options.scriptsOnly]
   * @param {object} [options.config]
   */
  constructor(options = {}) {
    this.sourcePath = options.sourcePath;
    this.outputPath = options.outputPath;
    this.verbose = !!options.verbose;
    this.silent = !!options.silent;
    this.versionHint = options.versionHint || '';
    this.key = options.key || null;
    this.bundleFilter = Array.isArray(options.bundle)
      ? options.bundle
      : (options.bundle ? [options.bundle] : []);
    this.assetsOnly = !!options.assetsOnly;
    this.scriptsOnly = !!options.scriptsOnly;
    this.config = options.config || {};

    this.version = null;
    this.settings = null;
    this.paths = {
      source: options.sourcePath,
      output: options.outputPath,
      res: null,
      temp: null,
      ast: null,
    };
  }

  /**
   * Mirror this context onto Node globals for modules that still read them.
   * Call after mutating version/paths/settings.
   */
  applyGlobals() {
    global.config = this.config;
    global.verbose = this.verbose;
    global.cocosVersion = this.version;
    global.paths = this.paths;
    if (this.settings != null) {
      global.settings = this.settings;
    }
  }
}

module.exports = { ReverseContext };
