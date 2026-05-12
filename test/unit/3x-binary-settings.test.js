import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectProjectFlavor } from '../../src/core/cocos3x/engine3x.js';

function buildSettingsBin() {
  const key = Buffer.from('engineVersion', 'utf-8');
  const val = Buffer.from('3.8.0', 'utf-8');
  return Buffer.concat([
    Buffer.from([0x81]),                     // fixmap len 1
    Buffer.from([0xa0 | key.length]), key,   // fixstr key
    Buffer.from([0xa0 | val.length]), val,   // fixstr value
  ]);
}

describe('R16 binary settings detection', () => {
  it('decodes src/settings.bin via notepack', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'settings.bin'), buildSettingsBin());
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).toBe('3.x');
    expect(out.settings.engineVersion).toBe('3.8.0');
  });

  it('detects hashed variant settings.<hash>.bin', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-h-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'settings.abc123.bin'), buildSettingsBin());
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).toBe('3.x');
    expect(out.settings.engineVersion).toBe('3.8.0');
  });

  it('prefers settings.json when both forms are present', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-j-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'settings.json'), JSON.stringify({ engineVersion: '3.7.1' }));
    fs.writeFileSync(path.join(tmp, 'src', 'settings.bin'), buildSettingsBin());
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).toBe('3.x');
    expect(out.settings.engineVersion).toBe('3.7.1');
  });

  it('returns non-3x flavor when neither form exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binset-none-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const out = await detectProjectFlavor(tmp);
    expect(out.flavor).not.toBe('3.x');
  });
});
