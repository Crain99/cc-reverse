import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeAssetMeta } from '../../src/core/cocos3x/engine3x.js';

describe('rich-meta on pure-native classes (PR6 carry-over #1)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-richmeta-'));
  });

  it('overwrites a legacy stub .meta with rich meta when klass is in KLASS_TO_IMPORTER', async () => {
    const outBase = path.join(tmp, 'native', 'ab', 'abcdef');
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + '.meta', JSON.stringify({ legacy: true }));
    fs.writeFileSync(outBase, Buffer.from([0, 1, 2, 3]));
    await writeAssetMeta(outBase, { uuid: 'abcdef', klass: 'cc.BufferAsset' });
    const meta = JSON.parse(fs.readFileSync(outBase + '.meta', 'utf-8'));
    expect(meta.legacy).toBeUndefined();
    expect(meta.importer).toBe('buffer');
    expect(meta.uuid).toBe('abcdef');
  });

  it('rich meta survives when its path collides with the legacy stub', async () => {
    const outBase = path.join(tmp, 'native', 'ab', 'collide');
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + '.meta', JSON.stringify({ legacyStub: true }));
    fs.writeFileSync(outBase, Buffer.from([9]));
    await writeAssetMeta(outBase, { uuid: 'collide', klass: 'cc.BufferAsset' });
    const meta = JSON.parse(fs.readFileSync(outBase + '.meta', 'utf-8'));
    expect(meta.legacyStub).toBeUndefined();
    expect(meta.importer).toBe('buffer');
  });
});
