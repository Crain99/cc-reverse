const path = require('path');
const fs = require('fs');
const os = require('os');

describe('jscDecryptor', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scanJscFiles', () => {
    const { scanJscFiles } = require('../src/core/jscDecryptor');

    test('should find .jsc files recursively', () => {
      fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'a.jsc'), 'data');
      fs.writeFileSync(path.join(tmpDir, 'sub', 'b.jsc'), 'data');
      fs.writeFileSync(path.join(tmpDir, 'c.js'), 'data');

      const files = scanJscFiles(tmpDir);
      expect(files).toHaveLength(2);
      expect(files.every(f => f.endsWith('.jsc'))).toBe(true);
    });

    test('should return empty array when no jsc files exist', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'data');
      const files = scanJscFiles(tmpDir);
      expect(files).toHaveLength(0);
    });
  });

  describe('extractKeyFromProject', () => {
    const { extractKeyFromProject } = require('../src/core/jscDecryptor');

    test('should extract key from main.js with xxteaKey pattern', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.js'), `
        var xxteaKey = 'my-secret-key-123';
      `);
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('my-secret-key-123');
    });

    test('should extract key from main.js with encryptKey pattern', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.js'), `
        var encryptKey = 'abcdef12-3456-78';
      `);
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('abcdef12-3456-78');
    });

    test('should return null when no key found', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.js'), 'console.log("hello")');
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBeNull();
    });

    test('should return null when no main.js exists', () => {
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBeNull();
    });

    test('should extract key from 3.x application.js', () => {
      fs.writeFileSync(path.join(tmpDir, 'application.js'), `
        System.register(function () {
          var xxteaKey = "app-level-key-987654";
        });
      `);
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('app-level-key-987654');
    });

    test('should extract key from 3.x src/settings.json', () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'settings.json'),
        JSON.stringify({ assets: {}, xxteaKey: 'settings-json-key-555' })
      );
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('settings-json-key-555');
    });

    test('should extract key from hashed src/settings.<hash>.json', () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'settings.abc123.json'),
        JSON.stringify({ encryptKey: 'hashed-settings-key-444' })
      );
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('hashed-settings-key-444');
    });

    test('should extract key from setXXTEAKey call', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.js'),
        `cc.sys.localStorage; jsb.fileUtils.setXXTEAKey('call-style-key-321');`);
      const key = extractKeyFromProject(tmpDir);
      expect(key).toBe('call-style-key-321');
    });
  });

  describe('decryptJscBuffer', () => {
    const { decryptJscBuffer } = require('../src/core/jscDecryptor');
    const xxtea = require('xxtea-node');
    const pako = require('pako');

    const TEST_KEY = 'test-key-12345678';

    test('should decrypt uncompressed jsc data', () => {
      const original = Buffer.from('var a = 1;');
      const encrypted = xxtea.encrypt(original, xxtea.toBytes(TEST_KEY));
      const result = decryptJscBuffer(encrypted, TEST_KEY);
      expect(result.toString('utf-8')).toBe('var a = 1;');
    });

    test('should decrypt and decompress gzipped jsc data', () => {
      const original = Buffer.from('var b = 2;');
      const compressed = Buffer.from(pako.gzip(original));
      const encrypted = xxtea.encrypt(compressed, xxtea.toBytes(TEST_KEY));
      const result = decryptJscBuffer(encrypted, TEST_KEY);
      expect(result.toString('utf-8')).toBe('var b = 2;');
    });

    test('should return null for wrong key', () => {
      const original = Buffer.from('var c = 3;');
      const encrypted = xxtea.encrypt(original, xxtea.toBytes(TEST_KEY));
      const result = decryptJscBuffer(encrypted, 'wrong-key-12345678');
      expect(result).toBeNull();
    });

    test('should reject garbage output that is not valid JS text', () => {
      // Encrypt high-entropy binary, then decrypt with a different key so the
      // output is non-text noise; it must be rejected rather than reported ok.
      const binary = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff));
      const encrypted = xxtea.encrypt(binary, xxtea.toBytes(TEST_KEY));
      const result = decryptJscBuffer(encrypted, 'another-wrong-key-99');
      expect(result).toBeNull();
    });

    test('should accept correctly decrypted minified JS', () => {
      const original = Buffer.from('!function(){var a=1,b=2;return a+b}();');
      const encrypted = xxtea.encrypt(original, xxtea.toBytes(TEST_KEY));
      const result = decryptJscBuffer(encrypted, TEST_KEY);
      expect(result.toString('utf-8')).toBe('!function(){var a=1,b=2;return a+b}();');
    });
  });
});
