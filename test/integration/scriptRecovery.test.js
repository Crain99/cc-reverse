import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';

import { recoverScriptsLayered } from '../../src/core/cocos3x/engine3x.js';

describe('Layered script recovery (integration)', () => {
  it('emits one .js per System.register module under assets/scripts/<chunkBase>/', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc3x-scripts-'));
    const srcChunks = path.join(tmp, 'src', 'chunks');
    const out = path.join(tmp, 'out');
    await mkdir(srcChunks, { recursive: true });
    const chunk = `
      System.register("chunks:///_virtual/A.ts", ["cc"], function (_export, _context) {
        var Component, A;
        return { setters: [function (_cc) { Component = _cc.Component; }],
                 execute: function () { A = class A extends Component {}; _export("default", A); } };
      });
      System.register("chunks:///_virtual/B.ts", [], function (_export, _context) {
        var B;
        return { setters: [], execute: function () { B = class B {}; _export("default", B); } };
      });
    `;
    await writeFile(path.join(srcChunks, 'index.js'), chunk);

    const result = await recoverScriptsLayered(tmp, out, false);
    expect(result.modulesEmitted).toBe(2);
    await access(path.join(out, 'assets', 'scripts', 'index', 'A.js'));
    await access(path.join(out, 'assets', 'scripts', 'index', 'B.js'));
    const aSrc = await readFile(path.join(out, 'assets', 'scripts', 'index', 'A.js'), 'utf8');
    expect(aSrc).toMatch(/import\s*\{\s*Component\s*\}\s*from\s*['"]cc['"]/);
  });

  it('emits TS project under assets/scripts/<bundle>/ when Layer 6 enabled', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc3x-ts-'));
    const srcChunks = path.join(tmp, 'src', 'chunks');
    const out = path.join(tmp, 'out');
    await mkdir(srcChunks, { recursive: true });
    const chunk = `
      System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
        var _decorator, Component, ccclass, Player;
        return {
          setters: [function (_cc) { _decorator = _cc._decorator; Component = _cc.Component; }],
          execute: function () {
            ccclass = _decorator.ccclass;
            cclegacy._RF.push({}, "abcd-uuid", "Player", undefined);
            Player = (function (_super) {
              __extends(Player, _super);
              function Player() { return _super.call(this) || this; }
              return Player;
            }(Component));
            Player = __decorate([ccclass('Player')], Player);
            _export("default", Player);
            cclegacy._RF.pop();
          }
        };
      });
    `;
    await writeFile(path.join(srcChunks, 'index.js'), chunk);

    const result = await recoverScriptsLayered(tmp, out, false, { scriptLayers: 6 });
    expect(result.modulesEmitted).toBeGreaterThanOrEqual(1);
    expect(result.tsFilesEmitted).toBeGreaterThanOrEqual(1);
    await access(path.join(out, 'assets', 'scripts', 'tsconfig.json'));
    await access(path.join(out, 'assets', 'scripts', 'RECOVERY_INDEX.json'));
    // Legacy .js coexists.
    await access(path.join(out, 'assets', 'scripts', 'index', 'Player.js'));
  });
});
