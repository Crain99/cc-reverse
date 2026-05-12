import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Wave 2 placeholders', () => {
  it('projectScaffold module exports writeCocos3xProject (added in T1)', () => {
    const mod = require('../../src/core/cocos3x/projectScaffold.js');
    // Will be added in T1; for T0 we only assert the existing 2.x writer is intact.
    expect(typeof mod.writeCocos2xProject).toBe('function');
  });

  it('engine3x writeProjectDescriptor still emits a non-empty project.json', () => {
    // Smoke: source file mentions the function we plan to refactor in T1.
    const src = readFileSync(
      path.resolve(__dirname, '../../src/core/cocos3x/engine3x.js'),
      'utf-8'
    );
    expect(src).toMatch(/writeProjectDescriptor/);
    expect(src).toMatch(/project\.json/);
  });
});
