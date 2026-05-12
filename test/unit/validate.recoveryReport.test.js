import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGates } from '../../src/validate/index.js';

describe('validate gate: recoveryReport.count-matches-fs', () => {
  it('passes when report counts match assets/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
    fs.mkdirSync(path.join(dir, 'assets/main/scene'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/main/scene/a.scene.json'), '{}');
    fs.writeFileSync(path.join(dir, 'RECOVERY_REPORT.md'),
      '# Recovery Report\n## Per-bundle counts\n- **main**: ok=1, failed=0, missed=0\n');
    const r = runGates(dir, { gates: ['recoveryReport'] });
    expect(r.failed).toEqual([]);
  });

  it('fails when declared count differs from actual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
    fs.mkdirSync(path.join(dir, 'assets/main'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/main/a.json'), '{}');
    fs.writeFileSync(path.join(dir, 'assets/main/b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'RECOVERY_REPORT.md'),
      '# Recovery Report\n## Per-bundle counts\n- **main**: ok=1, failed=0, missed=0\n');
    const r = runGates(dir, { gates: ['recoveryReport'] });
    expect(r.failed).toHaveLength(1);
  });
});
