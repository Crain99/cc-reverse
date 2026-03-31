const path = require('path');
const fs = require('fs');

const { resourceProcessor } = require('../src/core/resourceProcessor');

describe('resourceProcessor issue regressions', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    global.paths = { res: '/tmp/assets' };
    global.settings = { CCSettings: {} };
  });

  test('writeProcessedData should not throw when nested value is null', () => {
    const data = {
      valid: { __type__: 'cc.SpriteFrame' },
      broken: null,
      nested: [{ inner: null }],
    };

    expect(() => resourceProcessor.writeProcessedData(data, 'key')).not.toThrow();
  });

  test('processSubpackages should read subpackages from CCSettings', async () => {
    global.settings = { CCSettings: { subpackages: [{ name: 'sub' }] } };

    const readFilesSpy = jest
      .spyOn(resourceProcessor, 'readFiles')
      .mockResolvedValue(undefined);
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    await resourceProcessor.processSubpackages();

    expect(readFilesSpy).toHaveBeenCalledWith(
      path.dirname(global.paths.res) + '/subpackages',
      false
    );
  });

  test('createLibrary should use uuids from CCSettings when available', () => {
    global.settings = { CCSettings: { uuids: { k1: 'known-uuid' } } };

    const result = resourceProcessor.createLibrary('0', 'k1');

    expect(result).toBe('known-uuid');
  });

  test('dragonBones.DragonBonesAsset handler should extract skeleton data', () => {
    resourceProcessor.resetState();
    global.paths = { res: '/tmp/assets', output: '/tmp/output' };

    const dbData = {
      __type__: 'dragonBones.DragonBonesAsset',
      _name: 'dragon',
      _native: '_ske.json',
      _dragonBonesJson: '{"armature":[]}'
    };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    resourceProcessor.writeProcessedData({ '0': dbData }, 'db-uuid');

    expect(writeFileSpy).toHaveBeenCalledWith('DragonBones', 'dragon_ske.json', '{"armature":[]}');
    expect(writeFileSpy).toHaveBeenCalledWith(
      'DragonBones', 'dragon_ske.json.meta',
      expect.objectContaining({ uuid: 'db-uuid' })
    );
  });

  test('dragonBones.DragonBonesAtlasAsset handler should extract atlas and queue texture', () => {
    resourceProcessor.resetState();
    global.paths = { res: '/tmp/assets', output: '/tmp/output' };

    resourceProcessor.fileMap.set('dbtex-uuid', '/tmp/res/import/dbtex-uuid.png');

    const dbAtlasData = {
      __type__: 'dragonBones.DragonBonesAtlasAsset',
      _name: 'dragon',
      _native: '_tex.json',
      _textureAtlasData: '{"imagePath":"dragon_tex.png"}',
      _texture: { __uuid__: 'dbtex-uuid' }
    };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    resourceProcessor.writeProcessedData({ '0': dbAtlasData }, 'dbatlas-uuid');

    expect(writeFileSpy).toHaveBeenCalledWith(
      'DragonBones', 'dragon_tex.json',
      expect.stringContaining('dragon_tex.png')
    );
    expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/dbtex-uuid.png');
  });
});
