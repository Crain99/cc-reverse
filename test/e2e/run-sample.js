/*
 * E2E sample runner: invokes the CLI to unpack a sample, then runs the
 * `validate` subcommand and writes a combined report to <outBase>/.e2e-report.json.
 *
 * Both invocations go through `node bin/cc-reverse.js ...` so this also exercises
 * the commander dispatch path that PR 8 fixes.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cc-reverse.js');

function run(args, opts = {}) {
  // Mini-game samples (e.g. slgq) ship 970+ ccclass modules; ts-morph +
  // prettier on the full set comfortably exceeds the default 4 GiB heap.
  // Bump the child to 8 GiB so the e2e harness can actually run the
  // pipeline that ships in production CLI use.
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout || 10 * 60 * 1000,
  });
  return {
    args,
    status: r.status,
    signal: r.signal,
    stdout: (r.stdout || '').slice(-20000),
    stderr: (r.stderr || '').slice(-20000),
    error: r.error ? String(r.error) : null,
  };
}

function tryReadRecoveryReport(outBase) {
  const p = path.join(outBase, 'RECOVERY_REPORT.md');
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, text, length: text.length };
}

function summarizeValidate(stdout) {
  try {
    const json = JSON.parse(stdout);
    const passed = (json.passed || []).map((x) => x.name);
    const failed = (json.failed || []).map((x) => x.name);
    return { passed, failed, total: passed.length + failed.length };
  } catch {
    return { passed: [], failed: [], total: 0, parseError: true };
  }
}

function runSample(samplePath, outBase, { timeout } = {}) {
  fs.mkdirSync(outBase, { recursive: true });

  const unpack = run(['-p', samplePath, '-o', outBase], { timeout });
  const validate = run(['validate', outBase], { timeout: 60_000 });

  const report = {
    samplePath,
    outBase,
    timestamp: new Date().toISOString(),
    unpack: {
      status: unpack.status,
      signal: unpack.signal,
      error: unpack.error,
      stdoutTail: unpack.stdout.split('\n').slice(-20).join('\n'),
      stderrTail: unpack.stderr.split('\n').slice(-20).join('\n'),
    },
    validate: {
      status: validate.status,
      signal: validate.signal,
      error: validate.error,
      raw: validate.stdout,
      summary: summarizeValidate(validate.stdout),
    },
    recoveryReport: (() => {
      const r = tryReadRecoveryReport(outBase);
      return r ? { exists: true, length: r.length } : { exists: false };
    })(),
  };

  const reportPath = path.join(outBase, '.e2e-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath };
}

module.exports = { runSample };
