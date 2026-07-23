const fs = require('fs');
const os = require('os');
const path = require('path');
const { resourceProcessor } = require('../src/core/resourceProcessor');

describe('packed import restoration', () => {
  let tmp;
  let resDir;
  let outDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-packed-'));
    resDir = path.join(tmp, 'res');
    outDir = path.join(tmp, 'out');
    fs.mkdirSync(path.join(resDir, 'import', '02'), { recursive: true });
    fs.mkdirSync(path.join(resDir, 'raw-assets', 'aa'), { recursive: true });
    fs.mkdirSync(path.join(resDir, 'raw-assets', 'bb'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    // Fake png/mp3 bytes
    fs.writeFileSync(path.join(resDir, 'raw-assets', 'aa', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'), 'PNG');
    fs.writeFileSync(path.join(resDir, 'raw-assets', 'bb', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff.mp3'), 'MP3');

    global.paths = { res: resDir, output: outDir };
    global.config = { assets: { spriteOutputMode: 'single' }, advanced: { maxParallel: 4 } };
    global.settings = {
      CCSettings: {
        uuids: [
          'a1b2c3d4e5f6a7b8c9d0e1', // 0 audio compact-like 22? use real 22-char style later
          'c52ohf1dpDO5oKWBAPxgOx', // 1 scene
        ],
        assetTypes: ['cc.SpriteFrame', 'cc.Texture2D', 'cc.AudioClip', 'cc.Prefab'],
        packedAssets: {
          '02pack': [
            'sfCompact0000000000001', // spriteframe
            1, // scene → uuids[1]
            'audioCompact00000000001',
            'prefabCompact0000000001',
          ],
        },
        rawAssets: {
          assets: {
            0: ['music/success.mp3', 2],
          },
        },
        // override with proper keys matching expand
      },
    };

    // Use simpler settings that match our synthetic pack
    global.settings = {
      CCSettings: {
        uuids: [
          'a74390ae6d6848d1ad36f6', // unused
          'c52ohf1dpDO5oKWBAPxgOx',
        ],
        assetTypes: ['cc.SpriteFrame', 'cc.Texture2D', 'cc.AudioClip', 'cc.Prefab'],
        packedAssets: {
          '02pack': [
            'sf000000000000000000001',
            1,
            'aud00000000000000000001',
            'pre00000000000000000001',
          ],
        },
        rawAssets: {
          assets: {
            aud00000000000000000001: ['music/success.mp3', 2],
          },
        },
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('splits packed array into scene / sprite / audio / prefab', async () => {
    // Build packed import matching settings key 02pack
    // SpriteFrame with texture pointing at raw-assets full uuid
    const sprite = {
      __type__: 'cc.SpriteFrame',
      content: {
        name: 'fruit',
        texture: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        rect: [0, 0, 64, 64],
        offset: [0, 0],
        originalSize: [64, 64],
      },
    };

    const sceneDoc = [
      {
        __type__: 'cc.SceneAsset',
        _name: 'MainGameScene',
        scene: { __id__: 1 },
      },
      {
        __type__: 'cc.Scene',
        _name: 'New Node',
        _children: [{ __id__: 2 }],
      },
      {
        __type__: 'cc.Node',
        _name: 'Canvas',
        _children: [],
        _components: [],
      },
    ];

    const audio = {
      __type__: 'cc.AudioClip',
      _name: 'success',
      _native: '.mp3',
    };

    const prefabDoc = [
      {
        __type__: 'cc.Prefab',
        _name: 'star',
        data: { __id__: 1 },
      },
      {
        __type__: 'cc.Node',
        _name: 'star',
        _children: [],
        _components: [],
      },
    ];

    const packed = [sprite, sceneDoc, audio, prefabDoc];
    fs.writeFileSync(
      path.join(resDir, 'import', '02', '02pack.json'),
      JSON.stringify(packed),
    );

    // Point audio native lookup: decodeMaybe won't produce bb uuid from compact,
    // so place a file keyed by compact stem for findNativeFile basename path,
    // and also ensure nativeMap via actual raw-assets file for mp3 we created.
    // Map audio by writing raw-assets under a path findNativeFile can probe if we
    // set rawAssets path only — copy uses findNativeFile(uuid). Seed fileMap via processResources walk.

    // Put mp3 also under a name findNativeFile can get from rawAssets path? 
    // findNativeFile uses uuid; for test, put file at raw-assets/au/aud00000000000000000001.mp3
    fs.mkdirSync(path.join(resDir, 'raw-assets', 'au'), { recursive: true });
    fs.writeFileSync(path.join(resDir, 'raw-assets', 'au', 'aud00000000000000000001.mp3'), 'MP3');

    await resourceProcessor.processResources();
    await resourceProcessor.flushWrites();

    // Scene kept local __id__ space
    const scenePath = path.join(outDir, 'assets/Scene/MainGameScene.fire');
    expect(fs.existsSync(scenePath)).toBe(true);
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    expect(scene).toHaveLength(3);
    expect(scene[0].__type__).toBe('cc.SceneAsset');
    expect(scene[0].scene).toEqual({ __id__: 1 });
    expect(scene[1].__type__).toBe('cc.Scene');
    expect(scene[2]._name).toBe('Canvas');

    // Scene meta uuid expanded from uuids[1]
    const sceneMeta = JSON.parse(fs.readFileSync(scenePath + '.meta', 'utf8'));
    // c52ohf1dpDO5oKWBAPxgOx is 22-char → decoded
    expect(sceneMeta.uuid).toBeTruthy();

    // Prefab
    const prefabPath = path.join(outDir, 'assets/Prefab/star.prefab');
    expect(fs.existsSync(prefabPath)).toBe(true);
    const prefab = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
    expect(prefab[0].__type__).toBe('cc.Prefab');
    expect(prefab[0].data).toEqual({ __id__: 1 });

    // Sprite texture copied
    const texPath = path.join(outDir, 'assets/Texture/fruit.png');
    expect(fs.existsSync(texPath)).toBe(true);
    expect(fs.readFileSync(texPath, 'utf8')).toBe('PNG');

    // Audio copied under music/
    const audioPath = path.join(outDir, 'assets/Audio/music/success.mp3');
    expect(fs.existsSync(audioPath)).toBe(true);

    expect(resourceProcessor.sceneAssets.length).toBe(1);
    expect(Object.keys(resourceProcessor.spriteFrames).length).toBeGreaterThanOrEqual(1);
    expect(resourceProcessor.audio.length).toBe(1);
    expect(resourceProcessor.prefabs.length).toBe(1);
  });

  test('isDocumentArray detects scene/prefab documents', () => {
    expect(resourceProcessor.isDocumentArray([
      { __type__: 'cc.SceneAsset', _name: 'S' },
      { __type__: 'cc.Scene' },
    ])).toBe(true);
    expect(resourceProcessor.isDocumentArray([
      { __type__: 'cc.Prefab', _name: 'P' },
      { __type__: 'cc.Node' },
    ])).toBe(true);
    expect(resourceProcessor.isDocumentArray([
      { __type__: 'cc.SpriteFrame' },
      { __type__: 'cc.SpriteFrame' },
    ])).toBe(false);
  });

  test('expandUuidRef resolves numeric pack entries via uuids[]', () => {
    resourceProcessor.resetState();
    global.settings = {
      CCSettings: {
        uuids: ['aa', 'bb', 'ccSceneUuid00000000001'],
      },
    };
    resourceProcessor.buildSettingsIndex();
    expect(resourceProcessor.expandUuidRef(2)).toBe('ccSceneUuid00000000001');
    expect(resourceProcessor.expandUuidRef('2')).toBe('ccSceneUuid00000000001');
    expect(resourceProcessor.expandUuidRef('alreadyCompact')).toBe('alreadyCompact');
  });
});
