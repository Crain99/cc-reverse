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

  test('fileMap key should use basename without extension, handling dots', () => {
    const fullPath1 = '/tmp/res/import/a1b2c3.json';
    const basename1 = path.basename(fullPath1);
    const key1 = basename1.substring(0, basename1.lastIndexOf('.')) || basename1;
    expect(key1).toBe('a1b2c3');

    const fullPath2 = '/tmp/res/import/a1.b2c3.json';
    const basename2 = path.basename(fullPath2);
    const key2 = basename2.substring(0, basename2.lastIndexOf('.')) || basename2;
    expect(key2).toBe('a1.b2c3');
  });

  test('processJsonFiles should accumulate nodeData per key, not overwrite', async () => {
    resourceProcessor.resetState();
    resourceProcessor.fileList = ['/tmp/res/aaa.json', '/tmp/res/bbb.json'];

    // Write temporary JSON files so readFile can actually read them
    const tmpDir = '/tmp/res';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync('/tmp/res/aaa.json', JSON.stringify({ type: 'first' }));
    fs.writeFileSync('/tmp/res/bbb.json', JSON.stringify({ type: 'second' }));

    jest.spyOn(resourceProcessor, 'processData').mockResolvedValue();

    await resourceProcessor.processJsonFiles();

    expect(resourceProcessor.nodeData['aaa']).toEqual({ type: 'first' });
    expect(resourceProcessor.nodeData['bbb']).toEqual({ type: 'second' });

    // Cleanup
    fs.unlinkSync('/tmp/res/aaa.json');
    fs.unlinkSync('/tmp/res/bbb.json');
  });

  test('createLibrary should use uuids from CCSettings when available', () => {
    global.settings = { CCSettings: { uuids: { k1: 'known-uuid' } } };

    const result = resourceProcessor.createLibrary('0', 'k1');

    expect(result).toBe('known-uuid');
  });

  test('type handler registry should route to correct handler', () => {
    resourceProcessor.resetState();

    const mockHandler = jest.fn();
    resourceProcessor.registerHandler('cc.TestType', mockHandler);

    const data = { '0': { __type__: 'cc.TestType', _name: 'test' } };
    resourceProcessor.writeProcessedData(data, 'testkey');

    expect(mockHandler).toHaveBeenCalledWith(
      { __type__: 'cc.TestType', _name: 'test' },
      'testkey',
      expect.objectContaining({ parentData: data, index: '0' })
    );
  });

  test('unknown type should be silently skipped', () => {
    resourceProcessor.resetState();

    const data = { '0': { __type__: 'cc.UnknownType', _name: 'test' } };
    expect(() => resourceProcessor.writeProcessedData(data, 'testkey')).not.toThrow();
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

    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.json',
      expect.objectContaining({ bones: [] })
    );

    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.atlas',
      expect.stringContaining('hero.png')
    );

    expect(writeFileSpy).toHaveBeenCalledWith(
      'Spine', 'hero_spine.json.meta',
      expect.objectContaining({ uuid: 'skeleton-uuid' })
    );

    expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/tex-uuid.png');
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

  describe('revealData', () => {
    test('should pass through plain format data unchanged', async () => {
      resourceProcessor.resetState();
      const plainData = {
        __type__: 'cc.AudioClip',
        _name: 'bgm',
        _native: '.mp3'
      };
      const result = await resourceProcessor.revealData(plainData);
      expect(result.__type__).toBe('cc.AudioClip');
      expect(result._name).toBe('bgm');
    });

    test('should restore compressed array format to object format', async () => {
      resourceProcessor.resetState();
      const compressedData = [
        ['cc.AudioClip'],
        [0, 'bgm', 0, '.mp3', 5.2, 0]
      ];
      const result = await resourceProcessor.revealData(compressedData);
      expect(result[1]).toBeDefined();
      expect(result[1]['__type__']).toBe('cc.AudioClip');
      expect(result[1]['_name']).toBe('bgm');
    });

    test('should resolve __id__ references', async () => {
      resourceProcessor.resetState();
      const dataWithRefs = [
        { __type__: 'cc.Node', _name: 'root', _children: [{ __id__: 1 }] },
        { __type__: 'cc.Node', _name: 'child' }
      ];
      const result = await resourceProcessor.revealData(dataWithRefs);
      expect(result[0]._children[0]).toBe(result[1]);
    });

    test('should decode compressed UUIDs in __uuid__ fields', async () => {
      resourceProcessor.resetState();
      const dataWithUuid = {
        __type__: 'cc.Sprite',
        _spriteFrame: { __uuid__: 'fcmR3XADNLgJ1ByKhqcC5Z' }
      };
      const result = await resourceProcessor.revealData(dataWithUuid);
      expect(result._spriteFrame.__uuid__).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('should handle non-compressed arrays by resolving refs and UUIDs', async () => {
      resourceProcessor.resetState();
      const data = [
        { __type__: 'cc.Node', _name: 'a', _ref: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'b' }
      ];
      const result = await resourceProcessor.revealData(data);
      expect(result[0]._ref).toBe(result[1]);
    });
  });

  test('processSpriteFrame single mode should queue texture and write meta', () => {
    resourceProcessor.resetState();
    global.paths = { res: '/tmp/assets', output: '/tmp/output' };
    global.config = { assets: { spriteOutputMode: 'single' } };

    resourceProcessor.fileMap.set('tex-001', '/tmp/res/import/tex-001.png');

    const spriteData = {
      __type__: 'cc.SpriteFrame',
      _name: 'icon_star',
      _rect: { x: 10, y: 20, width: 64, height: 64 },
      _offset: { x: 0, y: 0 },
      _originalSize: { width: 64, height: 64 },
      _rotated: false,
      _texture: { __uuid__: 'tex-001' }
    };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    resourceProcessor.processSpriteFrame({ '0': spriteData }, '0', 'frame-uuid');

    // Should store in spriteFrames
    expect(resourceProcessor.spriteFrames['frame-uuid']).toBeDefined();

    // Should queue texture for copy
    expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/tex-001.png');

    // Should write meta with subMetas
    expect(writeFileSpy).toHaveBeenCalledWith(
      'Texture',
      'icon_star.png.meta',
      expect.objectContaining({
        ver: '1.2.7',
        subMetas: expect.objectContaining({
          icon_star: expect.objectContaining({
            uuid: 'frame-uuid',
            width: 64,
            height: 64
          })
        })
      })
    );
  });

  test('processSpriteFrame should fallback to key-based fileMap lookup', () => {
    resourceProcessor.resetState();
    global.paths = { res: '/tmp/assets', output: '/tmp/output' };
    global.config = { assets: { spriteOutputMode: 'single' } };

    // No _texture reference, but fileMap has the key
    resourceProcessor.fileMap.set('frame-key', '/tmp/res/import/frame-key.png');

    const spriteData = {
      __type__: 'cc.SpriteFrame',
      _name: 'btn_bg',
      _rect: { x: 0, y: 0, width: 200, height: 80 },
      _offset: { x: 0, y: 0 },
      _originalSize: { width: 200, height: 80 },
      _rotated: false
    };

    jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    resourceProcessor.processSpriteFrame({ '0': spriteData }, '0', 'frame-key');

    expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/frame-key.png');
  });

  test('convertSpriteAtlas should generate PLIST in atlas mode', async () => {
    const { converters } = require('../src/core/converters');

    global.config = { assets: { spriteOutputMode: 'atlas' } };
    global.paths = { output: '/tmp/output' };

    const spriteFrames = {
      'frame-1': {
        _name: 'icon_a',
        _rect: { x: 0, y: 0, width: 64, height: 64 },
        _offset: { x: 0, y: 0 },
        _originalSize: { width: 64, height: 64 },
        _rotated: false,
        _texture: { __uuid__: 'atlas-tex' }
      },
      'frame-2': {
        _name: 'icon_b',
        _rect: { x: 64, y: 0, width: 32, height: 32 },
        _offset: { x: 0, y: 0 },
        _originalSize: { width: 32, height: 32 },
        _rotated: false,
        _texture: { __uuid__: 'atlas-tex' }
      }
    };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    await converters.convertSpriteAtlas(spriteFrames);

    // Should write a plist file for the atlas group
    expect(writeFileSpy).toHaveBeenCalledWith(
      'Texture',
      'icon_a.plist',
      expect.stringContaining('plist')
    );
  });

  test('convertSpriteAtlas should skip in single mode', async () => {
    const { converters } = require('../src/core/converters');

    global.config = { assets: { spriteOutputMode: 'single' } };

    const writeFileSpy = jest.spyOn(
      require('../src/utils/fileManager').fileManager, 'writeFile'
    ).mockResolvedValue();

    await converters.convertSpriteAtlas({ 'f': { _name: 'test' } });

    // Should NOT write any plist in single mode
    expect(writeFileSpy).not.toHaveBeenCalledWith(
      'Texture',
      expect.stringContaining('.plist'),
      expect.anything()
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
