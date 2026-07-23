/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 文件管理工具
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { logger } = require('./logger');

/**
 * 文件管理工具
 */
const fileManager = {
  /**
   * 确保目录存在
   * @param {string} directory 目录路径
   * @returns {Promise<void>}
   */
  async ensureDirectoryExists(directory) {
    await fsp.mkdir(directory, { recursive: true });
  },

  /**
   * 读取目录内容
   * @param {string} directory 目录路径
   * @returns {Promise<string[]>} 文件名列表
   */
  async readDirectory(directory) {
    try {
      return await fsp.readdir(directory);
    } catch (err) {
      logger.error(`读取目录 ${directory} 时出错:`, err);
      throw err;
    }
  },

  /**
   * 读取文件内容
   * @param {string} filePath 文件路径
   * @param {string|null} encoding 编码方式，默认为 utf-8；传 null 返回 Buffer
   * @returns {Promise<string|Buffer>} 文件内容
   */
  async readFile(filePath, encoding = 'utf-8') {
    try {
      return await fsp.readFile(filePath, encoding === null ? undefined : encoding);
    } catch (err) {
      logger.error(`读取文件 ${filePath} 时出错:`, err);
      throw err;
    }
  },

  /**
   * 写入文件
   * @param {string} directory 目录名（相对 assets/）
   * @param {string} filename 文件名
   * @param {any} data 要写入的数据
   * @returns {Promise<void>}
   */
  async writeFile(directory, filename, data) {
    try {
      const outputDir = path.join(global.paths.output, 'assets', directory);
      await this.ensureDirectoryExists(outputDir);

      const outputPath = path.join(outputDir, filename);

      let content;
      if (typeof data === 'object' && data !== null) {
        content = safeJsonStringify(data, 2);
      } else {
        content = String(data);
      }

      await fsp.writeFile(outputPath, content);

      if (global.verbose) {
        logger.debug(`写入文件: ${outputPath}`);
      }
    } catch (err) {
      logger.error(`写入文件 ${directory}/${filename} 时出错:`, err);
      throw err;
    }
  },

  /**
   * 创建元数据文件
   * @param {Object<string, string>} fileMap 文件名 → uuid
   * @returns {Promise<void>}
   */
  async createMetaFile(fileMap) {
    try {
      const entries = fileMap instanceof Map
        ? [...fileMap.entries()]
        : Object.entries(fileMap || {});

      for (const [filename, uuid] of entries) {
        const meta = {
          ver: '1.0.8',
          uuid,
          isPlugin: false,
          loadPluginInWeb: true,
          loadPluginInNative: true,
          loadPluginInEditor: false,
          subMetas: {},
        };

        await this.writeFile('Scripts', `${filename}.meta`, meta);
      }
    } catch (err) {
      logger.error('创建元数据文件时出错:', err);
      throw err;
    }
  },

  /**
   * 复制文件
   * @param {string} source 源文件路径
   * @param {string} target 目标文件路径
   * @returns {Promise<void>}
   */
  async copyFile(source, target) {
    try {
      await this.ensureDirectoryExists(path.dirname(target));
      await fsp.copyFile(source, target);
    } catch (err) {
      logger.error(`复制文件 ${source} 到 ${target} 时出错:`, err);
      throw err;
    }
  },

  /**
   * 递归删除目录
   * @param {string} directory 要删除的目录
   * @returns {Promise<void>}
   */
  async cleanDirectory(directory) {
    try {
      if (!fs.existsSync(directory)) {
        return;
      }
      await fsp.rm(directory, { recursive: true, force: true });
      logger.debug(`删除目录: ${directory}`);
    } catch (err) {
      logger.error(`删除目录 ${directory} 时出错:`, err);
      throw err;
    }
  },
};

/**
 * JSON.stringify that breaks cycles instead of throwing.
 * Already-seen objects become {"__circular__": true}.
 * Prefer resourceProcessor.toIdReferencedArray for Cocos scene graphs.
 */
function safeJsonStringify(value, space = 2) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object') {
        if (seen.has(val)) {
          return { __circular__: true };
        }
        seen.add(val);
      }
      return val;
    },
    space,
  );
}

module.exports = { fileManager, safeJsonStringify };
