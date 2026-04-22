const path = require('path');
const { parseBundleConfig, getImportPath, getNativePath } = require('../../src/core/cocos3x/bundleConfig');

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
