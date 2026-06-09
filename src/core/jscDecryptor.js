/*
 * @Date: 2026-04-03
 * @Description: JSC 文件 XXTEA 解密模块
 */
const fs = require('fs');
const path = require('path');
const xxtea = require('xxtea-node');
const pako = require('pako');
const { logger } = require('../utils/logger');

/**
 * 递归扫描目录中的所有 .jsc 文件
 * @param {string} dirPath 目录路径
 * @returns {string[]} .jsc 文件路径列表
 */
function scanJscFiles(dirPath) {
  const results = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (path.extname(fullPath) === '.jsc') {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

// 可能内联 XXTEA 密钥的项目文件，按命中优先级排列。
// 2.x 密钥通常在 main.js；3.x 在 application.js 或 src/settings.json。
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

// 同时适配 `var k = '...'`、`k: '...'`、JSON `"k":"..."` 以及 setXXTEAKey('...')。
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
 * 覆盖 2.x（main.js）与 3.x（application.js / src/settings.json）布局。
 * @param {string} sourcePath 源项目路径
 * @returns {string|null} 密钥或 null
 */
function extractKeyFromProject(sourcePath) {
  // src/settings.*.json 这类带 hash 的 3.x 配置也纳入扫描。
  const candidates = [...KEY_FILE_CANDIDATES];
  const srcDir = path.join(sourcePath, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      for (const f of fs.readdirSync(srcDir)) {
        if (/^settings\..+\.json$/.test(f)) candidates.push(path.join('src', f));
      }
    } catch (e) {
      // 目录不可读则忽略
    }
  }

  for (const candidate of candidates) {
    const filePath = path.join(sourcePath, candidate);
    if (!fs.existsSync(filePath)) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
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
 * 正确解密的 .jsc 是 JS 源码；错误密钥产出的是高熵二进制乱码。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeText(buf) {
  const n = Math.min(buf.length, 512);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i += 1) {
    const b = buf[i];
    // 制表/换行/回车 或 可打印 ASCII 视为文本字符。
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1;
  }
  return printable / n >= 0.85;
}

/**
 * 解密单个 JSC 文件数据。
 * 返回 null 表示解密失败（密钥错误或数据损坏），调用方据此计入失败而非误报成功。
 * @param {Buffer} data 文件数据
 * @param {string} key 解密密钥
 * @returns {Buffer|null} 解密后的数据或 null
 */
function decryptJscBuffer(data, key) {
  const decrypted = xxtea.decrypt(data, xxtea.toBytes(key));
  if (!decrypted || decrypted.length === 0) return null;

  const buf = Buffer.from(decrypted);

  // 按 magic 判断压缩格式：gzip(1f 8b) 或 zlib(78 ..)。
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const isZlib = buf.length >= 2 && buf[0] === 0x78
    && (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda);
  if (isGzip || isZlib) {
    try {
      return Buffer.from(pako.inflate(buf));
    } catch (e) {
      // magic 声称已压缩却解压失败 → 密钥错误或数据损坏。
      return null;
    }
  }

  // 未压缩：正确解密的 .jsc 应为 JS 源码文本，乱码则判为失败。
  if (looksLikeText(buf)) return buf;
  return null;
}

/**
 * 解密项目中的所有 JSC 文件
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

  for (const jscFile of jscFiles) {
    const relativePath = path.relative(sourcePath, jscFile);
    const outputFile = path.join(outputDir, relativePath.replace(/\.jsc$/, '.js'));

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });

    const data = fs.readFileSync(jscFile);
    const result = decryptJscBuffer(data, key);

    if (result) {
      fs.writeFileSync(outputFile, result);
      decrypted++;
    } else {
      logger.warn(`解密失败: ${relativePath}`);
      failed++;
    }
  }

  logger.success(`解密完成: ${decrypted} 成功, ${failed} 失败`);
  return { decrypted, failed };
}

module.exports = { scanJscFiles, extractKeyFromProject, decryptJscBuffer, decryptProject };
