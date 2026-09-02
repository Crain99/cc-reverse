const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reverseProject3x,
  parentPathOfSubAsset,
  normalizeAssetFilePath,
  indexImageSubAssets,
  shortMetaId,
  extractRfUuid,
  splitSystemRegisterSource,
  sanitizeScriptFileName,
  isEngineVendorScript,
  scriptOutRel,
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
    // chunks:///_virtual/Hero.ts → Hero.ts (not chunks___virtual_*)
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'Hero.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'Enemy.ts'))).toBe(true);
    const heroMeta = JSON.parse(
      fs.readFileSync(path.join(out, 'assets', 'Scripts', 'Hero.ts.meta'), 'utf8'),
    );
    expect(heroMeta.uuid).toBe(uuidUtils.decodeUuid('fcmR3XADNLgJ1ByKhqcC5Z'));
    expect(extractRfUuid(chunk)).toBe('fcmR3XADNLgJ1ByKhqcC5Z');
  });

  it('normalizes db:/assets paths so output has no literal db: segment', async () => {
    const src = path.join(tmp, 'dbslash-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    const bundleDir = path.join(src, 'assets', 'main');
    const config = {
      name: 'main',
      debug: true,
      importBase: 'import',
      nativeBase: 'native',
      uuids: ['u-scene'],
      paths: { 0: ['db:/assets/scene/scene', 0] },
      types: ['cc.SceneAsset'],
      scenes: { 'db://assets/scene/scene.scene': '0' },
      extensionMap: {},
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', 'u-', 'u-scene.json'),
      JSON.stringify({ __type__: 'cc.SceneAsset', _name: 'scene' }),
    );

    const out = path.join(tmp, 'out-dbslash');
    await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    const goodA = path.join(out, 'assets', 'main', 'assets', 'scene', 'scene.scene');
    const goodB = path.join(out, 'assets', 'main', 'scene', 'scene.scene');
    expect(fs.existsSync(goodA) || fs.existsSync(goodB)).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'db:'))).toBe(false);
    // No path segment literally named db:
    const walk = (dir, acc = []) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        acc.push(name);
        if (fs.statSync(full).isDirectory()) walk(full, acc);
      }
      return acc;
    };
    expect(walk(path.join(out, 'assets', 'main')).includes('db:')).toBe(false);
  });

  it('demuxes minified multi-System.register index.js like real 3.8 packs', async () => {
    const src = path.join(tmp, 'sysreg-min-build');
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

    // Head shape mirrors cocos-playable-demo assets/main/index.js
    const indexJs = (
      'System.register("chunks:///_virtual/debug-view-runtime-control.ts",["./rollupPluginModLoBabelHelpers.js","cc"],'
      + '(function(t){var e,o,i,n,s,l;return{setters:[function(t){e=t.applyDecoratedDescriptor},'
      + 'function(t){s=t.cclegacy,l=t._decorator}],execute:function(){'
      + 's._RF.push({},"b2bd1+njXxJxaFY3ymm06WU","debug-view-runtime-control",void 0);'
      + 't("DebugViewRuntimeControl",function(){});s._RF.pop()}}})});'
      + 'System.register("chunks:///_virtual/scene.ts",["cc"],(function(t){var e;return{setters:[function(t){e=t.cclegacy}],'
      + 'execute:function(){e._RF.push({},"a1b2c3d4e5f6g7h8i9j0k1","scene",void 0);'
      + 't("SceneCtrl",function(){});e._RF.pop()}}})});'
      + 'System.register("chunks:///_virtual/main",["./scene.ts"],(function(){return{setters:[function(){}],execute:function(){}}}));'
    );
    writeFile(path.join(bundleDir, 'index.js'), indexJs);

    const out = path.join(tmp, 'out-sysreg-min');
    const summary = await reverseProject3x({ sourcePath: src, outputPath: out });

    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'setters.ts'))).toBe(false);
    // Engine/vendor noise under _vendor/; game scripts stay at Scripts root
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', '_vendor', 'debug-view-runtime-control.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'debug-view-runtime-control.ts'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'scene.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', '_vendor', 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'main.js'))).toBe(false);
    expect(summary.scripts.total).toBeGreaterThanOrEqual(3);
    expect(summary.scripts.game).toBeGreaterThanOrEqual(1);
    expect(summary.scripts.vendor).toBeGreaterThanOrEqual(2);

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(out, 'assets', 'Scripts', '_vendor', 'debug-view-runtime-control.ts.meta'),
        'utf8',
      ),
    );
    expect(meta.uuid).toBe(uuidUtils.decodeUuid('b2bd1+njXxJxaFY3ymm06WU'));
  });


  it('demuxes MD5-cache index.<hash>.js fused chunks:///main.js as game main.pack.js', async () => {
    const src = path.join(tmp, 'md5-index-build');
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
    writeFile(path.join(bundleDir, 'config.deadbeef.json'), JSON.stringify(config));

    // Paren-balanced factory mirroring choose-your-answer-build MD5 packs.
    const indexJs = (
      'System.register("chunks:///main.js",["cc"],(function(){'
      + 'var c;return{setters:[function(m){c=m.cclegacy;}],'
      + 'execute:function(){c._RF.push({},"aaaaaaaaaaaaaaaaaaaaaa","Game");'
      + 'class Game{};c._RF.pop();}}));'
    );
    writeFile(path.join(bundleDir, 'index.3e752.js'), indexJs);

    const out = path.join(tmp, 'out-md5-index');
    const summary = await reverseProject3x({
      sourcePath: src,
      outputPath: out,
      verbose: false,
    });

    expect(fs.existsSync(path.join(out, 'assets', 'main', 'index.3e752.js'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', 'main.pack.js'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'Scripts', '_vendor', 'main.js'))).toBe(false);
    expect(summary.scripts.game).toBeGreaterThanOrEqual(1);
  });

});

describe('isEngineVendorScript / scriptOutRel', () => {
  it('classifies engine noise and bundle stubs as vendor', () => {
    expect(isEngineVendorScript('chunks:///_virtual/rollupPluginModLoBabelHelpers.js')).toBe(true);
    expect(isEngineVendorScript('builtin-pipeline.ts')).toBe(true);
    expect(isEngineVendorScript('builtin-pipeline-settings.ts')).toBe(true);
    expect(isEngineVendorScript('debug-view-runtime-control.ts')).toBe(true);
    expect(isEngineVendorScript('_virtual_cc-2a93dcea.js')).toBe(true);
    expect(isEngineVendorScript('spine-3e0daee9.js')).toBe(true);
    expect(isEngineVendorScript('spine.wasm-53ff874d.js')).toBe(true);
    expect(isEngineVendorScript('bullet.release.wasm-CA_q66kW.js')).toBe(true);
    expect(isEngineVendorScript('main')).toBe(true);
    expect(isEngineVendorScript('internal.js')).toBe(true);
    expect(isEngineVendorScript('BirdControl.ts')).toBe(false);
    expect(isEngineVendorScript('chunks:///_virtual/GameLogic.ts')).toBe(false);
    // Fused MD5 pack id is game content, not the `_virtual/main` stub.
    expect(isEngineVendorScript('chunks:///main.js')).toBe(false);
  });

  it('routes vendor under _vendor/ and leaves game scripts at root', () => {
    expect(scriptOutRel('BirdControl.ts')).toBe('BirdControl.ts');
    expect(scriptOutRel('rollupPluginModLoBabelHelpers.js')).toBe(
      '_vendor/rollupPluginModLoBabelHelpers.js',
    );
    expect(scriptOutRel('spine-3e0daee9.js', { forceVendor: true })).toBe(
      '_vendor/spine-3e0daee9.js',
    );
    expect(scriptOutRel('_vendor/already.js')).toBe('_vendor/already.js');
  });
});

describe('sanitizeScriptFileName / splitSystemRegisterSource', () => {
  it('maps chunks:///_virtual ids to sane filenames', () => {
    expect(sanitizeScriptFileName('chunks:///_virtual/Foo.ts')).toBe('Foo.ts');
    expect(sanitizeScriptFileName('chunks:///_virtual/game/Bar.ts')).toBe('game/Bar.ts');
    expect(sanitizeScriptFileName('chunks:///_virtual/main')).toBe('main.js');
  });

  it('splits minified multi-register packs with ids + aliased _RF uuids', () => {
    const code = (
      'System.register("chunks:///_virtual/A.ts",["cc"],(function(t){var s;return{setters:[function(t){s=t.cclegacy}],'
      + 'execute:function(){s._RF.push({},"b2bd1+njXxJxaFY3ymm06WU","A",void 0);t("A",1);s._RF.pop()}}})});'
      + 'System.register("chunks:///_virtual/B.ts",["cc"],(function(t){return{setters:[function(){}],execute:function(){t("B",2)}}}));'
    );
    const parts = splitSystemRegisterSource(code);
    expect(parts).toHaveLength(2);
    expect(parts[0].id).toBe('chunks:///_virtual/A.ts');
    expect(parts[0].uuid).toBe('b2bd1+njXxJxaFY3ymm06WU');
    expect(parts[1].id).toBe('chunks:///_virtual/B.ts');
    expect(parts[0].code.startsWith('System.register')).toBe(true);
  });

  it('skips anonymous wrappers and variable-id reexports (no module_N.js)', () => {
    const code = (
      'System.register([], function(_export, _context) { return { execute: function () {'
      + 'System.register("chunks:///_virtual/rollupPluginModLoBabelHelpers.js",[],(function(e){return{execute:function(){e("x",1)}}));'
      + '}});'
      + 'System.register("chunks:///_virtual/Foo.ts",["cc"],(function(t){return{setters:[function(){}],execute:function(){t("Foo",1)}}));'
      + 'System.register(mid, [cid], function (_export, _context) {'
      + 'return { setters: [function(_m) { _export(_m); }], execute: function () { } }; });'
    );
    const parts = splitSystemRegisterSource(code);
    expect(parts.map((p) => p.id)).toEqual([
      'chunks:///_virtual/rollupPluginModLoBabelHelpers.js',
      'chunks:///_virtual/Foo.ts',
    ]);
    expect(parts.every((p) => p.id)).toBe(true);
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
      uuids: ['u-img', 'u-tex', 'u-sf'],
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

  it('strips /texture and @suffix from asset file paths', () => {
    expect(normalizeAssetFilePath('UI_res/headimage/texture')).toBe('UI_res/headimage');
    expect(normalizeAssetFilePath('UI_res/headimage/spriteFrame')).toBe('UI_res/headimage');
    expect(normalizeAssetFilePath('db_stripped/logo@6c48a')).toBe('db_stripped/logo');
    expect(normalizeAssetFilePath('UI_res/headimage')).toBe('UI_res/headimage');
  });

  it('uses @suffix as shortMetaId so texture/spriteFrame do not collide', () => {
    const base = '0732b29a-d743-449d-aae6-331e8bcda30a';
    expect(shortMetaId(`${base}@6c48a`)).toBe('6c48a');
    expect(shortMetaId(`${base}@f9941`)).toBe('f9941');
    expect(shortMetaId('u-tex')).toBe('utex'); // dashes stripped, first 5
  });

  it('folds uuid-only @6c48a/@f9941 onto _packed parent path', () => {
    const base = '20835ba4-6145-4fbc-a58a-051ce700aa3e';
    const cfg = {
      uuids: [base, `${base}@6c48a`, `${base}@f9941`],
      paths: {},
    };
    const { byParent, childUuids } = indexImageSubAssets(cfg);
    expect(childUuids.has(`${base}@6c48a`)).toBe(true);
    expect(childUuids.has(`${base}@f9941`)).toBe(true);
    const parent = `_packed/${base.slice(0, 2)}/${base}`;
    expect(byParent.get(parent)).toHaveLength(2);
  });
});

describe('reverseProject3x — packed natives with @ uuids', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse3x-packnat-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  it('recovers named ImageAsset + folds @subAssets; maps compressed @ native', async () => {
    const src = path.join(tmp, 'tex-build');
    writeFile(path.join(src, 'application.js'), '// launcher');
    writeFile(path.join(src, 'src', 'settings.json'), '{}');

    // Real-style compressed ids (22-char) + @suffixes, debug:false so decode runs.
    const imgComp = '07MrKa10NEnarmMx6LzaMK'; // -> 0732b29a-...
    const texComp = `${imgComp}@6c48a`;
    const sfComp = `${imgComp}@f9941`;
    const orphanComp = '6fAc9/gb9Kfr1dCvwZaWSA@b47c0@40c10'; // mip/format native

    const imgUuid = uuidUtils.decodeUuid(imgComp);
    const orphanUuid = uuidUtils.decodeUuid(orphanComp);

    const bundleDir = path.join(src, 'assets', 'resources');
    const config = {
      name: 'resources',
      debug: false,
      importBase: 'import',
      nativeBase: 'native',
      uuids: [imgComp, texComp, sfComp, orphanComp],
      paths: {
        0: ['UI_res/headimage', 0, 1],
        1: ['UI_res/headimage/texture', 1, 1],
        2: ['UI_res/headimage/spriteFrame', 2, 1],
      },
      types: ['cc.ImageAsset', 'cc.Texture2D', 'cc.SpriteFrame'],
      scenes: {},
      packs: {},
      extensionMap: {},
      versions: { import: [], native: [] },
    };
    writeFile(path.join(bundleDir, 'config.json'), JSON.stringify(config));
    writeFile(
      path.join(bundleDir, 'import', imgUuid.slice(0, 2), `${imgUuid}.json`),
      JSON.stringify([1, 0, 0, ['cc.ImageAsset'], 0, [{ fmt: '0', w: 8, h: 8 }, -1], [0], 0, [], [], []]),
    );
    // Named native under decoded uuid
    writeFile(path.join(bundleDir, 'native', imgUuid.slice(0, 2), `${imgUuid}.png`), 'PNGDATA');
    // Orphan compressed-format native (no path entry)
    writeFile(
      path.join(bundleDir, 'native', orphanUuid.slice(0, 2), `${orphanUuid}.png`),
      'PNGORPHAN',
    );

    const out = path.join(tmp, 'out-tex');
    const summary = await reverseProject3x({ sourcePath: src, outputPath: out, assetsOnly: true });

    // Prefer real name over _packed
    expect(fs.existsSync(path.join(out, 'assets', 'resources', 'UI_res', 'headimage.png'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'resources', 'UI_res', 'headimage', 'texture.png'))).toBe(false);

    const meta = JSON.parse(
      fs.readFileSync(path.join(out, 'assets', 'resources', 'UI_res', 'headimage.png.meta'), 'utf8'),
    );
    expect(meta.uuid).toBe(imgUuid);
    expect(Object.keys(meta.subMetas).sort()).toEqual(['6c48a', 'f9941']);
    expect(meta.subMetas['6c48a'].displayName).toBe('texture');
    expect(meta.subMetas['f9941'].displayName).toBe('spriteFrame');
    expect(meta.subMetas['6c48a'].uuid).toBe(uuidUtils.decodeUuid(texComp));

    // Compressed @mip@fmt native recovered (under _packed — no config path)
    const orphanOut = path.join(
      out, 'assets', 'resources', '_packed', orphanUuid.slice(0, 2), `${orphanUuid}.png`,
    );
    expect(fs.existsSync(orphanOut)).toBe(true);
    expect(fs.readFileSync(orphanOut, 'utf8')).toBe('PNGORPHAN');

    const resBundle = summary.bundles.find((b) => b.name === 'resources');
    expect(resBundle.nativeImages).toBeGreaterThanOrEqual(2);
  });
});

