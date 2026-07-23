const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractModulesOnly, recoverScripts2x } = require('../../src/core/script');
const { transformModule, idToOutPath, extractUuidFromSource } = require('../../src/core/script/transform');
const { codeAnalyzer } = require('../../src/core/codeAnalyzer');

const fixture = fs.readFileSync(
  path.join(__dirname, '../../__fixtures__/project-browserify.js'),
  'utf-8',
);

describe('script pipeline', () => {
  test('extractModulesOnly uses browserify extractor', () => {
    const { format, records, extractor } = extractModulesOnly(fixture);
    expect(format).toBe('browserify');
    expect(extractor).toBe('browserify');
    expect(records.length).toBe(3);
    expect(records[0].outPath).toMatch(/\.ts$/);
  });

  test('idToOutPath strips assets/ and forces .ts', () => {
    expect(idToOutPath('assets/scripts/Player.js')).toBe('scripts/Player.ts');
    expect(idToOutPath('db://assets/scripts/Foo.ts')).toBe('scripts/Foo.ts');
    expect(idToOutPath('42')).toBe('42.ts');
  });

  test('extractUuidFromSource reads cc._RF.push', () => {
    const src = 'cc._RF.push(module, "fcmR3XADNLgJ1ByKhqcC5Z", "Player");';
    expect(extractUuidFromSource(src)).toBe('fcmR3XADNLgJ1ByKhqcC5Z');
  });

  test('transformModule rewrites require via deps map', () => {
    const player = extractModulesOnly(fixture).records.find((r) => r.id.endsWith('Player.js'));
    const math = extractModulesOnly(fixture).records.find((r) => r.id.endsWith('MathUtil.js'));
    const byId = new Map([
      [player.id, player],
      [math.id, math],
    ]);
    // ensure outPaths
    player.outPath = idToOutPath(player.id);
    math.outPath = idToOutPath(math.id);

    const result = transformModule(player, { byId });
    expect(result.outPath).toBe('scripts/Player.ts');
    expect(result.uuid).toBe('fcmR3XADNLgJ1ByKhqcC5Z');
    // relative require from scripts/Player.ts → scripts/util/MathUtil.ts
    expect(result.code).toMatch(/require\(["']\.\/util\/MathUtil["']\)/);
    expect(result.code).toContain('function Player');
  });

  test('transformModule rewrites minified factory require param', () => {
    const record = {
      id: 'AddScore',
      source: `
        cc._RF.push(t, "68076EFnW1JeZUzdnbOOKNr", "AddScore");
        var a = e("../Common/Utils");
        module.exports = a;
      `,
      deps: { '../Common/Utils': 'Utils' },
      requireName: 'e',
      moduleName: 't',
      exportsName: 'n',
      outPath: 'AddScore.ts',
    };
    const utils = {
      id: 'Utils',
      outPath: 'Utils.ts',
    };
    const byId = new Map([
      ['AddScore', record],
      ['Utils', utils],
    ]);
    const result = transformModule(record, { byId });
    expect(result.code).toMatch(/require\(["']\.\/Utils["']\)/);
    expect(result.code).not.toMatch(/\be\(["']\.\.\/Common\/Utils["']\)/);
    expect(result.uuid).toBe('68076EFnW1JeZUzdnbOOKNr');
  });

  test('recoverScripts2x writes scripts and meta', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-script-'));
    try {
      const summary = await recoverScripts2x(fixture, {
        outputPath: tmp,
        verbose: false,
      });

      expect(summary.modules).toBe(3);
      expect(summary.written).toBe(3);
      expect(summary.failed).toBe(0);
      expect(summary.extractor).toBe('browserify');

      const playerPath = path.join(tmp, 'assets/Scripts/scripts/Player.ts');
      expect(fs.existsSync(playerPath)).toBe(true);
      const body = fs.readFileSync(playerPath, 'utf-8');
      expect(body).toContain('function Player');
      expect(fs.existsSync(playerPath + '.meta')).toBe(true);

      const meta = JSON.parse(fs.readFileSync(playerPath + '.meta', 'utf-8'));
      expect(meta.uuid).toBeTruthy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('codeAnalyzer.analyze delegates to pipeline', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analyzer-'));
    try {
      global.paths = { output: tmp };
      const result = await codeAnalyzer.analyze(fixture);
      expect(result.written).toBe(3);
      expect(fs.existsSync(path.join(tmp, 'assets/Scripts/scripts/Game.ts'))).toBe(true);
    } finally {
      delete global.paths;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AST fallback recovers modules when forced', () => {
    const { records, extractor } = extractModulesOnly(fixture, {
      forceFormat: 'unknown',
      // browserify still runs first for unknown; force no browserify by using only AST path
    });
    // unknown tries browserify first which succeeds on this fixture
    expect(records.length).toBeGreaterThanOrEqual(3);

    // Pure AST path
    const { extractWithAst } = require('../../src/core/script/extractors/fallbackAst');
    const astRecords = extractWithAst(fixture);
    expect(astRecords.length).toBe(3);
    expect(astRecords.map((r) => r.id).sort()).toEqual([
      'assets/scripts/Game.js',
      'assets/scripts/Player.js',
      'assets/scripts/util/MathUtil.js',
    ]);
    expect(extractor === 'browserify' || extractor === 'fallback-ast').toBe(true);
  });
});
