/*
 * Unit test for the 2.x RECOVERY_REPORT.md writer. Verifies that the
 * generated markdown is detected by the recoveryReport validate gate
 * (file present + declared count == on-disk asset count).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeRecoveryReport2x } = require('../../src/core/cocos2x/recoveryReport2x.js');
const recoveryReportGate = require('../../src/validate/gates/recoveryReport.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function touch(p) { mkdirp(path.dirname(p)); fs.writeFileSync(p, 'x'); }

describe('cocos2x writeRecoveryReport2x', () => {
  it('writes RECOVERY_REPORT.md and matches declared==actual on disk', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2x-rr-'));
    // 2.x flat assets layout
    touch(path.join(out, 'assets', 'Texture', 'a.png'));
    touch(path.join(out, 'assets', 'Texture', 'a.png.meta'));
    touch(path.join(out, 'assets', 'Prefab', 'p.prefab'));
    touch(path.join(out, 'assets', 'Scene', 's.fire'));

    await writeRecoveryReport2x({
      outputPath: out,
      sourcePath: '/dev/null',
      version: '2.4.x',
      processed: 3,
      decodedJsc: 0,
      failures: [],
    });

    const md = fs.readFileSync(path.join(out, 'RECOVERY_REPORT.md'), 'utf8');
    expect(md).toMatch(/# Recovery Report/);
    expect(md).toMatch(/Engine: 2\.4\.x/);
    expect(md).toMatch(/- \*\*main\*\*: ok=3, failed=0, missed=0/);
    expect(recoveryReportGate(out)).toBe(true);
  });

  it('reflects failures in the failed= count and Failures section', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2x-rr-fail-'));
    touch(path.join(out, 'assets', 'a.json'));
    touch(path.join(out, 'assets', 'b.json'));

    await writeRecoveryReport2x({
      outputPath: out,
      sourcePath: '/dev/null',
      version: '2.3.x',
      failures: ['could not decode foo.json: bad ccon'],
    });

    const md = fs.readFileSync(path.join(out, 'RECOVERY_REPORT.md'), 'utf8');
    expect(md).toMatch(/- \*\*main\*\*: ok=1, failed=1, missed=0/);
    expect(md).toMatch(/## Failures/);
    expect(md).toMatch(/foo\.json/);
    expect(recoveryReportGate(out)).toBe(true);
  });

  it('writes a valid report even when assets/ is empty', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2x-rr-empty-'));
    await writeRecoveryReport2x({
      outputPath: out,
      sourcePath: '/dev/null',
      version: '2.4.x',
    });
    const md = fs.readFileSync(path.join(out, 'RECOVERY_REPORT.md'), 'utf8');
    expect(md).toMatch(/- \*\*main\*\*: ok=0, failed=0, missed=0/);
    expect(recoveryReportGate(out)).toBe(true);
  });
});
