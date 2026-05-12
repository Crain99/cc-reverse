import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fixture = readFileSync(
  path.join(__dirname, '../fixtures/scriptRecovery/system-register-2-modules.js'),
  'utf8'
);

describe('Layer 1: chunkSplitter', () => {
  it('splits a chunk file containing 2 System.register calls into 2 modules', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Player');
    expect(out[1].name).toBe('Enemy');
    expect(out[0].registerId).toBe('chunks:///_virtual/Player.ts');
    expect(out[0].deps).toEqual(['cc']);
    expect(out[1].deps).toEqual(['cc', './Player']);
    expect(out[0].ast).toBeTruthy();
    expect(out[0].ast.type).toBe('File');
  });

  it('returns one passthrough module if no System.register is found', async () => {
    const out = await splitChunks({ name: 'plain.js', source: 'var x = 1;' });
    expect(out).toHaveLength(1);
    expect(out[0].registerId).toBeNull();
  });

  it('extracts setter bindings (var → import name mapping)', async () => {
    const out = await splitChunks({ name: 'a.js', source: fixture });
    const playerSetter = out[0].setterBindings;
    expect(playerSetter).toEqual([
      { dep: 'cc', bindings: [{ local: '_decorator', imported: '_decorator' }, { local: 'Component', imported: 'Component' }] }
    ]);
  });
});
