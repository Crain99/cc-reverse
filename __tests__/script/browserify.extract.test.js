const fs = require('fs');
const path = require('path');
const {
  extractBrowserifyModules,
  findModulesObject,
  parseDepsObject,
  readBalanced,
} = require('../../src/core/script/extractors/browserify');

const fixture = fs.readFileSync(
  path.join(__dirname, '../../__fixtures__/project-browserify.js'),
  'utf-8',
);

describe('browserify extractor', () => {
  test('findModulesObject locates the modules map', () => {
    const obj = findModulesObject(fixture);
    expect(obj).not.toBeNull();
    expect(obj.text.startsWith('{')).toBe(true);
    expect(obj.text).toContain('assets/scripts/Player.js');
  });

  test('extracts all three modules with sources and deps', () => {
    const records = extractBrowserifyModules(fixture);
    expect(records).toHaveLength(3);

    const ids = records.map((r) => r.id).sort();
    expect(ids).toEqual([
      'assets/scripts/Game.js',
      'assets/scripts/Player.js',
      'assets/scripts/util/MathUtil.js',
    ]);

    const player = records.find((r) => r.id.endsWith('Player.js'));
    expect(player.source).toContain('function Player');
    expect(player.source).toContain('cc._RF.push');
    expect(player.deps['./util/MathUtil']).toBe('assets/scripts/util/MathUtil.js');
    expect(player.format).toBe('browserify');

    const game = records.find((r) => r.id.endsWith('Game.js'));
    expect(game.deps['./Player']).toBe('assets/scripts/Player.js');
    expect(game.source).toContain('new Player');
  });

  test('readBalanced handles nested braces and strings', () => {
    const s = '{ a: { b: "}" }, c: 1 }';
    const r = readBalanced(s, 0, '{', '}');
    expect(r).not.toBeNull();
    expect(r.text).toBe(s);
    expect(r.end).toBe(s.length - 1);
  });

  test('parseDepsObject reads string keys and values', () => {
    const deps = parseDepsObject('{ "./Player": "assets/scripts/Player.js", "x": "y" }');
    expect(deps['./Player']).toBe('assets/scripts/Player.js');
    expect(deps.x).toBe('y');
  });

  test('returns empty array for non-bundle code', () => {
    expect(extractBrowserifyModules('var a = 1;')).toEqual([]);
  });
});
