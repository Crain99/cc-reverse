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
 * @param {string} options.versionHint 版本提示
 * @returns {Promise<void>}
 */
async function reverseProject(options) {
  const { sourcePath, outputPath, verbose = false, versionHint } = options;
  
  // 全局配置初始化
  global.config = loadConfig();
  global.verbose = verbose;
  
  // 检测Cocos Creator版本并设置相应的文件路径
  const projectInfo = detectProjectVersion(sourcePath, versionHint);
  global.cocosVersion = projectInfo.version;
  
  // 检查文件是否存在
  validatePaths(projectInfo.resPath, projectInfo.settingsPath, projectInfo.projectPath);
  
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
    res: projectInfo.resPath,
    temp: tempPath,
    ast: astPath
  };

  // 读取项目文件
  try {
    // 读取和解析设置
    const settings = await readFile(projectInfo.settingsPath);
    const project = await readFile(projectInfo.projectPath);
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
 * 检测Cocos Creator项目版本并返回相应的文件路径
 * @param {string} sourcePath 源项目路径
 * @param {string} versionHint 版本提示
 * @returns {Object} 包含版本信息和文件路径的对象
 */
function detectProjectVersion(sourcePath, versionHint) {
  const normalizedSourcePath = path.resolve(sourcePath);
  const sourceBasename = path.basename(normalizedSourcePath);
  const candidateRoots = [normalizedSourcePath];

  // 兼容用户直接传入 assets/res 目录的场景
  if (sourceBasename === 'assets' || sourceBasename === 'res') {
    candidateRoots.push(path.dirname(normalizedSourcePath));
  }

  // 去重
  const uniqueCandidateRoots = [...new Set(candidateRoots)];

  function buildPaths(basePath) {
    return {
      // 2.4.x 主要检查build目录下的文件
      settings: [
        path.resolve(basePath, 'main.js'),
        path.resolve(basePath, 'settings.js'),
        path.resolve(basePath, 'src/settings.js')
      ],
      project: [
        path.resolve(basePath, 'project.js'),
        path.resolve(basePath, 'main.js'),
        path.resolve(basePath, 'src/project.js')
      ],
      res: [
        path.resolve(basePath, 'assets'),
        path.resolve(basePath, 'res'),
        path.resolve(basePath, 'src/assets')
      ]
    };
  }

  // 2.4.x版本的可能路径
  const paths24x = buildPaths(normalizedSourcePath);
  if (sourceBasename === 'assets' || sourceBasename === 'res') {
    paths24x.res = [normalizedSourcePath, ...paths24x.res];
  }

  // 2.3.x及以下版本的路径
  const paths23x = {
    settings: [path.resolve(normalizedSourcePath, 'src/settings.js')],
    project: [path.resolve(normalizedSourcePath, 'src/project.js')],
    res: [path.resolve(normalizedSourcePath, 'res')]
  };

  // 检测文件存在性并确定版本
  function findExistingPath(pathArray) {
    for (const filePath of pathArray) {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  // 如果用户提供了版本提示，优先使用对应版本的路径
  if (versionHint === '2.4.x') {
    const settings24 = findExistingPath(paths24x.settings);
    const project24 = findExistingPath(paths24x.project);
    const res24 = findExistingPath(paths24x.res);
    
    if (settings24 && project24 && res24) {
      logger.info('使用用户指定的Cocos Creator 2.4.x项目结构');
      return {
        version: '2.4.x',
        settingsPath: settings24,
        projectPath: project24,
        resPath: res24
      };
    } else {
      logger.warn('用户指定2.4.x版本，但未找到对应文件结构，尝试自动检测...');
    }
  } else if (versionHint === '2.3.x') {
    const settings23 = findExistingPath(paths23x.settings);
    const project23 = findExistingPath(paths23x.project);
    const res23 = findExistingPath(paths23x.res);
    
    if (settings23 && project23 && res23) {
      logger.info('使用用户指定的Cocos Creator 2.3.x项目结构');
      return {
        version: '2.3.x',
        settingsPath: settings23,
        projectPath: project23,
        resPath: res23
      };
    } else {
      logger.warn('用户指定2.3.x版本，但未找到对应文件结构，尝试自动检测...');
    }
  }

  // 自动检测：先尝试2.3.x路径（更精确的检测）
  for (const root of uniqueCandidateRoots) {
    const paths = {
      settings: [path.resolve(root, 'src/settings.js')],
      project: [path.resolve(root, 'src/project.js')],
      res: [path.resolve(root, 'res')]
    };
    const settings23 = findExistingPath(paths.settings);
    const project23 = findExistingPath(paths.project);
    const res23 = findExistingPath(paths.res);

    if (settings23 && project23 && res23) {
      logger.info('自动检测到Cocos Creator 2.3.x或更早版本项目结构');
      return {
        version: '2.3.x',
        settingsPath: settings23,
        projectPath: project23,
        resPath: res23
      };
    }
  }

  // 再尝试2.4.x路径
  for (const root of uniqueCandidateRoots) {
    const paths = buildPaths(root);
    if (sourceBasename === 'assets' || sourceBasename === 'res') {
      paths.res = [normalizedSourcePath, ...paths.res];
    }
    const settings24 = findExistingPath(paths.settings);
    const project24 = findExistingPath(paths.project);
    const res24 = findExistingPath(paths.res);

    if (settings24 && project24 && res24) {
      logger.info('自动检测到Cocos Creator 2.4.x项目结构');
      return {
        version: '2.4.x',
        settingsPath: settings24,
        projectPath: project24,
        resPath: res24
      };
    }
  }

  // 如果都找不到，抛出详细错误信息
  throw new Error(`无法检测到有效的Cocos Creator项目结构，请检查输入路径是否正确。
支持的文件结构：
2.4.x: main.js/settings.js + project.js/main.js + assets/res目录
2.3.x: src/settings.js + src/project.js + res目录`);
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
  try {
    const settingsContent = settings.toString('utf-8');
    
    // 根据版本使用不同的解析方式
    if (global.cocosVersion === '2.4.x') {
      // 2.4.x版本的解析逻辑
      if (settingsContent.includes('window.CCSettings')) {
        // 标准的CCSettings格式
        let _ccsettings = "let window = {CCSettings: {}};" + settingsContent.split(';')[0];
        global.settings = eval(_ccsettings);
      } else {
        // 尝试直接解析为对象
        try {
          global.settings = eval("let window = {}; " + settingsContent + "; window");
        } catch (e) {
          logger.warn('2.4.x设置文件解析失败，使用默认设置');
          global.settings = { CCSettings: {} };
        }
      }
    } else {
      // 2.3.x及以下版本的原有解析逻辑
      let _ccsettings = "let window = {CCSettings: {}};" + settingsContent.split(';')[0];
      global.settings = eval(_ccsettings);
    }
    
    // 确保settings不为空
    if (!global.settings || !global.settings.CCSettings) {
      global.settings = { CCSettings: {} };
    }
    
    if (global.verbose) {
      logger.debug('已加载项目设置:', Object.keys(global.settings.CCSettings || {}));
    }
  } catch (err) {
    logger.error('解析设置文件时出错:', err);
    logger.warn('使用默认设置');
    global.settings = { CCSettings: {} };
  }
}

module.exports = { reverseProject, detectProjectVersion };
