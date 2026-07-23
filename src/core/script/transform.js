/*
 * Per-module transform: path recovery, require rewrite, uuid extraction.
 * Operates on a single ModuleRecord — never on the full bundle.
 */

const path = require('path');

/**
 * @typedef {import('./types').ModuleRecord} ModuleRecord
 * @typedef {import('./types').TransformResult} TransformResult
 */

/**
 * Transform one extracted module into emit-ready code + metadata.
 * @param {ModuleRecord} record
 * @param {object} [options]
 * @param {Map<string, ModuleRecord>} [options.byId]  all modules for dep resolution
 * @returns {TransformResult}
 */
function transformModule(record, options = {}) {
  const id = record.id || 'unknown';
  let code = record.source == null ? '' : String(record.source);

  // Normalize leading/trailing blank lines a bit
  code = stripOuterFactoryResidue(code);

  const uuid = record.uuid || extractUuidFromSource(code);
  const className = extractClassName(code, id);
  const outPath = record.outPath || idToOutPath(id, className);
  const requireName = record.requireName || 'require';

  // Rewrite require("x") / e("x") using deps map when present.
  // Minified Cocos bundles rename the factory param: function(e,t,n){ e("./Foo") }
  if (record.deps && Object.keys(record.deps).length > 0) {
    code = rewriteRequires(code, record.deps, outPath, options.byId, requireName);
  } else {
    // Legacy behavior: collapse require paths to basename (no extension)
    code = rewriteRequiresBasename(code, requireName);
  }

  // Normalize minified factory param back to `require` for readability
  if (requireName && requireName !== 'require' && isSafeIdent(requireName)) {
    code = renameFactoryRequire(code, requireName);
  }

  return {
    code: ensureTrailingNewline(code),
    uuid,
    outPath,
    className,
  };
}

/**
 * Map bundle id → output path under assets/Scripts.
 * @param {string} id
 * @param {string} [className]
 * @returns {string}
 */
function idToOutPath(id, className) {
  let p = String(id || 'module');

  // Strip common prefixes
  p = p
    .replace(/^db:\/\/assets\//i, '')
    .replace(/^db:\/\//i, '')
    .replace(/^assets\//i, '')
    .replace(/^src\//i, '');

  // Numeric browserify ids → Scripts/<id>.ts
  if (/^\d+$/.test(p)) {
    return `${p}.ts`;
  }

  // Drop query extension, force .ts
  p = p.replace(/\.(tsx?|jsx?)$/i, '');
  if (!p || p === '.') {
    p = className || 'module';
  }

  // Guard against absolute / parent escapes
  p = p.replace(/^([/\\])+/, '').replace(/\.\./g, '_');

  return `${p}.ts`;
}

/**
 * Pull uuid from `cc._RF.push(module, 'uuid', 'Name' ...)`
 * Cocos compresses uuids to 22-23 chars sometimes; also accept standard uuid.
 * @param {string} code
 * @returns {string|null}
 */
function extractUuidFromSource(code) {
  if (!code) return null;

  // cc._RF.push(e, "fcmR3XADNLgJ1ByKhqcC5Z", "Foo"
  const rf = code.match(
    /cc\s*\.\s*_RF\s*\.\s*push\s*\(\s*[^,]+,\s*['"]([0-9a-fA-F-]{22,36}|[A-Za-z0-9+/=]{20,24})['"]/,
  );
  if (rf) return rf[1];

  // Some builds: cc._RF.push(module, uuid, name) with var uuid earlier — skip

  return null;
}

/**
 * @param {string} code
 * @param {string} id
 * @returns {string}
 */
function extractClassName(code, id) {
  const rf = code && code.match(
    /cc\s*\.\s*_RF\s*\.\s*push\s*\(\s*[^,]+,\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/,
  );
  if (rf) return rf[1];

  const base = path.basename(String(id || 'module')).replace(/\.(tsx?|jsx?)$/i, '');
  return base || 'module';
}

/**
 * Rewrite require()/minifiedCall() using the browserify deps map.
 * deps: { "./util": "assets/scripts/util.js", "cc": false-ish }
 * @param {string} requireName  factory param name (often "require" or "e")
 */
function rewriteRequires(code, deps, selfOutPath, byId, requireName = 'require') {
  const name = isSafeIdent(requireName) ? requireName : 'require';
  const re = new RegExp(
    `\\b${escapeRegExp(name)}\\s*\\(\\s*(['"])([^'"\\n]+)\\1\\s*\\)`,
    'g',
  );

  return code.replace(re, (match, quote, spec) => {
    if (!Object.prototype.hasOwnProperty.call(deps, spec)) {
      // unknown — basename fallback
      const base = path.basename(spec).replace(/\.(tsx?|jsx?)$/i, '');
      return `require(${quote}${base}${quote})`;
    }

    const targetId = deps[spec];
    // external / false
    if (targetId === false || targetId == null || targetId === '') {
      return `require(${quote}${spec}${quote})`;
    }

    let targetOut;
    if (byId && byId.has(String(targetId))) {
      const rec = byId.get(String(targetId));
      targetOut = rec.outPath || idToOutPath(String(targetId));
    } else {
      targetOut = idToOutPath(String(targetId));
    }

    const rel = relativeRequire(selfOutPath, targetOut);
    return `require(${quote}${rel}${quote})`;
  });
}

function rewriteRequiresBasename(code, requireName = 'require') {
  const name = isSafeIdent(requireName) ? requireName : 'require';
  const re = new RegExp(
    `\\b${escapeRegExp(name)}\\s*\\(\\s*(['"])([^'"\\n]+)\\1\\s*\\)`,
    'g',
  );

  return code.replace(re, (match, quote, spec) => {
    // leave package-like bare specs (no path sep) alone if no slash
    if (!/[\/]/.test(spec) && !spec.startsWith('.')) {
      return name === 'require' ? match : `require(${quote}${spec}${quote})`;
    }
    const base = path.basename(spec).replace(/\.(tsx?|jsx?)$/i, '');
    return `require(${quote}${base}${quote})`;
  });
}

/**
 * After rewrites, rename leftover `e(...)` factory param uses is risky;
 * we already rewrote call sites to `require(...)`. This only fixes
 * residual free references that look like require(string).
 */
function renameFactoryRequire(code, requireName) {
  // Prefer not to do a blind identifier rename (too easy to hit locals).
  // rewriteRequires already emits `require(...)`.
  return code;
}

function isSafeIdent(name) {
  return typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compute a require path from one outPath to another (both under Scripts/).
 */
function relativeRequire(fromOut, toOut) {
  const fromDir = path.posix.dirname(toPosix(fromOut));
  let rel = path.posix.relative(fromDir === '.' ? '' : fromDir, toPosix(toOut));
  rel = rel.replace(/\.ts$/i, '');
  if (!rel.startsWith('.') && !rel.startsWith('/')) {
    rel = `./${rel}`;
  }
  return rel;
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function stripOuterFactoryResidue(code) {
  let s = code;
  // Sometimes body still starts with a leftover newline after brace strip
  s = s.replace(/^\uFEFF/, '');
  // Remove leading pure-whitespace line clutter but keep indentation of first code line
  s = s.replace(/^\s*\n/, '');
  return s;
}

function ensureTrailingNewline(code) {
  if (!code) return '\n';
  return code.endsWith('\n') ? code : `${code}\n`;
}

module.exports = {
  transformModule,
  idToOutPath,
  extractUuidFromSource,
  extractClassName,
  rewriteRequires,
  relativeRequire,
};
