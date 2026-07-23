/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 逆向工程核心引擎
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const vm = require('vm');
const { fileManager } = require('../utils/fileManager');
const { codeAnalyzer } = require('./codeAnalyzer');
const { resourceProcessor } = require('./resourceProcessor');
const { projectGenerator } = require('./projectGenerator');
const { logger } = require('../utils/logger');
const { loadConfig } = require('../config/configLoader');
const { decryptProject, scanJscFiles, extractKeyFromProject } = require('./jscDecryptor');
const { reverseProject3x } = require('./cocos3x/engine3x');
const { ReverseContext } = require('./context');

/**
 * 逆向工程主函数
 * @param {Object} options 配置选项
 * @returns {Promise<void>}
 */
async function reverseProject(options) {
  const {
    sourcePath,
    outputPath,
    verbose = false,
    versionHint,
    key,
    bundle,
    assetsOnly = false,
    scriptsOnly = false,
  } = options;

  const config = loadConfig();
  const ctx = new ReverseContext({
    sourcePath,
    outputPath,
    verbose,
    silent: options.silent,
    versionHint,
    key,
    bundle,
    assetsOnly,
    scriptsOnly,
    config,
  });

  // 检测 Cocos Creator 版本
  const projectInfo = detectProjectVersion(sourcePath, versionHint);
  ctx.version = projectInfo.version;
  ctx.applyGlobals();

  // 3.x pipeline is bundle-oriented — dispatch early.
  if (projectInfo.version === '3.x') {
    ctx.paths = { source: sourcePath, output: outputPath };
    ctx.applyGlobals();
    return reverseProject3x({
      sourcePath,
      outputPath,
      bundleFilter: ctx.bundleFilter,
      assetsOnly,
      scriptsOnly,
      key: key || config.decrypt?.key || extractKeyFromProject(sourcePath),
      verbose,
    });
  }

  // 检查文件是否存在 (2.x pipeline)
  validatePaths(projectInfo.resPath, projectInfo.settingsPath, projectInfo.projectPath);

  // 创建临时目录和输出目录（脚本恢复已改为内存切片，默认不再写 temp/ast）
  const tempPath = path.resolve(outputPath, 'temp');
  await fsp.mkdir(tempPath, { recursive: true });
  await fsp.mkdir(outputPath, { recursive: true });

  ctx.paths = {
    source: sourcePath,
    output: outputPath,
    res: projectInfo.resPath,
    temp: tempPath,
    ast: null,
  };
  ctx.applyGlobals();

  // JSC 解密预处理
  const jscFiles = scanJscFiles(sourcePath);
  let codePath = sourcePath;
  if (jscFiles.length > 0) {
    const decryptKey = key || config.decrypt?.key || extractKeyFromProject(sourcePath);
    if (decryptKey) {
      const decryptOutputDir = path.resolve(tempPath, 'decrypted');
      await fsp.mkdir(decryptOutputDir, { recursive: true });
      logger.info('检测到 JSC 加密文件，开始解密...');
      await decryptProject(sourcePath, decryptOutputDir, decryptKey);
      codePath = decryptOutputDir;
    } else {
      logger.warn('发现 .jsc 文件但未提供密钥，请使用 --key 参数指定密钥');
    }
  }

  try {
    const settings = await fsp.readFile(projectInfo.settingsPath);

    let projectFilePath = projectInfo.projectPath;
    if (codePath !== sourcePath) {
      const decryptedProjectFile = path.join(
        codePath,
        path.relative(sourcePath, projectInfo.projectPath).replace(/\.jsc$/, '.js'),
      );
      if (fs.existsSync(decryptedProjectFile)) {
        projectFilePath = decryptedProjectFile;
      }
    }
    const project = await fsp.readFile(projectFilePath);
    const code = project.toString('utf-8');

    ctx.settings = parseSettings(settings, projectInfo.version);
    ctx.applyGlobals();

    logger.info('开始分析代码...');
    await codeAnalyzer.analyze(code);

    logger.info('开始处理资源...');
    await resourceProcessor.processResources();

    logger.info('生成项目文件...');
    await projectGenerator.generateProject();

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
 * @returns {Object}
 */
function detectProjectVersion(sourcePath, versionHint) {
  const normalizedSourcePath = path.resolve(sourcePath);
  const sourceBasename = path.basename(normalizedSourcePath);
  const candidateRoots = [normalizedSourcePath];

  // 兼容用户直接传入 assets/res 目录的场景
  if (sourceBasename === 'assets' || sourceBasename === 'res') {
    candidateRoots.push(path.dirname(normalizedSourcePath));
  }

  const uniqueCandidateRoots = [...new Set(candidateRoots)];

  function buildPaths(basePath) {
    return {
      settings: [
        path.resolve(basePath, 'main.js'),
        path.resolve(basePath, 'settings.js'),
        path.resolve(basePath, 'src/settings.js'),
      ],
      project: [
        path.resolve(basePath, 'project.js'),
        path.resolve(basePath, 'main.js'),
        path.resolve(basePath, 'src/project.js'),
      ],
      res: [
        path.resolve(basePath, 'assets'),
        path.resolve(basePath, 'res'),
        path.resolve(basePath, 'src/assets'),
      ],
    };
  }

  function findExistingPath(pathArray) {
    for (const filePath of pathArray) {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  function tryLayout(root, layout) {
    const settings = findExistingPath(layout.settings);
    const project = findExistingPath(layout.project);
    const res = findExistingPath(layout.res);
    if (settings && project && res) {
      return {
        version: layout.version,
        settingsPath: settings,
        projectPath: project,
        resPath: res,
      };
    }
    return null;
  }

  function is3xRoot(root) {
    const candidates = [
      path.join(root, 'assets', 'main', 'config.json'),
      path.join(root, 'assets', 'internal', 'config.json'),
      path.join(root, 'assets', 'resources', 'config.json'),
      path.join(root, 'application.js'),
      path.join(root, 'src', 'settings.json'),
    ];
    if (candidates.some((p) => fs.existsSync(p))) return true;

    const assetsDir = path.join(root, 'assets');
    if (fs.existsSync(assetsDir)) {
      try {
        const entries = fs.readdirSync(assetsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (fs.existsSync(path.join(assetsDir, e.name, 'config.json'))) return true;
        }
      } catch {
        // ignore
      }
    }
    return false;
  }

  function layout24x(root) {
    const paths = buildPaths(root);
    if (sourceBasename === 'assets' || sourceBasename === 'res') {
      paths.res = [normalizedSourcePath, ...paths.res];
    }
    return { version: '2.4.x', ...paths };
  }

  function layout23x(root) {
    return {
      version: '2.3.x',
      settings: [path.resolve(root, 'src/settings.js')],
      project: [path.resolve(root, 'src/project.js')],
      res: [path.resolve(root, 'res')],
    };
  }

  // Version hint: 3.x
  if (versionHint === '3.x') {
    for (const root of uniqueCandidateRoots) {
      if (is3xRoot(root)) {
        logger.info('使用用户指定的Cocos Creator 3.x项目结构');
        return { version: '3.x', sourcePath: root };
      }
    }
    logger.warn('用户指定3.x版本，但未找到对应文件结构，尝试自动检测...');
  }

  if (versionHint === '2.4.x') {
    for (const root of uniqueCandidateRoots) {
      const hit = tryLayout(root, layout24x(root));
      if (hit) {
        logger.info('使用用户指定的Cocos Creator 2.4.x项目结构');
        return hit;
      }
    }
    logger.warn('用户指定2.4.x版本，但未找到对应文件结构，尝试自动检测...');
  } else if (versionHint === '2.3.x') {
    for (const root of uniqueCandidateRoots) {
      const hit = tryLayout(root, layout23x(root));
      if (hit) {
        logger.info('使用用户指定的Cocos Creator 2.3.x项目结构');
        return hit;
      }
    }
    logger.warn('用户指定2.3.x版本，但未找到对应文件结构，尝试自动检测...');
  }

  // Auto-detect 3.x first
  for (const root of uniqueCandidateRoots) {
    if (is3xRoot(root)) {
      logger.info('自动检测到Cocos Creator 3.x项目结构');
      return { version: '3.x', sourcePath: root };
    }
  }

  // 2.3.x (更精确)
  for (const root of uniqueCandidateRoots) {
    const hit = tryLayout(root, layout23x(root));
    if (hit) {
      logger.info('自动检测到Cocos Creator 2.3.x或更早版本项目结构');
      return hit;
    }
  }

  // 2.4.x
  for (const root of uniqueCandidateRoots) {
    const hit = tryLayout(root, layout24x(root));
    if (hit) {
      logger.info('自动检测到Cocos Creator 2.4.x项目结构');
      return hit;
    }
  }

  throw new Error(`无法检测到有效的Cocos Creator项目结构，请检查输入路径是否正确。
支持的文件结构：
3.x:   assets/<bundle>/config.json (或 application.js + src/settings.json)
2.4.x: main.js + settings.js + assets/res目录
2.3.x: src/settings.js + src/project.js + res目录`);
}

/**
 * 验证路径是否存在
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
 * 安全解析 settings 脚本（vm 沙箱，避免裸 eval）
 * @param {Buffer|string} settings
 * @param {string} cocosVersion
 * @returns {{ CCSettings: object }}
 */
function parseSettings(settings, cocosVersion) {
  try {
    const settingsContent = Buffer.isBuffer(settings)
      ? settings.toString('utf-8')
      : String(settings);

    let parsed = null;

    if (cocosVersion === '2.4.x') {
      if (settingsContent.includes('window.CCSettings')
          || settingsContent.includes('window._CCSettings')) {
        parsed = runSettingsInVm(settingsContent);
      } else {
        parsed = runSettingsInVm(settingsContent);
      }
    } else {
      // 2.3.x 常见形态：仅首条赋值语句含 CCSettings
      const firstStmt = settingsContent.split(';')[0];
      parsed = runSettingsInVm(firstStmt);
    }

    if (!parsed || !parsed.CCSettings) {
      // 尝试 _CCSettings 别名
      if (parsed && parsed._CCSettings) {
        parsed = { CCSettings: parsed._CCSettings };
      } else {
        parsed = { CCSettings: {} };
      }
    }

    if (global.verbose) {
      logger.debug('已加载项目设置:', Object.keys(parsed.CCSettings || {}));
    }

    return parsed;
  } catch (err) {
    logger.error('解析设置文件时出错:', err);
    logger.warn('使用默认设置');
    return { CCSettings: {} };
  }
}

/**
 * 在隔离 vm 中执行 settings 脚本，返回 window 上的设置对象
 * @param {string} code
 * @returns {object}
 */
function runSettingsInVm(code) {
  const sandbox = {
    window: { CCSettings: {}, _CCSettings: null },
    // 部分构建会用全局 CCSettings
    CCSettings: undefined,
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { timeout: 2000, displayErrors: false });
  } catch (e) {
    // 回退：尝试只提取对象字面量
    const m = code.match(/(?:window\.)?_?CCSettings\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) {
      try {
        const obj = vm.runInNewContext(`(${m[1]})`, {}, { timeout: 1000 });
        return { CCSettings: obj };
      } catch {
        // ignore
      }
    }
    throw e;
  }

  const win = sandbox.window || {};
  if (win.CCSettings && Object.keys(win.CCSettings).length > 0) {
    return { CCSettings: win.CCSettings };
  }
  if (win._CCSettings) {
    return { CCSettings: win._CCSettings };
  }
  if (sandbox.CCSettings) {
    return { CCSettings: sandbox.CCSettings };
  }
  return { CCSettings: win.CCSettings || {} };
}

module.exports = { reverseProject, detectProjectVersion, parseSettings };
