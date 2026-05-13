/*
 * Cocos 3.8 loadability — verifies the four blockers reported on slgq-reverse
 * are fixed:
 *   1. db:// prefix no longer creates literal `db:/` directories
 *   2. project.json carries the 3.8 schema fields Dashboard requires
 *   3. settings/project.json carries the `general` / packages_init / build-templates blocks
 *   4. cc.SceneAsset emits a .fire file at its declared path
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeAll } from 'vitest';

import { resolveOutputPath } from '../../src/core/cocos3x/engine3x.js';
import { writeCocos3xProject } from '../../src/core/cocos3x/projectScaffold.js';

describe('3.x cocos-3.8 loadability', () => {
  describe('db:// path stripping', () => {
    it('strips db://assets/ prefix on explicit paths', () => {
      const out = resolveOutputPath('u1', { paths: { u1: { path: 'db://assets/scene/foo' } } }, 'cc.SceneAsset', '.fire');
      expect(out).toBe('scene/foo.fire');
    });
    it('strips db://internal/ prefix', () => {
      const out = resolveOutputPath('u2', { paths: { u2: { path: 'db://internal/default_materials/x' } } }, 'cc.Material', '.mtl');
      expect(out).toBe('default_materials/x.mtl');
    });
    it('strips bare db:// when no namespace follows', () => {
      const out = resolveOutputPath('u3', { paths: { u3: { path: 'db://something/odd' } } }, 'cc.Asset', '');
      expect(out).toBe('something/odd');
    });
    it('passes plain paths through unchanged', () => {
      const out = resolveOutputPath('u4', { paths: { u4: { path: 'sub/dir/name' } } }, 'cc.Asset', '.json');
      expect(out).toBe('sub/dir/name.json');
    });
  });

  describe('project.json 3.8 schema', () => {
    let projectJson;
    let settingsJson;
    let outDir;

    beforeAll(async () => {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-3.8-'));
      await writeCocos3xProject(outDir, { projectName: 'demo', cocosVersion: '3.8.3' });
      projectJson = JSON.parse(fs.readFileSync(path.join(outDir, 'project.json'), 'utf8'));
      settingsJson = JSON.parse(fs.readFileSync(path.join(outDir, 'settings', 'project.json'), 'utf8'));
    });

    it('project.json carries name, uuid, type, packages, package-version', () => {
      expect(projectJson.name).toBe('demo');
      expect(typeof projectJson.uuid).toBe('string');
      expect(projectJson.uuid.length).toBeGreaterThan(0);
      expect(projectJson.type).toBe('creator-3.x');
      expect(projectJson.packages).toEqual({ engine: '3.8.3', editor: '>=3.8.3' });
      expect(projectJson['package-version']).toBe(2);
    });

    it('settings/project.json carries general.engineVersion + 3.8 init blocks', () => {
      expect(settingsJson.general).toBeDefined();
      expect(settingsJson.general.engineVersion).toBe('3.8.3');
      expect(settingsJson.general.designResolution).toBeDefined();
      expect(settingsJson.debug).toBe(true);
      expect(settingsJson.packages_init).toEqual({});
      expect(settingsJson['build-templates']).toEqual({});
    });

    it('seeds extensions/ and build-templates/ directories', () => {
      expect(fs.existsSync(path.join(outDir, 'extensions'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'build-templates'))).toBe(true);
    });

    it('writes a .gitignore with the standard 3.x ignore set', () => {
      const gi = fs.readFileSync(path.join(outDir, '.gitignore'), 'utf8');
      for (const entry of ['library/', 'local/', 'temp/', 'build/']) {
        expect(gi).toContain(entry);
      }
    });
  });
});
