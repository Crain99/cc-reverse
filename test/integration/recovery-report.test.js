import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import fixtures from '../fixtures.config.js';

const sample = fixtures.zqndtz;
const skip = !fs.existsSync(sample.path);

describe.skipIf(skip)('integration: RecoveryReport on zqndtz', () => {
  it('writes RECOVERY_REPORT.md after unpack', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zqndtz-out-'));
    const { reverseProject3x } = await import('../../src/core/cocos3x/engine3x.js');
    await reverseProject3x({ sourcePath: sample.path, outputPath: out, scriptsOnly: false, assetsOnly: true });
    expect(fs.existsSync(path.join(out, 'RECOVERY_REPORT.md'))).toBe(true);
  }, 120_000);
});
