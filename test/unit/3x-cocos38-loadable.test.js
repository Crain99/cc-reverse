/*
 * Cocos 3.8 loadability — verifies the four blockers reported on slgq-reverse
 * are fixed:
 *   1. db:// prefix no longer creates literal `db:/` directories
 *   2. package.json carries the 3.8 schema (name/type/uuid/version/creator)
 *      verified against cocos/cocos-test-projects v3.8.7
 *   3. settings/v2/packages/project.json carries 3.8 settings shape
 *   4. cc.SceneAsset emits a .fire file at its declared path (covered via
 *      resolveOutputPath + the new info.path fallback in unpackAsset)
 *   5. Runtime files (bundle.js, spine.*-hash.js, ...) classify as runtime
 *      and would route to _runtime/, not assets/Scripts/
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeAll } from 'vitest';

import { resolveOutputPath, isRuntimeScript, RUNTIME_PATTERNS } from '../../src/core/cocos3x/engine3x.js';
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

  describe('package.json + project layout (3.8 schema)', () => {
    let pkgJson;
    let projectJson;
    let v2Project;
    let outDir;

    beforeAll(async () => {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-3.8-'));
      await writeCocos3xProject(outDir, { projectName: 'demo', cocosVersion: '3.8.3' });
      pkgJson = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
      projectJson = JSON.parse(fs.readFileSync(path.join(outDir, 'project.json'), 'utf8'));
      v2Project = JSON.parse(fs.readFileSync(
        path.join(outDir, 'settings', 'v2', 'packages', 'project.json'), 'utf8'));
    });

    it('package.json carries name, type:3d, uuid, version, creator.version', () => {
      // Schema verified against cocos/cocos-test-projects v3.8.7/package.json
      expect(pkgJson.name).toBe('demo');
      expect(pkgJson.type).toBe('3d');
      expect(typeof pkgJson.uuid).toBe('string');
      expect(pkgJson.uuid.length).toBeGreaterThan(0);
      expect(pkgJson.version).toBe('3.8.3');
      expect(pkgJson.creator).toEqual({ version: '3.8.3', dependencies: {} });
    });

    it('project.json kept as compatibility marker for legacy 2.x readers', () => {
      expect(projectJson.creator.version).toBe('3.8.3');
    });

    it('settings/v2/packages/project.json carries general.designResolution', () => {
      // Cocos 3.8 reads project settings from this path (not settings/project.json).
      expect(v2Project.general.designResolution).toBeDefined();
      expect(v2Project.general.designResolution.width).toBe(1280);
      expect(v2Project.sortingLayers).toBeDefined();
    });

    it('seeds extensions/ directory and standard 3.x .gitignore', () => {
      expect(fs.existsSync(path.join(outDir, 'extensions'))).toBe(true);
      const gi = fs.readFileSync(path.join(outDir, '.gitignore'), 'utf8');
      for (const entry of ['library/', 'local/', 'temp/', 'build/']) {
        expect(gi).toContain(entry);
      }
    });
  });

  describe('runtime script classifier', () => {
    it('flags engine adapters and SystemJS bootstrap as runtime', () => {
      expect(isRuntimeScript('bundle.js')).toBe(true);
      expect(isRuntimeScript('import-map.js')).toBe(true);
      expect(isRuntimeScript('application.js')).toBe(true);
      expect(isRuntimeScript('engine-adapter-min.js')).toBe(true);
      expect(isRuntimeScript('blapp-adapter-wasm-for-cocos-v3.js')).toBe(true);
      expect(isRuntimeScript('first-screen.js')).toBe(true);
      expect(isRuntimeScript('es7.js')).toBe(true);
      expect(isRuntimeScript('spine-1Pcan4ap.js')).toBe(true);
      expect(isRuntimeScript('spine.asm-BCCB8IGt.js')).toBe(true);
      expect(isRuntimeScript('spine.wasm-DxRECbrD.js')).toBe(true);
    });
    it('does NOT flag plausible user script names as runtime', () => {
      // These must remain in assets/Scripts/ so the editor compiles them.
      expect(isRuntimeScript('Player.js')).toBe(false);
      expect(isRuntimeScript('GameController.js')).toBe(false);
      expect(isRuntimeScript('Player-Behavior.js')).toBe(false);  // 8-char tail but not engine-prefixed
      expect(isRuntimeScript('MyScene-Controller.js')).toBe(false);
      expect(isRuntimeScript('settings.js')).toBe(false);
      expect(isRuntimeScript('cc.js')).toBe(false);                // already filtered upstream
    });
    it('RUNTIME_PATTERNS is a non-empty array of RegExp instances', () => {
      expect(Array.isArray(RUNTIME_PATTERNS)).toBe(true);
      expect(RUNTIME_PATTERNS.length).toBeGreaterThan(0);
      for (const p of RUNTIME_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    });
  });
});
