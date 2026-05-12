/*
 * E2E golden samples test.
 *
 * Runs the full CLI pipeline (unpack + validate) against three real Cocos
 * Creator projects living under ~/mini/. These samples are user-local and do
 * NOT exist in CI / on other developer machines, so each case is gracefully
 * skipped when its directory is missing.
 *
 * Baseline policy:
 *  - We only assert that unpack exits 0 (the pipeline ran end-to-end).
 *  - Quality-gate pass/fail counts are recorded but NOT asserted on a fixed
 *    threshold. A regression is defined as: a gate that PASSED in the
 *    committed baseline now FAILS. Improvements are surfaced as a console
 *    warning ("baseline can be updated") but do not fail the test.
 *  - First-run baselines are written to <out>/.suggested-baseline.json for
 *    human review; nothing is auto-committed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runSample } = require('./run-sample.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_DIR = path.join(REPO_ROOT, 'test', 'baselines');
const OUT_BASE = path.join(os.tmpdir(), 'cc-reverse-e2e');

const SAMPLES = [
  { name: 'slgq-reverse',       dir: path.join(os.homedir(), 'mini', 'slgq-reverse'),       note: '3.x main golden' },
  { name: 'dabaoyiqie-reverse', dir: path.join(os.homedir(), 'mini', 'dabaoyiqie-reverse'), note: '2.x' },
  { name: 'cgxfd-reverse',      dir: path.join(os.homedir(), 'mini', 'cgxfd-reverse'),      note: '2.x' },
];

const SAMPLE_TIMEOUT_MS = 8 * 60 * 1000;

function loadBaseline(name) {
  const p = path.join(BASELINE_DIR, name, 'manifest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function buildManifest(report) {
  const v = report.validate.summary;
  return {
    sample: path.basename(report.samplePath),
    unpackStatus: report.unpack.status,
    validateStatus: report.validate.status,
    gates: {
      passed: [...v.passed].sort(),
      failed: [...v.failed].sort(),
      total: v.total,
    },
    recoveryReportExists: report.recoveryReport.exists,
  };
}

function writeSuggested(outDir, manifest) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, '.suggested-baseline.json'), JSON.stringify(manifest, null, 2));
}

describe('E2E golden samples', () => {
  for (const sample of SAMPLES) {
    const present = existsSync(sample.dir);
    const fn = present ? it : it.skip;

    fn(`${sample.name} (${sample.note})`, async () => {
      const outBase = path.join(OUT_BASE, sample.name);
      const { report } = runSample(sample.dir, outBase, { timeout: SAMPLE_TIMEOUT_MS });

      // Hard assertion: unpack must complete cleanly. The CLI dispatch fix in
      // PR 8 makes this meaningful — previously the CLI silently printed help.
      expect(
        report.unpack.status,
        `unpack exit != 0; stderr tail:\n${report.unpack.stderrTail}`,
      ).toBe(0);

      const manifest = buildManifest(report);
      writeSuggested(outBase, manifest);

      const baseline = loadBaseline(sample.name);
      if (!baseline) {
        // First run: surface numbers, do not fail.
        // eslint-disable-next-line no-console
        console.log(`[e2e][${sample.name}] no baseline yet. Current manifest:\n${JSON.stringify(manifest, null, 2)}`);
        return;
      }

      const baselinePassed = new Set(baseline.gates?.passed || []);
      const currentPassed = new Set(manifest.gates.passed);
      const regressions = [...baselinePassed].filter((g) => !currentPassed.has(g));
      const improvements = [...currentPassed].filter((g) => !baselinePassed.has(g));

      if (improvements.length) {
        // eslint-disable-next-line no-console
        console.warn(`[e2e][${sample.name}] improvements detected (baseline can be updated): ${improvements.join(', ')}`);
      }
      expect(regressions, `gates regressed vs baseline: ${regressions.join(', ')}`).toEqual([]);
    }, SAMPLE_TIMEOUT_MS + 60_000);
  }
});
