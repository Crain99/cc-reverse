import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KLASS_TO_IMPORTER, writeAssetMeta } from '../../src/core/cocos3x/engine3x.js';

describe('R14 Spine recovery', () => {
  it('maps sp.SkeletonData to spine importer', () => {
    expect(KLASS_TO_IMPORTER['sp.SkeletonData']).toBe('spine');
  });

  it('also pre-registers DragonBones importers', () => {
    expect(KLASS_TO_IMPORTER['dragonBones.DragonBonesAsset']).toBe('dragonbones');
    expect(KLASS_TO_IMPORTER['dragonBones.DragonBonesAtlasAsset']).toBe('dragonbones-atlas');
  });

  it('writeAssetMeta records textures + atlasInline when extras provided', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spine-'));
    const file = path.join(tmp, 'hero.json');
    fs.writeFileSync(file, '{}');
    await writeAssetMeta(file, {
      uuid: 'hero-uuid',
      klass: 'sp.SkeletonData',
      extras: { textures: ['tex-1', 'tex-2'], atlasInline: true },
    });
    const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf-8'));
    expect(meta.importer).toBe('spine');
    expect(meta.userData.textures).toEqual(['tex-1', 'tex-2']);
    expect(meta.userData.atlasInline).toBe(true);
    expect(meta.userData.recoveredBy).toBe('cc-reverse');
  });

  it('writeAssetMeta works without extras (back-compat)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spine2-'));
    const file = path.join(tmp, 'mat.json');
    fs.writeFileSync(file, '{}');
    await writeAssetMeta(file, { uuid: 'u1', klass: 'cc.Material' });
    const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf-8'));
    expect(meta.userData).toEqual({ recoveredBy: 'cc-reverse' });
  });
});
