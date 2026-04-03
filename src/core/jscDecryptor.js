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

/**
 * 从项目文件中自动提取 XXTEA 密钥
 * @param {string} sourcePath 源项目路径
 * @returns {string|null} 密钥或 null
 */
function extractKeyFromProject(sourcePath) {
  const candidates = ['main.js', 'src/main.js'];

  for (const candidate of candidates) {
    const filePath = path.join(sourcePath, candidate);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');

    const patterns = [
      /xxteaKey\s*=\s*['"]([^'"]+)['"]/,
      /encryptKey\s*=\s*['"]([^'"]+)['"]/,
      /XXTEA_KEY\s*=\s*['"]([^'"]+)['"]/,
      /key\s*:\s*['"]([0-9a-f-]{16,})['"]/i,
      /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{2})['"]/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * 解密单个 JSC 文件数据
 * @param {Buffer} data 文件数据
 * @param {string} key 解密密钥
 * @returns {Buffer|null} 解密后的数据或 null
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
