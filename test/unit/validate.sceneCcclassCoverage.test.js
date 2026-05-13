import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';

import { runGates } from '../../src/validate/index.js';

describe('validate gate: sceneCcclassCoverage', () => {
  it('reports 100% coverage when every scene __type__ uuid is in RECOVERY_INDEX', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'cov-ok-'));
    const assets = path.join(out, 'assets');
    const mainDir = path.join(assets, 'main', 'scene');
    const scriptsDir = path.join(assets, 'scripts', 'main');
    await mkdir(mainDir, { recursive: true });
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      path.join(mainDir, 'game.scene'),
      JSON.stringify([{ __type__: 'cc.Node' }, { __type__: 'aaaa-uuid' }, { __type__: 'bbbb-uuid' }]),
    );
    await writeFile(
      path.join(assets, 'scripts', 'RECOVERY_INDEX.json'),
      JSON.stringify({ 'aaaa-uuid': { path: 'main/A.ts', className: 'A' } }),
    );
    await writeFile(
      path.join(scriptsDir, 'B.ts.meta'),
      JSON.stringify({ ver: '4.0.21', importer: 'typescript', uuid: 'bbbb-uuid' }),
    );

    const r = runGates(out, { gates: ['sceneCcclassCoverage'] });
    expect(r.passed.length).toBe(1);
    expect(r.passed[0].detail).toMatch(/2\/2 ccclass uuid refs resolved \(100%\)/);
  });

  it('flags unresolved uuids in detail (still passes — informational)', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'cov-bad-'));
    const mainDir = path.join(out, 'assets', 'main', 'scene');
    await mkdir(mainDir, { recursive: true });
    await writeFile(
      path.join(mainDir, 'game.scene'),
      JSON.stringify([{ __type__: 'orphan-uuid' }]),
    );
    const r = runGates(out, { gates: ['sceneCcclassCoverage'] });
    expect(r.passed.length).toBe(1);
    expect(r.passed[0].detail).toMatch(/0\/1 ccclass uuid refs resolved/);
    expect(r.passed[0].detail).toMatch(/orphan-uuid/);
  });
});
