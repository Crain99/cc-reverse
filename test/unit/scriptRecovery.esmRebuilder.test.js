import { describe, it, expect } from 'vitest';
import babelGenerator from '@babel/generator';
const generate = babelGenerator.default || babelGenerator;
import { rebuildEsm } from '../../src/core/cocos3x/scriptRecovery/esmRebuilder.js';
import { splitChunks } from '../../src/core/cocos3x/scriptRecovery/chunkSplitter.js';

const fixture = `
System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
  "use strict";
  var Component, Player;
  _export("default", void 0);
  return {
    setters: [function (_cc) { Component = _cc.Component; }],
    execute: function () {
      Player = class Player extends Component { onLoad() {} };
      _export("default", Player);
      _export("HELPER", 42);
    }
  };
});
`;

describe('Layer 2: esmRebuilder', () => {
  it('emits import statements from setterBindings', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/import\s*\{\s*Component\s*\}\s*from\s*['"]cc['"]/);
  });

  it('rewrites _export("name", value) → export named binding (or default)', async () => {
    const [mod] = await splitChunks({ name: 'a.js', source: fixture });
    const ast = await rebuildEsm(mod.ast, mod);
    const code = generate(ast).code;
    expect(code).toMatch(/export\s+default\s+Player/);
    expect(code).toMatch(/export\s+(?:const|let|var)?\s*HELPER/);
  });

  it('passthrough on null ast', async () => {
    const result = await rebuildEsm(null, { name: 'x', deps: [], setterBindings: [] });
    expect(result).toBeNull();
  });
});
