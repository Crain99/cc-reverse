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
  .option('-k, --key <key>', 'JSC 文件的 XXTEA 加密密钥')
  .option('--version-hint <version>', '提示Cocos Creator版本 (2.3.x|2.4.x|3.x)', '')
  .option('--bundle <name>', '仅处理指定 bundle (3.x, 可重复)', collectList, [])
  .option('--assets-only', '跳过脚本阶段')
  .option('--scripts-only', '跳过资源阶段')
  .option('--script-layers <n>', '脚本恢复层数 (1-6, 默认 6)', '6');

program
  .command('humanify <outDir>')
  .description('[opt-in, Layer 7] rename minified identifiers via the user-installed humanify CLI')
  .option('--provider <name>', 'local | openai', 'local')
  .option('--base-url <url>', 'OpenAI-compatible base URL', process.env.OPENAI_BASE_URL)
  .option('--api-key <key>', 'OpenAI-compatible API key', process.env.OPENAI_API_KEY)
  .option('--model <name>', 'model name (openai)')
  .action(async (outDir, opts) => {
    const { runHumanify } = require('./core/cocos3x/scriptRecovery/humanify');
    const r = await runHumanify(path.resolve(outDir), {
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    if (!r.ok) {
      console.error('[humanify]', r.reason);
      process.exit(1);
    }
    console.log('[humanify] output ->', r.outDir);
    process.exit(0);
  });

program.parse(process.argv);

function collectList(value, previous) {
  return previous.concat([value]);
}

const options = program.opts();

// If a subcommand was invoked, skip the default reverse flow.
if (program.args[0] === 'humanify') {
  return;
}

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
      silent: options.silent,
      versionHint: options.versionHint,
      key: options.key,
      bundle: options.bundle,
      assetsOnly: options.assetsOnly,
      scriptsOnly: options.scriptsOnly,
      scriptLayers: options.scriptLayers != null ? parseInt(options.scriptLayers, 10) : 6,
    });
    logger.success('逆向工程完成！');
  } catch (err) {
    logger.error('处理过程中出错:', err);
    process.exit(1);
  }
})(); 