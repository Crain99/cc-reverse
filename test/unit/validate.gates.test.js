import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGates } from '../../src/validate/index.js';

describe('validate gate: cconV2', () => {
  it('passes when no rawjson sentinel files exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cconv2-'));
    fs.writeFileSync(path.join(dir, 'foo.json'), '{}');
    const r = runGates(dir, { gates: ['cconV2'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('cconV2');
  });

  it('fails when a .ccon-v2.rawjson sentinel is present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cconv2-'));
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub/x.ccon-v2.rawjson'), '');
    const r = runGates(dir, { gates: ['cconV2'] });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].name).toBe('cconV2');
  });
});

describe('validate gate: typedArrays', () => {
  it('always passes (informational) when typed-array markers present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ta-'));
    fs.writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify([{ __type__: 'Float32Array', __data__: 'AQID' }])
    );
    const r = runGates(dir, { gates: ['typedArrays'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('typedArrays');
  });

  it('passes on an empty directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ta-'));
    const r = runGates(dir, { gates: ['typedArrays'] });
    expect(r.failed).toEqual([]);
  });
});

describe('validate gate: layeredScripts', () => {
  it('passes when assets/scripts/ contains at least one .js with import statement', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ls-'));
    const dir = path.join(tmp, 'assets', 'scripts', 'index');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'A.js'), "import { Component } from 'cc';\nclass A {}\n");
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('layeredScripts');
  });

  it('passes (informational) when no assets/scripts/ exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ls-'));
    const r = runGates(tmp, { gates: ['layeredScripts'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('layeredScripts');
  });
});

describe('validate gate: recoveryIndex', () => {
  it('passes when index maps each uuid to an existing path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ri-'));
    const root = path.join(tmp, 'assets', 'scripts');
    fs.mkdirSync(path.join(root, 'main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main', 'Player.ts'), '// ok');
    fs.writeFileSync(
      path.join(root, 'RECOVERY_INDEX.json'),
      JSON.stringify({ 'p-u': { path: 'main/Player.ts', className: 'Player' } })
    );
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('recoveryIndex');
  });

  it('fails when index references a missing path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ri-'));
    const root = path.join(tmp, 'assets', 'scripts');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'RECOVERY_INDEX.json'),
      JSON.stringify({ 'p-u': { path: 'main/Missing.ts', className: 'Player' } })
    );
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.failed.map(p => p.name)).toContain('recoveryIndex');
  });

  it('passes (informational) when no RECOVERY_INDEX.json exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ri-'));
    const r = runGates(tmp, { gates: ['recoveryIndex'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('recoveryIndex');
  });
});

describe('validate gate: tsProject', () => {
  it('passes (informational) when tsconfig.json + .ts files present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ts-'));
    const root = path.join(tmp, 'assets', 'scripts');
    fs.mkdirSync(path.join(root, 'main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'main', 'A.ts'), 'export {};');
    fs.writeFileSync(path.join(root, 'main', 'B.ts'), 'export {};');
    const r = runGates(tmp, { gates: ['tsProject'] });
    expect(r.failed).toEqual([]);
    expect(r.passed.map(p => p.name)).toContain('tsProject');
  });
});
