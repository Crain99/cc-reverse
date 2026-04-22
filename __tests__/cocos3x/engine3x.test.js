const fs = require('fs');
const os = require('os');
const path = require('path');
const { reverseProject3x } = require('../../src/core/cocos3x/engine3x');

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

    // Scene recovered as .fire (our convention for legacy/2.4-style bundles).
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.fire'))).toBe(true);
    // Texture is pure-native — the PNG is written, no redundant .json.
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.json'))).toBe(false);

    // Meta files live next to the primary asset file.
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'scenes', 'Main.fire.meta'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'main', 'textures', 'logo.meta'))).toBe(true);

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
});
