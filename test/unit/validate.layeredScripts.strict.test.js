import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGates } from '../../src/validate/index.js';

function setup() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ls-strict-'));
}

function writeReport(dir, bundleRows) {
  const lines = [
    '# Recovery Report',
    '',
    '- Input: `/x`',
    '- Engine: 3.x',
    '',
    '## Bundles',
    '',
    '| Name | Encrypted | UUIDs | Paths | Recovered | Missing |',
    '| --- | --- | --- | --- | --- | --- |',
    ...bundleRows.map(n => `| ${n} | no | 1 | 1 | 1 | 0 |`),
    '',
    '## Scripts',
    '',
    '- Files recovered: ?',
  ];
  fs.writeFileSync(path.join(dir, 'RECOVERY_REPORT.md'), lines.join('\n'));
}

function writeJs(dir, rel, body = '// ok') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('validate gate: layeredScripts (strict)', () => {
  it('passes when recovered file count >= bundle count (fixture A)', () => {
    const tmp = setup();
    writeReport(tmp, ['internal', 'resources', 'main']);
    for (let i = 0; i < 9; i++) writeJs(tmp, `assets/Scripts/chunk_${i}.js`, "import x from 'cc';\n");
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('layeredScripts');
  });

  it('fails when recovery is near-empty relative to bundle count (fixture B: cgxfd)', () => {
    const tmp = setup();
    writeReport(tmp, ['internal', 'resources']);
    writeJs(tmp, 'assets/Scripts/settings.js');
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    const failed = r.failed.find(p => p.name === 'layeredScripts');
    expect(failed).toBeTruthy();
    expect(failed.detail).toMatch(/near-empty/);
    expect(failed.detail).toMatch(/2 bundles/);
  });

  it('passes pure-2.x style (no Scripts dir, no bundles section)', () => {
    const tmp = setup();
    fs.writeFileSync(path.join(tmp, 'RECOVERY_REPORT.md'), '# Recovery Report\n\nNo bundles.\n');
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
  });

  it('fails when RECOVERY_INDEX.json declares many entries but disk is < 30%', () => {
    const tmp = setup();
    const root = path.join(tmp, 'assets', 'Scripts');
    fs.mkdirSync(root, { recursive: true });
    const idx = {};
    for (let i = 0; i < 20; i++) idx[`u${i}`] = { path: `m/F${i}.ts`, className: `F${i}` };
    fs.writeFileSync(path.join(root, 'RECOVERY_INDEX.json'), JSON.stringify(idx));
    writeJs(tmp, 'assets/Scripts/m/F0.ts', '//');
    writeJs(tmp, 'assets/Scripts/m/F1.ts', '//');
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    const failed = r.failed.find(p => p.name === 'layeredScripts');
    expect(failed).toBeTruthy();
    expect(failed.detail).toMatch(/RECOVERY_INDEX\.json declares 20/);
  });

  it('passes when RECOVERY_INDEX.json declared count is met >=30%', () => {
    const tmp = setup();
    const root = path.join(tmp, 'assets', 'Scripts');
    fs.mkdirSync(root, { recursive: true });
    const idx = {};
    for (let i = 0; i < 10; i++) idx[`u${i}`] = { path: `m/F${i}.ts`, className: `F${i}` };
    fs.writeFileSync(path.join(root, 'RECOVERY_INDEX.json'), JSON.stringify(idx));
    for (let i = 0; i < 4; i++) writeJs(tmp, `assets/Scripts/m/F${i}.ts`, '//');
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
  });

  it('handles case-insensitive Scripts directory (lowercase scripts/)', () => {
    const tmp = setup();
    writeReport(tmp, ['a', 'b']);
    writeJs(tmp, 'assets/scripts/chunk_a.js');
    writeJs(tmp, 'assets/scripts/chunk_b.js');
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
  });
});
