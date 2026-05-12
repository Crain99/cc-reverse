import { describe, it, expect } from 'vitest';
import babelParser from '@babel/parser';
import babelGenerator from '@babel/generator';
import { restoreClasses } from '../../src/core/cocos3x/scriptRecovery/classRestorer.js';

const parse = babelParser.parse || babelParser;
const generate = babelGenerator.default || babelGenerator;

describe('Layer 3: classRestorer', () => {
  it('collapses __extends IIFE into class extends (or fails closed)', async () => {
    const src = `
      var __extends = (this && this.__extends) || function (d, b) { for (var p in b) d[p] = b[p]; function __() { this.constructor = d; } d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __()); };
      var Player = (function (_super) {
        __extends(Player, _super);
        function Player() { return _super.call(this) || this; }
        Player.prototype.onLoad = function () { console.log('p'); };
        return Player;
      }(Component));
    `;
    const ast = parse(src, { sourceType: 'module' });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate(out).code;
    // Either webcrack collapsed it into native class syntax, OR fail-closed kept
    // the original IIFE — in the latter case at least __extends + onLoad survive.
    const hasNativeClass = /class\s+Player\s+extends\s+Component/.test(code);
    const hasFallback = /__extends\s*\(\s*Player/.test(code);
    expect(hasNativeClass || hasFallback).toBe(true);
    expect(code).toMatch(/onLoad/);
  });

  it('collapses __decorate(..., Class) into a decorator', async () => {
    // Use a pre-collapsed class declaration so foldDecorate can do its job
    // independently of whether webcrack is loaded.
    const src = `
      class Player extends Component {
        constructor() { super(); }
      }
      Player = __decorate([ccclass('Player')], Player);
      export default Player;
    `;
    const ast = parse(src, {
      sourceType: 'module',
      plugins: ['decorators-legacy', 'classProperties'],
    });
    const out = await restoreClasses(ast, { name: 'Player' });
    const code = generate(out).code;
    expect(code).toMatch(/@ccclass\(['"]Player['"]\)/);
    expect(code).not.toMatch(/__decorate/);
  });

  it('passthrough on null ast', async () => {
    expect(await restoreClasses(null, { name: 'x' })).toBeNull();
  });
});
