import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cocos3xDir = path.resolve(__dirname, '../../src/core/cocos3x');

describe('3.x must not depend on 2.x typeDefinitions', () => {
  function listJs(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...listJs(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }
  const files = listJs(cocos3xDir);

  it('no 3.x file requires ../typeDefinitions', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).not.toMatch(/require\(['"]\.\.\/typeDefinitions['"]\)/);
    }
  });

  it('no 3.x file references the global typeDefinitions object', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).not.toMatch(/typeDefinitions\.getProperties/);
    }
  });

  it('rehydrate exposes sharedClasses-driven decoder shape', () => {
    const r = require('../../src/core/cocos3x/rehydrate.js');
    expect(typeof r.rehydrateIFileData).toBe('function');
  });
});
