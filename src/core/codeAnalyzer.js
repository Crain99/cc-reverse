/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 2.x 脚本分析入口（委托 script/ 流水线）
 *
 * 历史实现把整份 project.js 送进 Babel 全量 AST。
 * 现已拆为：
 *   detect → extract (browserify 切片 | AST 兜底) → transform → emit
 * 见 src/core/script/。
 */
const { recoverScripts2x, extractModulesOnly } = require('./script');
const { logger } = require('../utils/logger');

/**
 * 代码分析器模块（保持对外 API 兼容）
 */
const codeAnalyzer = {
  /**
   * 分析编译源代码并写出 scripts
   * @param {string} code 要分析的源代码（project.js 等）
   * @param {object} [options]
   * @returns {Promise<object>} recoverScripts2x 的摘要
   */
  async analyze(code, options = {}) {
    try {
      const result = await recoverScripts2x(code, {
        outputPath: options.outputPath || (global.paths && global.paths.output),
        verbose: options.verbose || global.verbose,
        forceFormat: options.forceFormat || options.scriptFormat,
        noAstFallback: options.noAstFallback,
      });
      logger.info('代码分析完成');
      return result;
    } catch (err) {
      logger.error('分析编译代码时出错:', err);
      throw err;
    }
  },

  /**
   * 仅提取模块（不写盘），供测试与工具使用
   * @param {string} code
   * @param {object} [options]
   */
  extractModules(code, options = {}) {
    return extractModulesOnly(code, options);
  },
};

module.exports = { codeAnalyzer };
