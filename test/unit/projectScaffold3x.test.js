import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { writeCocos3xProject } = require('../../src/core/cocos3x/projectScaffold.js');

describe('writeCocos3xProject', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'cc3x-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('emits project.json with name + creator version from settings', async () => {
    await writeCocos3xProject(dir, {
      projectName: 'mygame',
      cocosVersion: '3.8.2',
      settings: { engine: 'cocos-creator', launchScene: 'db://assets/main.scene' },
    });
    const proj = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
    expect(proj.name).toBe('mygame');
    expect(proj.creator.version).toBe('3.8.2');
  });

  it('falls back to defaults when settings are missing', async () => {
    await writeCocos3xProject(dir, {});
    const proj = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf-8'));
    expect(proj.name).toBeTruthy();
    expect(proj.creator.version).toMatch(/^3\./);
  });

  it('writes settings/project.json with design resolution from settings', async () => {
    await writeCocos3xProject(dir, {
      projectName: 'mygame',
      settings: { designResolution: { width: 750, height: 1334 } },
    });
    const sp = JSON.parse(readFileSync(path.join(dir, 'settings/project.json'), 'utf-8'));
    expect(sp['design-resolution-width']).toBe(750);
    expect(sp['design-resolution-height']).toBe(1334);
  });

  it('writes package.json named after the project', async () => {
    await writeCocos3xProject(dir, { projectName: 'My Game!' });
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true);
  });
});
