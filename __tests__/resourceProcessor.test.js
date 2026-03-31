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

  test('sp.SkeletonData handler should extract skeleton json, atlas, and queue textures', () => {
    resourceProcessor.resetState();
    global.paths = { res: '/tmp/assets', output: '/tmp/output' };

    resourceProcessor.fileMap.set('tex-uuid', '/tmp/res/import/tex-uuid.png');

    const spineData = {
      __type__: 'sp.SkeletonData',
      _name: 'hero_spine',
      _native: '.json',
      _skeletonJson: { bones: [], slots: [], skins: [] },
      _atlasText: 'hero.png\nsize: 512,512\nformat: RGBA8888',
      textures: [{ __uuid__: 'tex-uuid' }]
    };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    resourceProcessor.writeProcessedData({ '0': spineData }, 'skeleton-uuid');

    // Should write skeleton JSON
    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.json',
      expect.objectContaining({ bones: [] })
    );

    // Should write atlas text
    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.atlas',
      expect.stringContaining('hero.png')
    );

    // Should write meta
    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.json.meta',
      expect.objectContaining({ uuid: 'skeleton-uuid' })
    );

    // Should queue texture for copy
    expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/tex-uuid.png');
  });
});
