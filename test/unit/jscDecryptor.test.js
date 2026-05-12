import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { extractKeyFromProject, describeEncryptionState } from '../../src/core/jscDecryptor.js';

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

describe('extractKeyFromProject — source coverage', () => {
  it('finds key in application.js (3.x web build)', async () => {
    const dir = makeFixture({ 'application.js': 'var xxteaKey = "abc-def-1234";' });
    expect(await extractKeyFromProject(dir)).toBe('abc-def-1234');
  });

  it('finds key inside cocos-js bundle file', async () => {
    const dir = makeFixture({
      'cocos-js/cc.abc.js': 'window.XXTEA_KEY = "deadbeef-cafe-babe";'
    });
    expect(await extractKeyFromProject(dir)).toBe('deadbeef-cafe-babe');
  });

  it('finds key referenced in 3.x src/settings.json', async () => {
    const dir = makeFixture({
      'src/settings.json': JSON.stringify({ assets: { encrypted: true }, encryptKey: 'fromsettings-1234' })
    });
    expect(await extractKeyFromProject(dir)).toBe('fromsettings-1234');
  });

  it('decodes byte-array key form', async () => {
    const dir = makeFixture({
      'main.js': 'var xxteaKey = [0x61,0x62,0x63,0x64];'
    });
    expect(await extractKeyFromProject(dir)).toBe('abcd');
  });

  it('returns null when no key present', async () => {
    const dir = makeFixture({ 'main.js': '// nothing' });
    expect(await extractKeyFromProject(dir)).toBeNull();
  });

  it('returns null for empty byte array', async () => {
    const dir = makeFixture({ 'main.js': 'var xxteaKey = [];' });
    expect(await extractKeyFromProject(dir)).toBeNull();
  });
});

describe('describeEncryptionState', () => {
  it('reports unencrypted when no jsc', async () => {
    const dir = makeFixture({ 'main.js': '' });
    expect((await describeEncryptionState(dir)).encrypted).toBe(false);
  });
});
