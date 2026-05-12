import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProjectVersion } from '../../src/core/reverseEngine.js';

/**
 * Regression: dabaoyiqie sample (wechatgame 3.x build) has hashed
 * `config.<hash>.json` files in each bundle dir, not plain `config.json`.
 * Both auto-detection (is3xRoot) and 3.x bundle discovery must accept either
 * shape, otherwise the engine falls back to the 2.x pipeline and emits zero
 * resources.
 */
describe('3.x detection — hashed config.<hash>.json bundles', () => {
  function makeFixture(layout) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rev-hashcfg-'));
    for (const [rel, body] of Object.entries(layout)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return root;
  }

  it('detects 3.x when bundle dirs only have hashed config files', () => {
    const root = makeFixture({
      'assets/main/config.9ec11.json': '{"name":"main","paths":{},"uuids":[]}',
      'assets/main/index.js': '',
      'assets/internal/config.e6604.json': '{"name":"internal","paths":{},"uuids":[]}',
    });
    const info = detectProjectVersion(root);
    expect(info.version).toBe('3.x');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still detects 3.x with plain config.json', () => {
    const root = makeFixture({
      'assets/main/config.json': '{"name":"main","paths":{},"uuids":[]}',
    });
    const info = detectProjectVersion(root);
    expect(info.version).toBe('3.x');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does NOT misclassify 2.x build as 3.x (no config in any bundle)', () => {
    const root = makeFixture({
      'src/settings.js': 'window._CCSettings={};',
      'src/project.js': '// js',
      'res/raw-assets/.keep': '',
    });
    const info = detectProjectVersion(root);
    expect(info.version).toBe('2.3.x');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
