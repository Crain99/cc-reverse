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
  });
});
