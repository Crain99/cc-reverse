/*
 * @Date: 2026-04-03
 * @Description: JSC 文件 XXTEA 解密模块
 */
const fsp = require('fs/promises');
const path = require('path');
const xxtea = require('xxtea-node');
const pako = require('pako');
const { logger } = require('../utils/logger');

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * 递归扫描目录中的所有 .jsc 文件 (async)
 * @param {string} dirPath 目录路径
 * @returns {Promise<string[]>} .jsc 文件路径列表
 */
async function scanJscFiles(dirPath) {
  return scanJscFilesAsync(dirPath);
}

/**
 * 异步扫描 .jsc 文件
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function scanJscFilesAsync(dirPath) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (path.extname(full) === '.jsc') out.push(full);
    }
  }
  await walk(dirPath);
  return out;
}

const stringPatterns = [
  /xxteaKey\s*[:=]\s*['"]([^'"]+)['"]/i,
  /encryptKey\s*[:=]\s*['"]([^'"]+)['"]/i,
  /XXTEA_KEY\s*[:=]\s*['"]([^'"]+)['"]/,
  /key\s*:\s*['"]([0-9a-f-]{16,})['"]/i,
];
const bytePattern = /(?:xxteaKey|encryptKey|XXTEA_KEY)\s*[:=]\s*\[([0-9xXa-fA-F,\s]+)\]/;

function decodeByteArray(raw) {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const bytes = [];
  for (const p of parts) {
    const n = /^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10);
    if (Number.isNaN(n)) return null;
    if (n < 0 || n > 0xff) return null;
    bytes.push(n);
  }
  if (bytes.length === 0) return null;
  return Buffer.from(bytes).toString('utf-8');
}

function matchKeyInString(content) {
  for (const pat of stringPatterns) {
    const m = content.match(pat);
    if (m) return m[1];
  }
  const bm = content.match(bytePattern);
  if (bm) {
    const decoded = decodeByteArray(bm[1]);
    if (decoded) return decoded;
  }
  return null;
}

async function readFileSafe(p) {
  try { return await fsp.readFile(p, 'utf-8'); } catch { return null; }
}

/**
 * 从项目文件中自动提取 XXTEA 密钥 (异步)
 * @param {string} sourcePath 源项目路径
 * @returns {Promise<string|null>} 密钥或 null
 */
async function extractKeyFromProject(sourcePath) {
  const stringSources = ['main.js', 'src/main.js', 'application.js'];
  for (const rel of stringSources) {
    const content = await readFileSafe(path.join(sourcePath, rel));
    if (!content) continue;
    const k = matchKeyInString(content);
    if (k) return k;
  }

  // cocos-js/*.js (one level)
  const cocosDir = path.join(sourcePath, 'cocos-js');
  try {
    const entries = await fsp.readdir(cocosDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.js')) {
        const content = await readFileSafe(path.join(cocosDir, e.name));
        if (!content) continue;
        const k = matchKeyInString(content);
        if (k) return k;
      }
    }
  } catch { /* no cocos-js dir */ }

  // settings.json
  const jsonSources = ['src/settings.json', 'settings.json'];
  for (const rel of jsonSources) {
    const content = await readFileSafe(path.join(sourcePath, rel));
    if (!content) continue;
    try {
      const obj = JSON.parse(content);
      const k = obj.encryptKey || obj.xxteaKey || obj.XXTEA_KEY
        || obj?.assets?.encryptKey || obj?.assets?.xxteaKey;
      if (typeof k === 'string' && k.length > 0) return k;
    } catch {
      const k = matchKeyInString(content);
      if (k) return k;
    }
  }

  return null;
}

/**
 * 报告项目加密状态
 * @param {string} sourcePath
 * @returns {Promise<object>}
 */
async function describeEncryptionState(sourcePath) {
  const jscs = await scanJscFilesAsync(sourcePath);
  if (jscs.length === 0) return { encrypted: false };
  const keyFound = await extractKeyFromProject(sourcePath);
  return { encrypted: true, jscCount: jscs.length, keyFound, keySources: keyFound ? ['auto'] : [] };
}

/**
 * 解密单个 JSC 文件数据
 */
function decryptJscBuffer(data, key) {
  const decrypted = xxtea.decrypt(data, xxtea.toBytes(key));
  if (!decrypted) return null;

  try {
    return Buffer.from(pako.inflate(decrypted));
  } catch (e) {
    return Buffer.from(decrypted);
  }
}

/**
 * 解密项目中的所有 JSC 文件
 */
async function decryptProject(sourcePath, outputDir, key) {
  const jscFiles = await scanJscFilesAsync(sourcePath);

  if (jscFiles.length === 0) {
    logger.info('未发现 .jsc 文件，跳过解密步骤');
    return { decrypted: 0, failed: 0 };
  }

  logger.info(`发现 ${jscFiles.length} 个 .jsc 文件，开始解密...`);

  let decrypted = 0;
  let failed = 0;

  for (const jscFile of jscFiles) {
    const relativePath = path.relative(sourcePath, jscFile);
    const outputFile = path.join(outputDir, relativePath.replace(/\.jsc$/, '.js'));

    await fsp.mkdir(path.dirname(outputFile), { recursive: true });

    const data = await fsp.readFile(jscFile);
    const result = decryptJscBuffer(data, key);

    if (result) {
      await fsp.writeFile(outputFile, result);
      decrypted++;
    } else {
      logger.warn(`解密失败: ${relativePath}`);
      failed++;
    }
  }

  logger.success(`解密完成: ${decrypted} 成功, ${failed} 失败`);
  return { decrypted, failed };
}

module.exports = {
  scanJscFiles,
  scanJscFilesAsync,
  extractKeyFromProject,
  describeEncryptionState,
  decryptJscBuffer,
  decryptProject,
};
