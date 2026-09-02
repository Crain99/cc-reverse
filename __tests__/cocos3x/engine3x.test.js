const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reverseProject3x,
  parentPathOfSubAsset,
  indexImageSubAssets,
  extractRfUuid,
} = require('../../src/core/cocos3x/engine3x');
const { uuidUtils } = require('../../src/utils/uuidUtils');
const { DataTypeID } = require('../../src/core/cocos3x/rehydrate');

describe('reverseProject3x — end-to-end on a synthetic fixture', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse3x-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  function buildFixture() {
    const src = path.join(tmp, 'src-build');
    // Minimal 3.x layout: application.js + src/settings.json + assets/main/
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(
      path.join(src, 'src', 'settings.json'),
      JSON.stringify({
        launch: { launchScene: 'u-scene' },
        assets: { importBase: 'import', nativeBase: 'native' },
      })
    );

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-scene', 'u-texture'],
      paths: {
        0: ['scenes/Main', 0],
        1: ['textures/logo', 1],
      },
      types: ['cc.SceneAsset', 'cc.Texture2D'],
      scenes: { Main: '0' },
      extensionMap: { '.png': ['u-texture'] },
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(path.join(bundleDir, 'index.js'), '// bundle stub');

    // Import files for each uuid.
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-scene.json'),
      JSON.stringify({ __type__: 'cc.SceneAsset', _name: 'Main' })
    );
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-texture.json'),
      JSON.stringify({ __type__: 'cc.Texture2D', _name: 'Logo' })
    );
    writeFile(path.join(bundleDir, 'native', 'u-', 'u-texture.png'), 'PNGDATA');

    // A user script under src/chunks.
    writeFile(
      path.join(src, 'src', 'chunks', 'Player.js'),
      'System.register(["cc"], function($$exp){});'
    );

    return src;
  }

  it('recovers assets when bundle config is MD5-hashed (config.<hash>.json)', async () => {
    const src = path.join(tmp, 'md5-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-tex'],
      paths: { 0: ['textures/logo', 0] },
      types: ['cc.Texture2D'],
      scenes: {},
      extensionMap: { '.png': ['u-tex'] },
      versions: {
        import: [0, 'h1'],
        native: [0, 'h2'],
      },
    };
    // Only hashed config — no config.json (Creator MD5 Cache)
    writeFile(path.join(bundleDir, 'config.deadbeef.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-tex.h1.json'),
      JSON.stringify({ __type__: 'cc.Texture2D', _name: 'Logo' }),
    );
    writeFile(path.join(bundleDir, 'native', 'u-', 'u-tex.h2.png'), 'PNGDATA');

    const out = path.join(tmp, 'out-md5');
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      verbose: false,
    });

    expect(summary.bundles).toHaveLength(1);
    expect(summary.bundles[0].recovered).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.png'))).toBe(true);
  });

  it('recovers each bundle asset and script into the output tree', async () => {
    const src = buildFixture();
    const out = path.join(tmp, 'out');

    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      verbose: false,
    });

    expect(summary.engine).toBe('3.x');
    expect(summary.bundles).toHaveLength(1);
    const mainBundle = summary.bundles[0];
    expect(mainBundle.name).toBe('main');
    expect(mainBundle.pathCount).toBe(2);
    expect(mainBundle.recovered).toBeGreaterThanOrEqual(2);

    // True 3.x (settings.json) scenes emit .scene + matching meta.
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.scene'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.fire'))).toBe(false);
    // Texture is pure-native — the PNG is written, no redundant .json.
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.json'))).toBe(false);

    // Meta files are basename+ext+.meta beside the recovered file.
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.scene.meta'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.png.meta'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.meta'))).toBe(false);

    // Script recovered.
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'Player.js'))).toBe(true);
    expect(summary.scripts.total).toBe(1);

    // Project descriptor + report emitted.
    expect(fs.existsSync(path.join(out, 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'RECOVERY_REPORT.md'))).toBe(true);
  });

  it('respects --bundle filter', async () => {
    const src = buildFixture();
    const out = path.join(tmp, 'out2');
    // internal bundle (no actual config) shouldn't be attempted; main should be skipped.
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      bundleFilter: ['resources'],
      verbose: false,
    });
    expect(summary.bundles).toHaveLength(0);
  });

  it('skips scripts when assetsOnly is set', async () => {
    const src = buildFixture();
    const out = path.join(tmp, 'out3');
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      assetsOnly: true,
    });
    expect(summary.scripts.total).toBe(0);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts'))).toBe(false);
  });

  it('does not write orphan texture meta when native PNG is missing', async () => {
    const src = path.join(tmp, 'orphan-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-missing'],
      paths: { 0: ['textures/ghost', 0] },
      types: ['cc.Texture2D'],
      scenes: {},
      extensionMap: { '.png': ['u-missing'] },
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-missing.json'),
      JSON.stringify({ __type__: 'cc.Texture2D', _name: 'Ghost' }),
    );
    // Intentionally NO native png

    const out = path.join(tmp, 'out-orphan');
    await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'ghost.png'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'ghost.png.meta'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'ghost.meta'))).toBe(false);
  });

  it('demuxes packed bundle index.js into multiple Scripts modules', async () => {
    const src = path.join(tmp, 'demux-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: [],
      paths: {},
      types: [],
      scenes: {},
      extensionMap: {},
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));

    // Minimal browserify-style __require pack with two modules + cc._RF mounts
    const indexJs = `
window.__require = function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n||e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s}({
"assets/scripts/Foo.js":[function(require,module,exports){
cc._RF.push(module, "fcmR3XADNLgJ1ByKhqcC5Z", "Foo");
module.exports = { name: "Foo" };
cc._RF.pop();
},{"./Bar.js":"assets/scripts/Bar.js"}],
"assets/scripts/Bar.js":[function(require,module,exports){
cc._RF.push(module, "a1b2c3d4e5f6a7b8c9d0e1", "Bar");
module.exports = { name: "Bar" };
cc._RF.pop();
},{}]
},{},["assets/scripts/Foo.js"]);
`;
    writeFile(path.join(bundleDir, 'index.js'), indexJs);

    const out = path.join(tmp, 'out-demux');
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      verbose: false,
    });

    // Raw index retained for reference
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'index.js'))).toBe(true);
    // Split modules under Scripts
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'scripts', 'Foo.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'scripts', 'Bar.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'scripts', 'Foo.ts.meta'))).toBe(true);
    expect(summary.scripts.total).toBeGreaterThanOrEqual(2);

    // Stable UUID from cc._RF.push (decoded), not a random one.
    const fooMeta = JSON.parse(
      fs.readFileSync(path.join(out, 'assets', 'Scripts', 'scripts', 'Foo.ts.meta'), 'utf8'),
    );
    expect(fooMeta.uuid).toBe(uuidUtils.decodeUuid('fcmR3XADNLgJ1ByKhqcC5Z'));
  });

  it('keeps .fire for 2.4.x-bundle flavor scenes', async () => {
    const src = path.join(tmp, 'bundle24-build');
    writeFile(path.join(src, 'src', 'settings.js'), 'window._CCSettings = { engineVersion: "2.4.14" };');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-scene'],
      paths: { 0: ['scenes/Main', 0] },
      types: ['cc.SceneAsset'],
      scenes: { Main: '0' },
      extensionMap: {},
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-scene.json'),
      JSON.stringify({ __type__: 'cc.SceneAsset', _name: 'Main' }),
    );

    const out = path.join(tmp, 'out-24');
    await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.fire'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.fire.meta'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.scene'))).toBe(false);
  });

  it('folds Texture2D/SpriteFrame subAssets into ImageAsset .png.meta subMetas', async () => {
    const src = path.join(tmp, 'img-sub-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-img', 'u-tex', 'u-sf'],
      paths: {
        0: ['textures/logo', 0],
        1: ['textures/logo@6c48a', 1, 1],
        2: ['textures/logo@f9941', 2, 1],
      },
      types: ['cc.ImageAsset', 'cc.Texture2D', 'cc.SpriteFrame'],
      scenes: {},
      extensionMap: { '.png': ['u-img'] },
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-img.json'),
      JSON.stringify({ __type__: 'cc.ImageAsset', _name: 'logo' }),
    );
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-tex.json'),
      JSON.stringify({ __type__: 'cc.Texture2D', _name: 'logo' }),
    );
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-sf.json'),
      JSON.stringify({ __type__: 'cc.SpriteFrame', _name: 'logo' }),
    );
    writeFile(path.join(bundleDir, 'native', 'u-', 'u-img.png'), 'PNGDATA');

    const out = path.join(tmp, 'out-img-sub');
    await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.png'))).toBe(true);
    const metaPath = path.join(out, 'assets', 'main', 'textures', 'logo.png.meta');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.uuid).toBe('u-img');
    expect(meta.importer).toBe('image');
    expect(Object.keys(meta.subMetas).length).toBe(2);
    const vals = Object.values(meta.subMetas);
    expect(vals.map((v) => v.displayName).sort()).toEqual(['spriteFrame', 'texture']);
    expect(vals.find((v) => v.displayName === 'texture').uuid).toBe('u-tex');
    expect(vals.find((v) => v.displayName === 'spriteFrame').uuid).toBe('u-sf');

    // No orphan subAsset folders / loose spriteFrame.json
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo@6c48a'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo@f9941'))).toBe(false);
  });

  it('rehydrates packed Prefab sections to Creator source-shaped JSON', async () => {
    const src = path.join(tmp, 'packed-prefab-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const packUuid = 'u-pack01';
    const prefabUuid = 'u-prefab1';
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: [prefabUuid, packUuid],
      paths: {
        0: ['prefabs/Button', 0],
      },
      types: ['cc.Prefab'],
      scenes: {},
      packs: {
        [packUuid]: [0],
      },
      extensionMap: {},
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));

    // IPackedFileData: shared header + one Prefab section (no standalone import).
    const section = [
      [
        [0, 'Button', 1],
        [1, 'Button', []],
        0,
      ],
      0,
      null,
      [],
      [],
      [],
    ];
    const packDoc = [
      1,
      [],
      [],
      [
        ['cc.Prefab', ['_name', 'data'], 2, DataTypeID.InstanceRef],
        ['cc.Node', ['_name', '_children'], 2, DataTypeID.Array_InstanceRef],
      ],
      [
        [0, 0, 1, 2],
        [1, 0, 1, 2],
      ],
      [section],
    ];
    writeFile(
      path.join(bundleDir, 'import', packUuid.slice(0, 2), `${packUuid}.json`),
      JSON.stringify(packDoc),
    );

    const out = path.join(tmp, 'out-packed-prefab');
    await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    const prefabPath = path.join(out, 'assets', 'main', 'prefabs', 'Button.prefab');
    expect(fs.existsSync(prefabPath)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
    expect(Array.isArray(doc)).toBe(true);
    expect(doc[0].__type__).toBe('cc.Prefab');
    expect(doc[0].data).toEqual({ __id__: 1 });
    expect(doc[1].__type__).toBe('cc.Node');
    expect(doc[1]._name).toBe('Button');
    expect(typeof doc[doc.length - 1]).not.toBe('number');
  });

  it('skips redirected uuids owned by dependency bundles', async () => {
    const src = path.join(tmp, 'redirect-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      deps: ['resources'],
      uuids: ['u-local', 'u-remote'],
      paths: {
        0: ['textures/local', 0],
        1: ['textures/remote', 0],
      },
      types: ['cc.Texture2D'],
      scenes: {},
      redirect: [1, 0],
      extensionMap: { '.png': ['u-local'] },
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-local.json'),
      JSON.stringify({ __type__: 'cc.Texture2D', _name: 'local' }),
    );
    writeFile(path.join(bundleDir, 'native', 'u-', 'u-local.png'), 'PNG');

    const out = path.join(tmp, 'out-redirect');
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      assetsOnly: true,
    });

    expect(summary.bundles[0].redirected).toBe(1);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'local.png'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'remote.png'))).toBe(false);
  });

  it('demuxes multi System.register chunks with stable RF uuids', async () => {
    const src = path.join(tmp, 'sysreg-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    writeFile(
      path.join(bundleDir, 'config.json'),
      JSON.stringify({
        name: 'main',
        debug: true,
        importBase: 'import',
        nativeBase: 'native',
        uuids: [],
        paths: {},
        types: [],
        scenes: {},
        extensionMap: {},
        versions: { import: [], native: [] },
      }),
    );

    const chunk = `
System.register("chunks:///_virtual/Hero.ts", ["cc"], function (e) {
  cc._RF.push(module, "fcmR3XADNLgJ1ByKhqcC5Z", "Hero");
  e("Hero", class Hero {});
  cc._RF.pop();
});
System.register("chunks:///_virtual/Enemy.ts", ["cc"], function (e) {
  cc._RF.push(module, "68076EFnW1JeZUzdnbOOKNr", "Enemy");
  e("Enemy", class Enemy {});
  cc._RF.pop();
});
`;
    writeFile(path.join(src, 'src', 'chunks', 'bundle.js'), chunk);

    const out = path.join(tmp, 'out-sysreg');
    const summary = await reverseProject3x({ sourcePath: src, outputPath: out });

    expect(summary.scripts.total).toBeGreaterThanOrEqual(2);
    const heroMetaPath = path.join(out, 'assets', 'Scripts', 'chunks___virtual_Hero.ts.js.meta');
    // sanitize turns chunks:///_virtual/Hero.ts → chunks___virtual_Hero.ts
    const scriptsDir = path.join(out, 'assets', 'Scripts');
    const metas = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.meta'));
    expect(metas.length).toBeGreaterThanOrEqual(2);
    const heroMetaFile = metas.find((f) => /Hero/i.test(f));
    expect(heroMetaFile).toBeTruthy();
    const heroMeta = JSON.parse(fs.readFileSync(path.join(scriptsDir, heroMetaFile), 'utf8'));
    expect(heroMeta.uuid).toBe(uuidUtils.decodeUuid('fcmR3XADNLgJ1ByKhqcC5Z'));
    expect(extractRfUuid(chunk)).toBe('fcmR3XADNLgJ1ByKhqcC5Z');
  });

});

describe('image subAsset path helpers', () => {
  it('parses @id and /texture|/spriteFrame parent paths', () => {
    expect(parentPathOfSubAsset('textures/logo@6c48a')).toBe('textures/logo');
    expect(parentPathOfSubAsset('textures/logo/texture')).toBe('textures/logo');
    expect(parentPathOfSubAsset('textures/logo/spriteFrame')).toBe('textures/logo');
    expect(parentPathOfSubAsset('textures/logo')).toBeNull();
  });

  it('indexes subAssets onto parent paths', () => {
    const cfg = {
      paths: {
        'u-img': { path: 'textures/logo', type: 'cc.ImageAsset', subAsset: false },
        'u-tex': { path: 'textures/logo@6c48a', type: 'cc.Texture2D', subAsset: true },
        'u-sf': { path: 'textures/logo/spriteFrame', type: 'cc.SpriteFrame', subAsset: true },
      },
    };
    const { byParent, childUuids } = indexImageSubAssets(cfg);
    expect(childUuids.has('u-tex')).toBe(true);
    expect(childUuids.has('u-sf')).toBe(true);
    expect(byParent.get('textures/logo')).toHaveLength(2);
  });
});
