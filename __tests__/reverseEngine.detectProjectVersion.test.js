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
});
