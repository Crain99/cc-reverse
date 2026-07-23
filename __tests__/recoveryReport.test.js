const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRecoveryReport } = require('../src/utils/recoveryReport');

describe('writeRecoveryReport', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-report-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writes 2.x style summary', async () => {
    const reportPath = await writeRecoveryReport(tmp, {
      engine: '2.3.x',
      scripts: {
        total: 3,
        format: 'browserify',
        extractor: 'browserify',
        modules: 3,
        written: 3,
        failed: 0,
      },
      assets: {
        scenes: 1,
        prefabs: 2,
        sprites: 10,
        audio: 4,
        animations: 1,
        copies: 20,
        labelAtlas: 2,
      },
      options: {
        scriptFormat: 'auto',
        noAstFallback: false,
      },
      warnings: ['example warning'],
    }, '/src/game');

    expect(reportPath).toBe(path.join(tmp, 'RECOVERY_REPORT.md'));
    const text = fs.readFileSync(reportPath, 'utf-8');
    expect(text).toContain('Engine: 2.3.x');
    expect(text).toContain('browserify');
    expect(text).toContain('Scenes: 1');
    expect(text).toContain('example warning');
  });

  test('writes 3.x bundle table', async () => {
    const reportPath = await writeRecoveryReport(tmp, {
      engine: '3.x',
      flavor: '3.x',
      scripts: { total: 6 },
      bundles: [
        { name: 'main', encrypted: false, uuidCount: 10, pathCount: 3, recovered: 8, missing: 0 },
      ],
    }, '/src/3x');

    const text = fs.readFileSync(reportPath, 'utf-8');
    expect(text).toContain('| main |');
    expect(text).toContain('Files recovered: 6');
  });
});
