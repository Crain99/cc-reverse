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
