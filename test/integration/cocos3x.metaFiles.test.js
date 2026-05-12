import { describe, it, expect } from 'vitest';
const { writeAssetMeta } = require('../../src/core/cocos3x/engine3x.js');
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('writeAssetMeta', () => {
  it('emits importer + uuid for SpriteFrame', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'meta-'));
    try {
      const file = path.join(dir, 'foo.png');
      require('node:fs').writeFileSync(file, Buffer.from([0]));
      await writeAssetMeta(file, { uuid: 'u1', klass: 'cc.SpriteFrame' });
      const meta = JSON.parse(readFileSync(file + '.meta', 'utf-8'));
      expect(meta.uuid).toBe('u1');
      expect(meta.importer).toMatch(/sprite-frame|texture/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
