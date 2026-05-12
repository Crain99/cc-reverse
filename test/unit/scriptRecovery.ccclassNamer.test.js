import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import babelGen from '@babel/generator';
import { applyCcclassNames } from '../../src/core/cocos3x/scriptRecovery/ccclassNamer.js';

const generate = babelGen.default || babelGen;

function makeModule(src, opts = {}) {
  return {
    name: opts.name || 'Player',
    ast: parse(src, { sourceType: 'module', plugins: ['decorators-legacy', 'classProperties'] }),
    deps: opts.deps || [],
    setterBindings: [],
    source: src,
  };
}

describe('Layer 4: ccclassNamer', () => {
  it('extracts uuid+name from cclegacy._RF.push and removes the call', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "abcd1234-uuid", "Player", undefined);
      @ccclass('Player')
      class Player extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src);
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Player');
    expect(out[0].uuid).toBe('abcd1234-uuid');
    expect(out[0].uuidMap).toEqual({ 'abcd1234-uuid': { className: 'Player', moduleName: 'Player' } });
    const code = generate(out[0].ast).code;
    expect(code).not.toMatch(/_RF\.(push|pop)/);
    expect(code).toMatch(/class\s+Player/);
  });

  it('renames a minified class id to the ccclassName from decorator', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      cclegacy._RF.push({}, "ffff-uuid", "Enemy", undefined);
      @ccclass('Enemy')
      class t extends Component {}
      cclegacy._RF.pop();
    `;
    const mod = makeModule(src, { name: 't' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Enemy');
    const code = generate(out[0].ast).code;
    expect(code).toMatch(/class\s+Enemy\s+extends/);
  });

  it('falls back to ccclass decorator when _RF.push is absent', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass('Foo')
      class Foo extends Component {}
    `;
    const mod = makeModule(src, { name: 'Foo' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Foo');
    expect(out[0].uuid).toBeNull();
  });

  it('handles decorator argument as object { name }', async () => {
    const src = `
      import { _decorator, Component } from 'cc';
      const { ccclass } = _decorator;
      @ccclass({ name: 'Bar' })
      class Bar extends Component {}
    `;
    const mod = makeModule(src, { name: 'Bar' });
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBe('Bar');
  });

  it('passthrough: module without class is unchanged and has null fields', async () => {
    const mod = { name: 'plain', ast: parse('var x = 1;', { sourceType: 'module' }), deps: [], setterBindings: [], source: 'var x = 1;' };
    const out = await applyCcclassNames([mod]);
    expect(out[0].ccclassName).toBeNull();
    expect(out[0].uuid).toBeNull();
  });
});
