/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 逆向工程工具入口文件
 */
const path = require('path');
const { program } = require('commander');
const { version } = require('../package.json');
const { reverseProject } = require('./core/reverseEngine');
const { logger, LogLevel } = require('./utils/logger');

// 配置命令行参数
program
  .version(version)
  .description('Cocos Creator 逆向工程工具')
  .option('-p, --path <path>', '源项目路径')
  .option('-o, --output <path>', '输出路径', './output')
  .option('-v, --verbose', '显示详细日志')
  .option('-s, --silent', '静默模式，不显示进度')
  .option('-k, --key <key>', 'JSC 文件的 XXTEA 加密密钥')
  .option('--version-hint <version>', '提示Cocos Creator版本 (2.3.x|2.4.x|3.x)', '')
  .option('--bundle <name>', '仅处理指定 bundle (3.x, 可重复)', collectList, [])
  .option('--assets-only', '跳过脚本阶段')
  .option('--scripts-only', '跳过资源阶段')
  .option('--script-format <format>', '强制脚本包格式 (browserify|webpack|cocos-rf|unknown)')
  .option('--no-ast-fallback', '脚本切片失败时不回退全量 AST')
  .parse(process.argv);

function collectList(value, previous) {
  return previous.concat([value]);
}

const options = program.opts();

if (options.verbose) {
  logger.setLevel(LogLevel.DEBUG);
}
if (options.silent) {
  logger.setSilent(true);
}

// 通过命令行参数或环境变量获取路径
const sourcePath = options.path || process.env.CC_SOURCE_PATH;
if (!sourcePath) {
  logger.error('错误: 未指定源路径，请通过命令行参数 --path 或环境变量 CC_SOURCE_PATH 指定');
  logger.info('用法: node index.js --path <源项目路径>');
  process.exit(1);
}

const allowedFormats = new Set(['browserify', 'webpack', 'cocos-rf', 'unknown']);
if (options.scriptFormat && !allowedFormats.has(options.scriptFormat)) {
  logger.error(`错误: --script-format 无效: ${options.scriptFormat}`);
  logger.info(`可选: ${[...allowedFormats].join(', ')}`);
  process.exit(1);
}

// 开始逆向工程过程
(async () => {
  try {
    logger.info('开始处理项目...');
    const summary = await reverseProject({
      sourcePath: path.resolve(sourcePath),
      outputPath: path.resolve(options.output),
      verbose: options.verbose,
      silent: options.silent,
      versionHint: options.versionHint,
      key: options.key,
      bundle: options.bundle,
      assetsOnly: options.assetsOnly,
      scriptsOnly: options.scriptsOnly,
      // commander --no-ast-fallback → astFallback === false
      noAstFallback: options.astFallback === false,
      scriptFormat: options.scriptFormat || '',
    });
    logger.success('逆向工程完成！');
    if (summary && summary.reportPath) {
      logger.info(`恢复报告: ${summary.reportPath}`);
    }
  } catch (err) {
    logger.error('处理过程中出错:', err);
    process.exit(1);
  }
})();
