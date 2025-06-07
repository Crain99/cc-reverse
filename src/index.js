/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 逆向工程工具入口文件
 */
const path = require('path');
const { program } = require('commander');
const { version } = require('../package.json');
const { reverseProject } = require('./core/reverseEngine');
const { logger } = require('./utils/logger');

// 配置命令行参数
program
  .version(version)
  .description('Cocos Creator 逆向工程工具')
  .option('-p, --path <path>', '源项目路径')
  .option('-o, --output <path>', '输出路径', './output')
  .option('-v, --verbose', '显示详细日志')
  .option('-s, --silent', '静默模式，不显示进度')
  .parse(process.argv);

const options = program.opts();

// 通过命令行参数或环境变量获取路径
const sourcePath = options.path || process.env.CC_SOURCE_PATH;
if (!sourcePath) {
  logger.error('错误: 未指定源路径，请通过命令行参数 --path 或环境变量 CC_SOURCE_PATH 指定');
  logger.info('用法: node index.js --path <源项目路径>');
  process.exit(1);
}

// 开始逆向工程过程
(async () => {
  try {
    logger.info('开始处理项目...');
    await reverseProject({
      sourcePath: path.resolve(sourcePath),
      outputPath: path.resolve(options.output),
      verbose: options.verbose,
      silent: options.silent
    });
    logger.success('逆向工程完成！');
  } catch (err) {
    logger.error('处理过程中出错:', err);
    process.exit(1);
  }
})(); 