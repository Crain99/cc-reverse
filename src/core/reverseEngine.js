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
const { writeRecoveryReport } = require('../utils/recoveryReport');

/**
 * 逆向工程主函数
 * @param {Object} options 配置选项
 * @returns {Promise<object>} recovery summary
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
    scriptFormat = '',
    noAstFallback = false,
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

  const optionSummary = {
    versionHint: versionHint || '',
    scriptFormat: scriptFormat || 'auto',
    noAstFallback: !!noAstFallback,
    assetsOnly: !!assetsOnly,
    scriptsOnly: !!scriptsOnly,
    bundle: Array.isArray(bundle) ? bundle : [],
  };

  // 3.x pipeline is bundle-oriented — dispatch early.
  if (projectInfo.version === '3.x') {
    ctx.paths = { source: sourcePath, output: outputPath };
    ctx.applyGlobals();
    const summary3x = await reverseProject3x({
      sourcePath,
      outputPath,
      bundleFilter: ctx.bundleFilter,
      assetsOnly,
      scriptsOnly,
      key: key || config.decrypt?.key || extractKeyFromProject(sourcePath),
      verbose,
    });
    summary3x.options = optionSummary;
    // Re-write report so options/flavor land in the shared template
    summary3x.reportPath = await writeRecoveryReport(outputPath, summary3x, sourcePath);
    return summary3x;
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

  const summary = {
    engine: projectInfo.version,
    version: projectInfo.version,
    scripts: null,
    assets: null,
    warnings: [],
    options: optionSummary,
  };

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
      summary.warnings.push('Found .jsc files but no decrypt key was provided');
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

    if (!assetsOnly) {
      logger.info('开始分析代码...');
      const scriptResult = await codeAnalyzer.analyze(code, {
        forceFormat: scriptFormat || undefined,
        noAstFallback,
        verbose,
        outputPath,
      });
      summary.scripts = {
        total: scriptResult?.written ?? 0,
        modules: scriptResult?.modules ?? 0,
        written: scriptResult?.written ?? 0,
        failed: scriptResult?.failed ?? 0,
        format: scriptResult?.format,
        extractor: scriptResult?.extractor,
      };
    } else {
      summary.scripts = { total: 0, skipped: true };
    }

    if (!scriptsOnly) {
      logger.info('开始处理资源...');
      await resourceProcessor.processResources();
      summary.assets = {
        scenes: resourceProcessor.sceneAssets.length,
        prefabs: resourceProcessor.prefabs.length,
        sprites: Object.keys(resourceProcessor.spriteFrames).length,
        audio: resourceProcessor.audio.length,
        animations: resourceProcessor.animation.length,
        copies: resourceProcessor.cacheReadList.length,
        labelAtlas: (resourceProcessor._labelAtlasCount || 0),
      };
    } else {
      summary.assets = { skipped: true };
    }

    logger.info('生成项目文件...');
    await projectGenerator.generateProject();

    summary.reportPath = await writeRecoveryReport(outputPath, summary, sourcePath);

    if (!verbose) {
      await fileManager.cleanDirectory(tempPath);
    }

    return summary;
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

  /**
   * Find first existing path, or first match of a basename regex under a dir.
   * Used for MD5 Cache builds: main.<hash>.js / settings.<hash>.js / project.<hash>.js
   */
  function findExistingPath(pathArray) {
    for (const filePath of pathArray) {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  function findHashedFile(dir, pattern) {
    if (!fs.existsSync(dir)) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const hit = entries.find((name) => pattern.test(name));
    return hit ? path.join(dir, hit) : null;
  }

  /**
   * Resolve a classic entry file, including Creator MD5 Cache renames:
   * main.js → main.<hash>.js, settings.js → settings.<hash>.js, etc.
   */
  function resolveEntry(root, { plainPaths, searchDirs, hashedRegexes }) {
    const plain = findExistingPath(plainPaths.map((p) => path.resolve(root, p)));
    if (plain) return plain;
    for (const relDir of searchDirs) {
      const dir = path.resolve(root, relDir);
      for (const re of hashedRegexes) {
        const hit = findHashedFile(dir, re);
        if (hit) return hit;
      }
    }
    return null;
  }

  function tryClassicLayout(root, version) {
    let settings;
    let project;
    let resList;

    if (version === '2.3.x') {
      settings = resolveEntry(root, {
        plainPaths: ['src/settings.js'],
        searchDirs: ['src'],
        hashedRegexes: [/^settings\.[^/\\]+\.js$/i],
      });
      project = resolveEntry(root, {
        plainPaths: ['src/project.js'],
        searchDirs: ['src'],
        hashedRegexes: [/^project\.[^/\\]+\.js$/i],
      });
      resList = [path.resolve(root, 'res')];
    } else {
      // 2.4.x classic
      settings = resolveEntry(root, {
        plainPaths: ['main.js', 'settings.js', 'src/settings.js', 'src/main.js'],
        searchDirs: ['.', 'src'],
        hashedRegexes: [/^settings\.[^/\\]+\.js$/i, /^main\.[^/\\]+\.js$/i],
      });
      project = resolveEntry(root, {
        plainPaths: ['project.js', 'main.js', 'src/project.js', 'src/main.js'],
        searchDirs: ['.', 'src'],
        hashedRegexes: [/^project\.[^/\\]+\.js$/i, /^main\.[^/\\]+\.js$/i],
      });
      resList = [
        path.resolve(root, 'assets'),
        path.resolve(root, 'res'),
        path.resolve(root, 'src/assets'),
      ];
    }

    if (sourceBasename === 'assets' || sourceBasename === 'res') {
      resList = [normalizedSourcePath, ...resList];
    }
    const res = findExistingPath(resList);

    if (settings && project && res) {
      return {
        version,
        settingsPath: settings,
        projectPath: project,
        resPath: res,
      };
    }
    return null;
  }

  /**
   * Bundle-style builds (Creator 2.4+ MD5 / 3.x): assets/<bundle>/config.json
   * or config.<hash>.json. These must use the bundle pipeline, not classic 2.x.
   */
  function isBundleRoot(root) {
    const markers = [
      path.join(root, 'application.js'),
      path.join(root, 'src', 'settings.json'),
    ];
    if (markers.some((p) => fs.existsSync(p))) return true;
    // hashed application / settings
    if (findHashedFile(root, /^application\.[^/\\]+\.js$/i)) return true;
    if (findHashedFile(path.join(root, 'src'), /^settings\.[^/\\]+\.json$/i)) return true;

    const assetsDir = path.join(root, 'assets');
    if (!fs.existsSync(assetsDir)) return false;
    try {
      const entries = fs.readdirSync(assetsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const bundleDir = path.join(assetsDir, e.name);
        // plain or hashed config
        if (fs.existsSync(path.join(bundleDir, 'config.json'))) return true;
        if (findHashedFile(bundleDir, /^config\.[^/\\]+\.json$/i)) return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  // Version hint: 3.x → bundle pipeline
  if (versionHint === '3.x') {
    for (const root of uniqueCandidateRoots) {
      if (isBundleRoot(root)) {
        logger.info('使用用户指定的Cocos Creator 3.x项目结构');
        return { version: '3.x', sourcePath: root };
      }
    }
    logger.warn('用户指定3.x版本，但未找到对应文件结构，尝试自动检测...');
  }

  // Version hint: 2.4.x
  // Prefer bundle layout when present (MD5 Cache / 2.4 bundle builds). Forcing
  // the classic 2.x pipeline on those projects yields JSON "textures" and fails
  // to parse config.<hash>.json — the root cause of issue #31.
  if (versionHint === '2.4.x') {
    for (const root of uniqueCandidateRoots) {
      if (isBundleRoot(root)) {
        logger.info('检测到 2.4.x/3.x bundle 结构（含 MD5 config），使用 bundle 解析管线');
        return { version: '3.x', sourcePath: root };
      }
    }
    for (const root of uniqueCandidateRoots) {
      const hit = tryClassicLayout(root, '2.4.x');
      if (hit) {
        logger.info('使用用户指定的Cocos Creator 2.4.x项目结构');
        return hit;
      }
    }
    logger.warn('用户指定2.4.x版本，但未找到对应文件结构，尝试自动检测...');
  } else if (versionHint === '2.3.x') {
    for (const root of uniqueCandidateRoots) {
      const hit = tryClassicLayout(root, '2.3.x');
      if (hit) {
        logger.info('使用用户指定的Cocos Creator 2.3.x项目结构');
        return hit;
      }
    }
    logger.warn('用户指定2.3.x版本，但未找到对应文件结构，尝试自动检测...');
  }

  // Auto-detect bundle style first (3.x and 2.4 MD5 / bundle)
  for (const root of uniqueCandidateRoots) {
    if (isBundleRoot(root)) {
      logger.info('自动检测到Cocos Creator bundle 项目结构 (3.x / 2.4.x MD5)');
      return { version: '3.x', sourcePath: root };
    }
  }

  // 2.3.x (更精确)
  for (const root of uniqueCandidateRoots) {
    const hit = tryClassicLayout(root, '2.3.x');
    if (hit) {
      logger.info('自动检测到Cocos Creator 2.3.x或更早版本项目结构');
      return hit;
    }
  }

  // classic 2.4.x
  for (const root of uniqueCandidateRoots) {
    const hit = tryClassicLayout(root, '2.4.x');
    if (hit) {
      logger.info('自动检测到Cocos Creator 2.4.x项目结构');
      return hit;
    }
  }

  throw new Error(`无法检测到有效的Cocos Creator项目结构，请检查输入路径是否正确。
支持的文件结构：
3.x / 2.4 bundle: assets/<bundle>/config.json 或 config.<hash>.json
2.4.x classic: main.js|main.<hash>.js + assets/res
2.3.x: src/settings.js|settings.<hash>.js + src/project.js + res/`);
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
