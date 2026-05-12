/*
 * Layer 7 — humanify wrapper.
 *
 * Opt-in. Shells out to the user-installed `humanify` CLI
 * (https://github.com/jehna/humanify). Never installed automatically.
 * Two providers supported:
 *   - local   (default): offline LLM, downloadable model
 *   - openai           : OpenAI-compatible endpoint via OPENAI_BASE_URL / OPENAI_API_KEY
 *
 * The Copilot-via-copilot-api route is documented in the README as a
 * user-borne risk path; we never wire it programmatically.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const SUPPORTED_PROVIDERS = new Set(['local', 'openai']);

function buildHumanifyArgs(outDir, opts = {}) {
  const provider = opts.provider || 'local';
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`unsupported humanify provider: ${provider}`);
  }
  const args = [provider, '-o', path.join(outDir, 'humanified')];
  if (provider === 'openai') {
    if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
    if (opts.apiKey) args.push('--api-key', opts.apiKey);
    if (opts.model) args.push('--model', opts.model);
  }
  // Input is the recovered TS project's scripts dir.
  args.push(path.join(outDir, 'assets', 'scripts'));
  return args;
}

function installHint(bin) {
  if (path.isAbsolute(bin)) {
    return `humanify binary not found at ${bin}. Install via: npm i -g humanify`;
  }
  return 'humanify binary not found on PATH (npm i -g humanify)';
}

async function runHumanify(outDir, opts = {}) {
  const bin = opts._bin || 'humanify';
  let args;
  try {
    args = buildHumanifyArgs(outDir, opts);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  return await new Promise(resolve => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: opts.silent ? 'ignore' : 'inherit' });
    } catch (e) {
      resolve({
        ok: false,
        reason: e && e.code === 'ENOENT' ? installHint(bin) : `spawn failed: ${e.message || e}`,
      });
      return;
    }
    proc.on('error', e => {
      resolve({
        ok: false,
        reason: e && e.code === 'ENOENT' ? installHint(bin) : String(e.message || e),
      });
    });
    proc.on('exit', code => {
      if (code === 0) resolve({ ok: true, outDir: path.join(outDir, 'humanified') });
      else resolve({ ok: false, reason: `humanify exited with code ${code}` });
    });
  });
}

module.exports = { runHumanify, buildHumanifyArgs };
