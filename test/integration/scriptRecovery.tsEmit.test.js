import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { emitTsProject } from '../../src/core/cocos3x/scriptRecovery/tsProjectEmitter.js';

describe('Layer 6: tsProjectEmitter (integration)', () => {
  it('emits one .ts per module with inferred field types and a tsconfig.json', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-ts-'));
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass, property } = _decorator;
      @ccclass('Player')
      class Player extends Component {
        _speed = 0;
        _name = '';
      }
    `;
    const modules = [{
      name: 'Player',
      bundle: 'main',
      ast: parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] }),
      ccclassName: 'Player',
      uuid: 'p-uuid',
      uuidMap: { 'p-uuid': { className: 'Player', moduleName: 'Player' } },
      fieldTypes: { _speed: 'number', _name: 'string' },
      source: src,
    }];
    const result = await emitTsProject(modules, { outRoot: tmp });
    expect(result.filesEmitted).toBe(1);
    const tsPath = path.join(tmp, 'main', 'Player.ts');
    await access(tsPath);
    const ts = await readFile(tsPath, 'utf8');
    expect(ts).toMatch(/_speed\s*:\s*number/);
    expect(ts).toMatch(/_name\s*:\s*string/);
    await access(path.join(tmp, 'tsconfig.json'));
    const idx = JSON.parse(await readFile(path.join(tmp, 'RECOVERY_INDEX.json'), 'utf8'));
    expect(idx['p-uuid']).toEqual({ path: 'main/Player.ts', className: 'Player' });

    // .ts.meta uuid MUST equal the _RF.push uuid carried on mod.uuid — this
    // is what lets game.scene's `__type__: "p-uuid"` references resolve to
    // the recovered Player class instead of the brown UnknownNode fallback.
    const metaPath = `${tsPath}.meta`;
    await access(metaPath);
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    expect(meta.uuid).toBe('p-uuid');
    expect(meta.importer).toBe('typescript');
    expect(meta.ver).toBe('4.0.21');
  });

  it('returns {filesEmitted:0} when no modules', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-ts-empty-'));
    const r = await emitTsProject([], { outRoot: tmp });
    expect(r.filesEmitted).toBe(0);
  });

  it('skips ts-morph and prettier on the no-fieldTypes fast path', async () => {
    // Mini-game bundles routinely emit hundreds of modules with no
    // scene-driven field bindings; they take the fast path that bypasses
    // ts-morph (no annotation needed) and prettier (off by default). The
    // .ts file is then the raw babel-generator output. Required behaviour:
    // file exists, .ts.meta uuid is intact, RECOVERY_INDEX is populated.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-ts-fast-'));
    const src = `class A {} export default A;`;
    const modules = [{
      name: 'A',
      bundle: 'main',
      ast: parse(src, { sourceType: 'module' }),
      ccclassName: 'A',
      uuid: 'a-uuid',
      // no fieldTypes — ts-morph branch must be skipped entirely
      source: src,
    }];
    const r = await emitTsProject(modules, { outRoot: tmp });
    expect(r.filesEmitted).toBe(1);
    const tsPath = path.join(tmp, 'main', 'A.ts');
    await access(tsPath);
    await access(`${tsPath}.meta`);
    const meta = JSON.parse(await readFile(`${tsPath}.meta`, 'utf8'));
    expect(meta.uuid).toBe('a-uuid');
  });
});
