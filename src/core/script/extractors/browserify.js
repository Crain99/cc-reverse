/*
 * Extract modules from browserify / Cocos __require bundles via string scan
 * + brace balancing — no full-file Babel parse.
 *
 * Expected shape (Cocos 2.x project.js):
 *
 *   window.__require = function e(t,n,r){...}({
 *     "assets/scripts/Foo.js": [function(require,module,exports){
 *       cc._RF.push(module, "uuid", "Foo");
 *       // user code
 *       cc._RF.pop();
 *     }, { "./Bar": "assets/scripts/Bar.js" }],
 *     ...
 *   }, {}, ["assets/scripts/Foo.js"]);
 */

const { logger } = require('../../../utils/logger');

/**
 * @typedef {import('../types').ModuleRecord} ModuleRecord
 */

/**
 * @param {string} code
 * @returns {ModuleRecord[]}
 */
function extractBrowserifyModules(code) {
  if (!code || typeof code !== 'string') return [];

  const modulesObj = findModulesObject(code);
  if (!modulesObj) {
    logger.debug('browserify extractor: modules object not found');
    return [];
  }

  const records = [];
  const { text, absoluteOffset } = modulesObj;
  let i = 0;

  // Skip leading '{'
  if (text[i] === '{') i += 1;

  while (i < text.length) {
    i = skipWsAndCommas(text, i);
    if (i >= text.length || text[i] === '}') break;

    const keyResult = readPropertyKey(text, i);
    if (!keyResult) break;
    i = keyResult.next;

    i = skipWs(text, i);
    if (text[i] !== ':') {
      // Malformed — try to resync
      i += 1;
      continue;
    }
    i += 1;
    i = skipWs(text, i);

    if (text[i] !== '[') {
      // Not a module factory entry — skip value
      const skipped = skipValue(text, i);
      if (skipped < 0) break;
      i = skipped;
      continue;
    }

    const entry = readModuleEntry(text, i);
    if (!entry) {
      const skipped = skipValue(text, i);
      if (skipped < 0) break;
      i = skipped;
      continue;
    }

    i = entry.next;

    records.push({
      id: keyResult.key,
      source: entry.body,
      deps: entry.deps,
      // minified factories rename (require,module,exports) → (e,t,n)
      requireName: entry.requireName || 'require',
      moduleName: entry.moduleName || 'module',
      exportsName: entry.exportsName || 'exports',
      uuid: null,
      format: 'browserify',
      outPath: null,
      rawKey: keyResult.key,
      offset: absoluteOffset + entry.bodyStart,
    });
  }

  if (global.verbose) {
    logger.debug(`browserify extractor: recovered ${records.length} modules`);
  }

  return records;
}

/**
 * Locate the modules object `{ "k":[function...], ... }`.
 * Prefers the large object argument of a call that looks like the browserify prelude.
 * @param {string} code
 * @returns {{ text: string, absoluteOffset: number } | null}
 */
function findModulesObject(code) {
  // Strategy 1: after __require = function ... }(
  const requireAssign = code.search(/__require\s*=\s*function\b/);
  if (requireAssign >= 0) {
    const callOpen = findCallOpenAfterFunction(code, requireAssign);
    if (callOpen >= 0) {
      const obj = readBalanced(code, callOpen, '{', '}');
      if (obj && looksLikeModulesObject(obj.text)) {
        return { text: obj.text, absoluteOffset: callOpen };
      }
    }
  }

  // Strategy 2: trailing browserify invoke  }({ ... }, {}, [entry])
  // Search near the end for `},{},[` or `}, {}, [` and walk back to modules `{`.
  const tail = code.slice(Math.max(0, code.length - 200000));
  const tailOffset = Math.max(0, code.length - tail.length);
  const invokeMatch = tail.match(/\}\s*,\s*\{\s*\}\s*,\s*\[/);
  if (invokeMatch && invokeMatch.index != null) {
    const absInvoke = tailOffset + invokeMatch.index;
    // Walk left from `}` of modules object — the `}` right before `,{}`
    const closeBrace = absInvoke; // points at '}'
    const openBrace = findMatchingOpen(code, closeBrace, '{', '}');
    if (openBrace >= 0) {
      const text = code.slice(openBrace, closeBrace + 1);
      if (looksLikeModulesObject(text)) {
        return { text, absoluteOffset: openBrace };
      }
    }
  }

  // Strategy 3: first large object that contains `:[function(` entries
  const probe = /:\s*\[\s*function\s*\(/.exec(code);
  if (probe && probe.index != null) {
    // Walk left to nearest '{' that can open the modules map
    let pos = probe.index;
    while (pos > 0 && code[pos] !== '{') pos -= 1;
    // May need to walk further left if we're inside a nested structure —
    // try a few outer braces.
    for (let attempt = 0; attempt < 5 && pos >= 0; attempt += 1) {
      const obj = readBalanced(code, pos, '{', '}');
      if (obj && looksLikeModulesObject(obj.text) && obj.text.length > 50) {
        return { text: obj.text, absoluteOffset: pos };
      }
      pos = code.lastIndexOf('{', pos - 1);
    }
  }

  return null;
}

/**
 * After `function name(...) { ... }`, find the `(` of the immediate call.
 * @param {string} code
 * @param {number} from  index of "function" keyword area
 */
function findCallOpenAfterFunction(code, from) {
  // Find function body
  const fnKw = code.indexOf('function', from);
  if (fnKw < 0) return -1;
  let i = fnKw + 8;
  i = skipWs(code, i);
  // optional name
  if (/[A-Za-z_$]/.test(code[i] || '')) {
    while (i < code.length && /[\w$]/.test(code[i])) i += 1;
  }
  i = skipWs(code, i);
  if (code[i] !== '(') return -1;
  const params = readBalanced(code, i, '(', ')');
  if (!params) return -1;
  i = params.end + 1;
  i = skipWs(code, i);
  if (code[i] !== '{') return -1;
  const body = readBalanced(code, i, '{', '}');
  if (!body) return -1;
  i = body.end + 1;
  i = skipWs(code, i);
  if (code[i] === '(') return i + 1; // position of first char inside? We want '{' of arg
  // Actually call is `}({` so after body `}` we have `(` then `{`
  // findCallOpen should return index of `{` modules object
  if (code[i] === '(') {
    const afterParen = skipWs(code, i + 1);
    if (code[afterParen] === '{') return afterParen;
  }
  return -1;
}

function looksLikeModulesObject(text) {
  if (!text || text[0] !== '{') return false;
  // At least one factory entry
  return /:\s*\[\s*function\s*\(/.test(text);
}

/**
 * Read `[function(...){ body }, { deps }]` starting at `[`.
 * @returns {{ body: string, bodyStart: number, deps: Object<string,string>, requireName: string, moduleName: string, exportsName: string, next: number } | null}
 */
function readModuleEntry(text, start) {
  if (text[start] !== '[') return null;
  let i = start + 1;
  i = skipWs(text, i);

  if (!text.startsWith('function', i)) return null;
  i += 8;
  i = skipWs(text, i);
  // optional name
  if (/[A-Za-z_$]/.test(text[i] || '')) {
    while (i < text.length && /[\w$]/.test(text[i])) i += 1;
  }
  i = skipWs(text, i);
  if (text[i] !== '(') return null;
  const params = readBalanced(text, i, '(', ')');
  if (!params) return null;

  // Parse factory param names: function(require, module, exports) or minified (e, t, n)
  const paramNames = params.text
    .slice(1, -1)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const requireName = paramNames[0] || 'require';
  const moduleName = paramNames[1] || 'module';
  const exportsName = paramNames[2] || 'exports';

  i = params.end + 1;
  i = skipWs(text, i);
  if (text[i] !== '{') return null;

  const body = readBalanced(text, i, '{', '}');
  if (!body) return null;

  // body.text includes braces; module source is inner content
  const bodyStart = i + 1;
  const bodySource = text.slice(i + 1, body.end);
  i = body.end + 1;
  i = skipWs(text, i);

  let deps = {};
  if (text[i] === ',') {
    i += 1;
    i = skipWs(text, i);
    if (text[i] === '{') {
      const depsObj = readBalanced(text, i, '{', '}');
      if (depsObj) {
        deps = parseDepsObject(depsObj.text);
        i = depsObj.end + 1;
      }
    }
  }

  i = skipWs(text, i);
  if (text[i] === ']') i += 1;

  return {
    body: bodySource,
    bodyStart,
    deps,
    requireName,
    moduleName,
    exportsName,
    next: i,
  };
}

/**
 * Parse `{ "./a": "full/path", 1: 2 }` deps map with a light scanner.
 * @param {string} objText including braces
 * @returns {Object<string, string>}
 */
function parseDepsObject(objText) {
  const deps = {};
  if (!objText || objText.length < 2) return deps;

  let i = 1; // skip '{'
  while (i < objText.length) {
    i = skipWsAndCommas(objText, i);
    if (i >= objText.length || objText[i] === '}') break;

    const key = readPropertyKey(objText, i);
    if (!key) break;
    i = key.next;
    i = skipWs(objText, i);
    if (objText[i] !== ':') break;
    i += 1;
    i = skipWs(objText, i);

    const val = readPropertyKey(objText, i);
    if (!val) {
      // number or other — read until comma/brace
      const start = i;
      while (i < objText.length && objText[i] !== ',' && objText[i] !== '}') i += 1;
      deps[key.key] = objText.slice(start, i).trim();
    } else {
      deps[key.key] = val.key;
      i = val.next;
    }
  }
  return deps;
}

function readPropertyKey(text, start) {
  let i = skipWs(text, start);
  if (i >= text.length) return null;

  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    i += 1;
    let value = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        return { key: value, next: i };
      }
      value += ch;
      i += 1;
    }
    return null;
  }

  // bare identifier or number
  if (/[\w$]/.test(text[i])) {
    const s = i;
    while (i < text.length && /[\w$]/.test(text[i])) i += 1;
    return { key: text.slice(s, i), next: i };
  }

  return null;
}

/**
 * Read a balanced region starting at `open` char.
 * @returns {{ text: string, end: number } | null} end = index of closing char
 */
function readBalanced(text, openIdx, openCh, closeCh) {
  if (text[openIdx] !== openCh) return null;
  let depth = 0;
  let inStr = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(openIdx, i + 1), end: i };
      }
    }
  }
  return null;
}

/**
 * Find matching open brace for a known close index.
 */
function findMatchingOpen(text, closeIdx, openCh, closeCh) {
  let depth = 0;
  let inStr = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = closeIdx; i >= 0; i -= 1) {
    const ch = text[i];
    const prev = text[i - 1];

    // Reverse scan is imperfect for comments/strings; good enough for bundle tails.
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      // In reverse, escape is awkward; treat simply.
      if (ch === inStr && prev !== '\\') inStr = null;
      else if (ch === '\\') escaped = true;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }

    if (ch === closeCh) depth += 1;
    else if (ch === openCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Skip a JS value starting at i; returns index after the value.
 */
function skipValue(text, start) {
  let i = skipWs(text, start);
  if (i >= text.length) return -1;
  const ch = text[i];
  if (ch === '{' || ch === '[' || ch === '(') {
    const close = ch === '{' ? '}' : ch === '[' ? ']' : ')';
    const bal = readBalanced(text, i, ch, close);
    return bal ? bal.end + 1 : -1;
  }
  if (ch === '"' || ch === "'") {
    const k = readPropertyKey(text, i);
    return k ? k.next : -1;
  }
  // atom
  while (i < text.length && !/[,}\]]/.test(text[i])) i += 1;
  return i;
}

function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function skipWsAndCommas(text, i) {
  while (i < text.length && /[\s,]/.test(text[i])) i += 1;
  return i;
}

module.exports = {
  extractBrowserifyModules,
  // exported for unit tests
  findModulesObject,
  readBalanced,
  parseDepsObject,
};
