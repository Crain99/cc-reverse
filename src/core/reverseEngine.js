/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 逆向工程核心引擎
 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { fileManager } = require('../utils/fileManager');
const { codeAnalyzer } = require('./codeAnalyzer');
const { resourceProcessor } = require('./resourceProcessor');
const { projectGenerator } = require('./projectGenerator');
const { logger } = require('../utils/logger');
const { loadConfig } = require('../config/configLoader');

// 将异步文件操作转为 Promise
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

/**
 * 逆向工程主函数
 * @param {Object} options 配置选项
 * @param {string} options.sourcePath 源项目路径
 * @param {string} options.outputPath 输出路径
 * @param {boolean} options.verbose 是否显示详细日志
 * @param {boolean} options.silent 是否静默模式
 * @returns {Promise<void>}
 */
async function reverseProject(options) {
  const { sourcePath, outputPath, verbose = false } = options;
  
  // 全局配置初始化
  global.config = loadConfig();
  global.verbose = verbose;
  
  // 设置资源路径
  const resPath = path.resolve(sourcePath, 'res');
  const settingsPath = path.resolve(sourcePath, 'src/settings.js');
  const projectPath = path.resolve(sourcePath, 'src/project.js');
  
  // 检查文件是否存在
  validatePaths(resPath, settingsPath, projectPath);
  
  // 创建临时目录和输出目录
  const tempPath = path.resolve(outputPath, 'temp');
  const astPath = path.resolve(tempPath, 'ast');
  await mkdir(tempPath, { recursive: true });
  await mkdir(astPath, { recursive: true });
  await mkdir(outputPath, { recursive: true });
  
  // 保存全局路径信息
  global.paths = {
    source: sourcePath,
    output: outputPath,
    res: resPath,
    temp: tempPath,
    ast: astPath
  };

  // 读取项目文件
  try {
    // 读取和解析设置
    const settings = await readFile(settingsPath);
    const project = await readFile(projectPath);
    const code = project.toString('utf-8');
    
    // 解析设置
    parseSettings(settings);
    
    // 开始处理
    logger.info('开始分析代码...');
    await codeAnalyzer.analyze(code);
    
    logger.info('开始处理资源...');
    await resourceProcessor.processResources();
    
    logger.info('生成项目文件...');
    await projectGenerator.generateProject();
    
    // 清理临时文件
    if (!verbose) {
      await fileManager.cleanDirectory(tempPath);
    }
    
    return true;
  } catch (err) {
    logger.error('处理项目文件时出错:', err);
    throw err;
  }
}

/**
 * 验证路径是否存在
 * @param {string} resPath 资源路径
 * @param {string} settingsPath 设置文件路径
 * @param {string} projectPath 项目文件路径
 */
function validatePaths(resPath, settingsPath, projectPath) {
  if (!fs.existsSync(resPath)) {
    throw new Error(`错误: 资源路径不存在: ${resPath}`);
  }
  
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`错误: settings.js 文件不存在: ${settingsPath}`);
  }
  
  if (!fs.existsSync(projectPath)) {
    throw new Error(`错误: project.js 文件不存在: ${projectPath}`);
  }
}

/**
 * 解析设置文件
 * @param {Buffer} settings 设置文件内容
 */
function parseSettings(settings) {
  // 解析 CCSettings
  let _ccsettings = "let window = {CCSettings: {}};" + settings.toString('utf-8').split(';')[0];
  global.settings = eval(_ccsettings);
  
  if (global.verbose) {
    logger.debug('已加载项目设置:', Object.keys(global.settings));
  }
}

module.exports = { reverseProject }; 