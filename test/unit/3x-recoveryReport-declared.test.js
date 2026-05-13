/*
 * Unit test for engine3x.writeRecoveryReport: confirms that the declared total
 * (sum of ok/failed/missed across bundles in the markdown body) equals the
 * actual on-disk file count under <out>/assets, by emitting a synthetic
 * "__extras__" reconciliation row when the bundle summary undercounts.
 *
 * Mirrors the validate gate in src/validate/gates/recoveryReport.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeRecoveryReport } = require('../../src/core/cocos3x/engine3x.js');
const { RecoveryReport } = require('../../src/core/cocos3x/recoveryReport.js');
const recoveryReportGate = require('../../src/validate/gates/recoveryReport.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function touch(p, body = 'x') {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body);
}

describe('engine3x writeRecoveryReport declared count', () => {
  it('declared == actual when bundles undercount due to scripts/internal extras', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rr-decl-'));
    // Layout:
    //  - bundle "main" reports ok=2 (one prefab + one texture) but writes 4 files
    //    (also emits .png native + extra config.json that bundle counter missed)
    //  - bundle "internal" reports ok=1 but writes 3 files
    //  - scripts (not tracked per-bundle) at assets/scripts/*
    touch(path.join(out, 'assets', 'main', 'prefab.json'));
    touch(path.join(out, 'assets', 'main', 'texture.json'));
    touch(path.join(out, 'assets', 'main', 'texture.png'));
    touch(path.join(out, 'assets', 'main', 'config.json'));
    touch(path.join(out, 'assets', 'internal', 'a.json'));
    touch(path.join(out, 'assets', 'internal', 'b.json'));
    touch(path.join(out, 'assets', 'internal', 'c.json'));
    touch(path.join(out, 'assets', 'scripts', 'foo.ts'));
    touch(path.join(out, 'assets', 'scripts', 'bar.ts'));
    // .meta files must not be counted by the gate or our reconciler
    touch(path.join(out, 'assets', 'main', 'prefab.json.meta'));

    const report = new RecoveryReport();
    report.ok('main', 'u1', 'cc.Prefab');
    report.ok('main', 'u2', 'cc.Texture2D');
    report.ok('internal', 'u3', 'cc.Asset');

    const summary = {
      engine: '3.x',
      bundles: [
        { name: 'main',     encrypted: false, uuidCount: 2, pathCount: 2, recovered: 2, missing: 0 },
        { name: 'internal', encrypted: false, uuidCount: 1, pathCount: 1, recovered: 1, missing: 0 },
      ],
      scripts: { total: 2 },
      warnings: [],
    };

    await writeRecoveryReport(out, summary, '/dev/null', report);
    const verdict = recoveryReportGate(out);
    expect(verdict, `gate returned: ${verdict}`).toBe(true);
  });

  it('does not add extras row when bundle counts already match disk', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rr-decl2-'));
    touch(path.join(out, 'assets', 'main', 'a.json'));
    touch(path.join(out, 'assets', 'main', 'b.json'));

    const report = new RecoveryReport();
    report.ok('main', 'u1', 'cc.Prefab');
    report.ok('main', 'u2', 'cc.Texture2D');

    const summary = {
      engine: '3.x',
      bundles: [{ name: 'main', encrypted: false, uuidCount: 2, pathCount: 2, recovered: 2, missing: 0 }],
      scripts: { total: 0 },
      warnings: [],
    };

    await writeRecoveryReport(out, summary, '/dev/null', report);
    const md = fs.readFileSync(path.join(out, 'RECOVERY_REPORT.md'), 'utf8');
    expect(md).not.toMatch(/__extras__/);
    expect(recoveryReportGate(out)).toBe(true);
  });
});
