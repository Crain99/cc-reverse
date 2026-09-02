const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseBundleConfig,
  normalizeDbAssetPath,
  getImportPath,
  getNativePath,
  findBundleConfigPath,
  hasBundleConfig,
  findBundleScriptPath,
} = require('../../src/core/cocos3x/bundleConfig');

describe('parseBundleConfig', () => {
  const baseDir = '/fake/bundle/main';

  it('expands compressed uuids when debug === false', () => {
    const raw = {
      name: 'main',
      debug: false,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['fcmR3XADNLgJ1ByKhqcC5Z'],
      paths: { 0: ['textures/bg', 0] },
      types: ['cc.Texture2D'],
      versions: { import: [], native: [] },
      scenes: {},
      packs: {},
      extensionMap: {},
    };
    const cfg = parseBundleConfig(raw, baseDir);
    expect(cfg.uuids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    const uuid = cfg.uuids[0];
    expect(cfg.paths[uuid]).toEqual({ path: 'textures/bg', type: 'cc.Texture2D', subAsset: false });
  });

  it('preserves debug-mode uuids as-is', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['aabbccdd-1234-4567-89ab-cdef01234567'],
      paths: { 0: ['textures/bg', 0] },
      types: ['cc.Texture2D'],
    };
    const cfg = parseBundleConfig(raw, baseDir);
    expect(cfg.uuids[0]).toBe('aabbccdd-1234-4567-89ab-cdef01234567');
  });

  it('resolves scenes map via uuid index', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['u0', 'u1'],
      paths: { 0: ['a', 0], 1: ['b', 1] },
      scenes: { Main: '0', Splash: '1' },
    };
    const cfg = parseBundleConfig(raw, baseDir);
    expect(cfg.scenes).toEqual({ Main: 'u0', Splash: 'u1' });
  });

  it('folds extensionMap into a uuid->ext dictionary', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['u0'],
      extensionMap: { '.png': ['u0'] },
    };
    const cfg = parseBundleConfig(raw, baseDir);
    expect(cfg.extensionMap['u0']).toBe('.png');
  });

  it('builds path-level versions lookup', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['u0', 'u1'],
      versions: { import: [0, 'abc', 1, 'def'], native: [0, 'xyz'] },
    };
    const cfg = parseBundleConfig(raw, baseDir);
    expect(cfg.versions.import.u0).toBe('abc');
    expect(cfg.versions.import.u1).toBe('def');
    expect(cfg.versions.native.u0).toBe('xyz');
    expect(cfg.versions.native.u1).toBeUndefined();
  });
});

describe('getImportPath / getNativePath', () => {
  const baseDir = '/builds/main';
  const cfg = {
    baseDir,
    importBase: 'import',
    nativeBase: 'native',
    versions: { import: { u0: 'v1' }, native: {} },
    extensionMap: {},
  };

  it('builds an import path with uuid prefix', () => {
    const p = getImportPath(cfg, 'abcdef-1234', '.json');
    expect(p).toBe(path.join(baseDir, 'import', 'ab', 'abcdef-1234.json'));
  });

  it('includes the version segment when present', () => {
    const p = getImportPath(cfg, 'u0', '.json');
    expect(p).toBe(path.join(baseDir, 'import', 'u0', 'u0.v1.json'));
  });

  it('builds native paths with extension', () => {
    const p = getNativePath(cfg, 'zzz-999', '.png');
    expect(p).toBe(path.join(baseDir, 'native', 'zz', 'zzz-999.png'));
  });

  it('returns null when uuid or ext missing', () => {
    expect(getNativePath(cfg, 'x', null)).toBeNull();
    expect(getNativePath(cfg, null, '.png')).toBeNull();
  });
});

describe('findBundleConfigPath / hasBundleConfig (MD5 Cache)', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bundle-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers plain config.json', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'config.abc.json'), '{}');
    expect(findBundleConfigPath(tmp)).toBe(path.join(tmp, 'config.json'));
    expect(hasBundleConfig(tmp)).toBe(true);
  });

  it('falls back to config.<hash>.json when plain missing', () => {
    fs.writeFileSync(path.join(tmp, 'config.a1b2c3d4.json'), '{"name":"main"}');
    const found = findBundleConfigPath(tmp);
    expect(found).toBe(path.join(tmp, 'config.a1b2c3d4.json'));
    expect(hasBundleConfig(tmp)).toBe(true);
  });

  it('returns null when no config present', () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), '//');
    expect(findBundleConfigPath(tmp)).toBeNull();
    expect(hasBundleConfig(tmp)).toBe(false);
  });

  it('resolves extensionMap entries that are uuid indexes', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['u0', 'u1'],
      extensionMap: { '.png': [1] },
    };
    const cfg = parseBundleConfig(raw, '/b');
    expect(cfg.extensionMap.u1).toBe('.png');
    expect(cfg.extensionMap.u0).toBeUndefined();
  });
});

describe('normalizeDbAssetPath', () => {
  it('strips db:// / db:/ and leading assets/ (no double assets under bundle)', () => {
    expect(normalizeDbAssetPath('db://assets/scenes/foo')).toBe('scenes/foo');
    expect(normalizeDbAssetPath('db:/assets/scenes/foo')).toBe('scenes/foo');
    expect(normalizeDbAssetPath('db://assets/scene/scene')).toBe('scene/scene');
    expect(normalizeDbAssetPath('db:/assets/scene/scene')).toBe('scene/scene');
    expect(normalizeDbAssetPath('db:/internal/physics/default-physics-material')).toBe(
      'internal/physics/default-physics-material',
    );
  });

  it('leaves plain relative paths alone (no assets/ prefix)', () => {
    expect(normalizeDbAssetPath('scenes/Main')).toBe('scenes/Main');
    expect(normalizeDbAssetPath('textures/logo')).toBe('textures/logo');
    expect(normalizeDbAssetPath('UI_res/headimage/texture')).toBe('UI_res/headimage/texture');
  });

  it('strips bare leading assets/ even without db: prefix', () => {
    expect(normalizeDbAssetPath('assets/textures/logo')).toBe('textures/logo');
  });

  it('passes through nullish', () => {
    expect(normalizeDbAssetPath(null)).toBe(null);
    expect(normalizeDbAssetPath(undefined)).toBe(undefined);
  });
});

describe('parseBundleConfig — real 3.8 db:/ paths', () => {
  it('normalizes db:/assets/... without double assets or literal db: segment', () => {
    const raw = {
      name: 'main',
      debug: true,
      uuids: ['u-scene', 'u-mat', 'u-tex'],
      paths: {
        0: ['db:/assets/scene/scene', 0],
        1: ['db:/internal/physics/default-physics-material', 1],
        2: ['UI_res/headimage/texture', 2],
      },
      types: ['cc.SceneAsset', 'cc.PhysicsMaterial', 'cc.Texture2D'],
      scenes: { 'db://assets/scene/scene.scene': '0' },
    };
    const cfg = parseBundleConfig(raw, '/fake/main');
    expect(cfg.paths['u-scene'].path).toBe('scene/scene');
    expect(cfg.paths['u-mat'].path).toBe('internal/physics/default-physics-material');
    expect(cfg.paths['u-tex'].path).toBe('UI_res/headimage/texture');
    expect(cfg.paths['u-scene'].path.includes('db:')).toBe(false);
    expect(cfg.paths['u-scene'].path.startsWith('assets/')).toBe(false);
  });
});


describe('parseBundleConfig — @suffix uuid decode', () => {
  it('decodes compressed uuids that carry @6c48a / @mip@fmt suffixes', () => {
    const raw = {
      name: 'main',
      debug: false,
      importBase: 'import',
      nativeBase: 'native',
      uuids: [
        '20g1ukYUVPvKWKBRznAKo+',
        '20g1ukYUVPvKWKBRznAKo+@6c48a',
        '6fAc9/gb9Kfr1dCvwZaWSA@b47c0@40c10',
      ],
      paths: {},
      types: [],
      versions: { import: [], native: [] },
      extensionMap: {},
    };
    const cfg = parseBundleConfig(raw, '/fake/main');
    expect(cfg.uuids[0]).toBe('20835ba4-6145-4fbc-a58a-051ce700aa3e');
    expect(cfg.uuids[1]).toBe('20835ba4-6145-4fbc-a58a-051ce700aa3e@6c48a');
    expect(cfg.uuids[2]).toBe('6f01cf7f-81bf-4a7e-bd5d-0afc19696480@b47c0@40c10');
    const native = getNativePath(cfg, cfg.uuids[2], '.png');
    expect(native.replace(/\\/g, '/')).toMatch(
      /native\/6f\/6f01cf7f-81bf-4a7e-bd5d-0afc19696480@b47c0@40c10\.png$/,
    );
  });
});


describe('findBundleScriptPath', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bundle-script-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers plain index.js over hashed', () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), '// plain');
    fs.writeFileSync(path.join(tmp, 'index.abc12.js'), '// hashed');
    expect(path.basename(findBundleScriptPath(tmp, 'index'))).toBe('index.js');
  });

  it('finds MD5-cache index.<hash>.js when plain is missing', () => {
    fs.writeFileSync(path.join(tmp, 'index.3e752.js'), '// hashed pack');
    expect(path.basename(findBundleScriptPath(tmp, 'index'))).toBe('index.3e752.js');
  });

  it('returns null when no script entry exists', () => {
    expect(findBundleScriptPath(tmp, 'index')).toBeNull();
  });
});
