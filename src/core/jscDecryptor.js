/*
 * @Date: 2026-04-03
 * @Description: JSC 文件 XXTEA 解密模块
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const xxtea = require('xxtea-node');
const pako = require('pako');
const { logger } = require('../utils/logger');
const { forEachPool, getMaxParallel } = require('../utils/asyncPool');

/**
 * 递归扫描目录中的所有 .jsc 文件
 * @param {string} dirPath 目录路径
 * @returns {string[]} .jsc 文件路径列表
 */
function scanJscFiles(dirPath) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && path.extname(entry.name) === '.jsc') {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

// 可能内联 XXTEA 密钥的项目文件，按命中优先级排列。
const KEY_FILE_CANDIDATES = [
  'main.js',
  'src/main.js',
  'application.js',
  'src/application.js',
  'src/settings.json',
  'src/project.js',
  'project.js',
  'index.js',
  'game.js',
];

const KEY_PATTERNS = [
  /setXXTEAKey\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /xxteaKey['"]?\s*[:=]\s*['"]([^'"]+)['"]/i,
  /encrypt(?:ion)?Key['"]?\s*[:=]\s*['"]([^'"]+)['"]/i,
  /XXTEA_KEY['"]?\s*[:=]\s*['"]([^'"]+)['"]/i,
  /key\s*:\s*['"]([0-9a-f-]{16,})['"]/i,
  /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{2})['"]/i,
];

/**
 * 从项目文件中自动提取 XXTEA 密钥。
 * @param {string} sourcePath 源项目路径
 * @returns {string|null}
 */
function extractKeyFromProject(sourcePath) {
  const candidates = [...KEY_FILE_CANDIDATES];
  const srcDir = path.join(sourcePath, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      for (const f of fs.readdirSync(srcDir)) {
        if (/^settings\..+\.json$/.test(f)) candidates.push(path.join('src', f));
      }
    } catch {
      // 目录不可读则忽略
    }
  }

  for (const candidate of candidates) {
    const filePath = path.join(sourcePath, candidate);
    if (!fs.existsSync(filePath)) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const pattern of KEY_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * 启发式判断缓冲区是否为文本（JavaScript 源码）。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeText(buf) {
  const n = Math.min(buf.length, 512);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i += 1) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1;
  }
  return printable / n >= 0.85;
}

/**
 * 解密单个 JSC 文件数据。
 * @param {Buffer} data 文件数据
 * @param {string} key 解密密钥
 * @returns {Buffer|null}
 */
function decryptJscBuffer(data, key) {
  const decrypted = xxtea.decrypt(data, xxtea.toBytes(key));
  if (!decrypted || decrypted.length === 0) return null;

  const buf = Buffer.from(decrypted);

  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const isZlib = buf.length >= 2 && buf[0] === 0x78
    && (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda);
  if (isGzip || isZlib) {
    try {
      return Buffer.from(pako.inflate(buf));
    } catch {
      return null;
    }
  }

  if (looksLikeText(buf)) return buf;
  return null;
}

/**
 * 解密项目中的所有 JSC 文件（限流并发）
 * @param {string} sourcePath 源项目路径
 * @param {string} outputDir 输出目录
 * @param {string} key 解密密钥
 * @returns {Promise<{decrypted: number, failed: number}>}
 */
async function decryptProject(sourcePath, outputDir, key) {
  const jscFiles = scanJscFiles(sourcePath);

  if (jscFiles.length === 0) {
    logger.info('未发现 .jsc 文件，跳过解密步骤');
    return { decrypted: 0, failed: 0 };
  }

  logger.info(`发现 ${jscFiles.length} 个 .jsc 文件，开始解密...`);

  let decrypted = 0;
  let failed = 0;
  const concurrency = getMaxParallel();

  await forEachPool(jscFiles, concurrency, async (jscFile) => {
    const relativePath = path.relative(sourcePath, jscFile);
    const outputFile = path.join(outputDir, relativePath.replace(/\.jsc$/, '.js'));

    await fsp.mkdir(path.dirname(outputFile), { recursive: true });

    const data = await fsp.readFile(jscFile);
    const result = decryptJscBuffer(data, key);

    if (result) {
      await fsp.writeFile(outputFile, result);
      decrypted += 1;
    } else {
      logger.warn(`解密失败: ${relativePath}`);
      failed += 1;
    }
  });

  logger.success(`解密完成: ${decrypted} 成功, ${failed} 失败`);
  return { decrypted, failed };
}

module.exports = { scanJscFiles, extractKeyFromProject, decryptJscBuffer, decryptProject };
