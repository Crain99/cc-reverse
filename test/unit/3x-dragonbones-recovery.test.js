import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeAssetMeta } from '../../src/core/cocos3x/engine3x.js';

describe('R15 DragonBones recovery', () => {
  it('writeAssetMeta carries atlasUuid extra for DragonBonesAsset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-'));
    const f = path.join(tmp, 'monster.json');
    fs.writeFileSync(f, '{}');
    await writeAssetMeta(f, {
      uuid: 'm1',
      klass: 'dragonBones.DragonBonesAsset',
      extras: { atlasUuid: 'a1' },
    });
    const meta = JSON.parse(fs.readFileSync(f + '.meta', 'utf-8'));
    expect(meta.importer).toBe('dragonbones');
    expect(meta.userData.atlasUuid).toBe('a1');
  });

  it('writeAssetMeta carries textureUuid extra for DragonBonesAtlasAsset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db2-'));
    const f = path.join(tmp, 'monster_tex.json');
    fs.writeFileSync(f, '{}');
    await writeAssetMeta(f, {
      uuid: 'a1',
      klass: 'dragonBones.DragonBonesAtlasAsset',
      extras: { textureUuid: 't1' },
    });
    const meta = JSON.parse(fs.readFileSync(f + '.meta', 'utf-8'));
    expect(meta.importer).toBe('dragonbones-atlas');
    expect(meta.userData.textureUuid).toBe('t1');
  });
});
