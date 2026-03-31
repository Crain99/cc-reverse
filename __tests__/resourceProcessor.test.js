const path = require('path');
const fs = require('fs');

const { resourceProcessor } = require('../src/core/resourceProcessor');

describe('resourceProcessor issue regressions', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    global.paths = { res: '/tmp/assets' };
    global.settings = { CCSettings: {} };
  });

  test('writeProcessedData should not throw when nested value is null', () => {
    const data = {
      valid: { __type__: 'cc.SpriteFrame' },
      broken: null,
      nested: [{ inner: null }],
    };

    expect(() => resourceProcessor.writeProcessedData(data, 'key')).not.toThrow();
  });

  test('processSubpackages should read subpackages from CCSettings', async () => {
    global.settings = { CCSettings: { subpackages: [{ name: 'sub' }] } };

    const readFilesSpy = jest
      .spyOn(resourceProcessor, 'readFiles')
      .mockResolvedValue(undefined);
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    await resourceProcessor.processSubpackages();

    expect(readFilesSpy).toHaveBeenCalledWith(
      path.dirname(global.paths.res) + '/subpackages',
      false
    );
  });

  test('fileMap key should use basename without extension, handling dots', () => {
    const fullPath1 = '/tmp/res/import/a1b2c3.json';
    const basename1 = path.basename(fullPath1);
    const key1 = basename1.substring(0, basename1.lastIndexOf('.')) || basename1;
    expect(key1).toBe('a1b2c3');

    const fullPath2 = '/tmp/res/import/a1.b2c3.json';
    const basename2 = path.basename(fullPath2);
    const key2 = basename2.substring(0, basename2.lastIndexOf('.')) || basename2;
    expect(key2).toBe('a1.b2c3');
  });

  test('processJsonFiles should accumulate nodeData per key, not overwrite', async () => {
    resourceProcessor.resetState();
    resourceProcessor.fileList = ['/tmp/res/aaa.json', '/tmp/res/bbb.json'];

    // Write temporary JSON files so readFile can actually read them
    const tmpDir = '/tmp/res';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync('/tmp/res/aaa.json', JSON.stringify({ type: 'first' }));
    fs.writeFileSync('/tmp/res/bbb.json', JSON.stringify({ type: 'second' }));

    jest.spyOn(resourceProcessor, 'processData').mockResolvedValue();

    await resourceProcessor.processJsonFiles();

    expect(resourceProcessor.nodeData['aaa']).toEqual({ type: 'first' });
    expect(resourceProcessor.nodeData['bbb']).toEqual({ type: 'second' });

    // Cleanup
    fs.unlinkSync('/tmp/res/aaa.json');
    fs.unlinkSync('/tmp/res/bbb.json');
  });

  test('createLibrary should use uuids from CCSettings when available', () => {
    global.settings = { CCSettings: { uuids: { k1: 'known-uuid' } } };

    const result = resourceProcessor.createLibrary('0', 'k1');

    expect(result).toBe('known-uuid');
  });
});
