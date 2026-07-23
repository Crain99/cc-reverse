const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectProjectVersion } = require('../src/core/reverseEngine');

describe('detectProjectVersion path compatibility', () => {
  function makeProject(root) {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.js'), 'window.CCSettings = {};');
  }

  test('detects 2.4.x when input path is project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-root-'));
    makeProject(root);

    const info = detectProjectVersion(root);

    expect(info.version).toBe('2.4.x');
    expect(info.resPath).toBe(path.join(root, 'assets'));
    expect(info.settingsPath).toBe(path.join(root, 'main.js'));
    expect(info.projectPath).toBe(path.join(root, 'main.js'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects 2.4.x when input path points to assets directory directly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-assets-'));
    makeProject(root);
    const assetsPath = path.join(root, 'assets');

    const info = detectProjectVersion(assetsPath);

    expect(info.version).toBe('2.4.x');
    expect(info.resPath).toBe(assetsPath);
    expect(info.settingsPath).toBe(path.join(root, 'main.js'));
    expect(info.projectPath).toBe(path.join(root, 'main.js'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects 3.x when assets/<bundle>/config.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-3x-'));
    const bundleDir = path.join(root, 'assets', 'main');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'config.json'), '{"name":"main"}');
    fs.writeFileSync(path.join(root, 'application.js'), '// launcher');

    const info = detectProjectVersion(root);

    expect(info.version).toBe('3.x');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects 3.x via versionHint even when only src/settings.json is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-3x-hint-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'settings.json'), '{}');

    const info = detectProjectVersion(root, '3.x');

    expect(info.version).toBe('3.x');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects bundle layout when only config.<hash>.json exists (MD5 Cache)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-md5-'));
    const bundleDir = path.join(root, 'assets', 'main');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'config.a1b2c3d4.json'), '{"name":"main"}');

    const info = detectProjectVersion(root);

    expect(info.version).toBe('3.x');
    expect(info.sourcePath).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('versionHint 2.4.x routes bundle/MD5 builds to bundle pipeline (issue #31)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-24-md5-'));
    // Classic-looking files that would previously force classic 2.4 pipeline
    fs.writeFileSync(path.join(root, 'main.js'), 'window.boot = function(){}');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    // But real payload is bundle + hashed config
    const bundleDir = path.join(root, 'assets', 'main');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'config.deadbeef.json'), '{"name":"main","uuids":[]}');

    const info = detectProjectVersion(root, '2.4.x');

    // Must NOT return classic 2.4.x paths — that yields JSON "textures"
    expect(info.version).toBe('3.x');
    expect(info.sourcePath).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects classic 2.4.x with hashed main.<hash>.js entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-24-hash-entry-'));
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.abcdef12.js'), 'window.CCSettings = {};');
    // no bundle config → classic layout

    const info = detectProjectVersion(root);

    expect(info.version).toBe('2.4.x');
    expect(info.settingsPath).toBe(path.join(root, 'main.abcdef12.js'));
    expect(info.projectPath).toBe(path.join(root, 'main.abcdef12.js'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
