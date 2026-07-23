/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 项目配置文件生成工具
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { uuidUtils } = require('../utils/uuidUtils');
const { logger } = require('../utils/logger');

/**
 * 项目生成器模块
 */
const projectGenerator = {
  /**
   * 生成项目文件
   * @returns {Promise<void>}
   */
  async generateProject() {
    try {
      const project = this.createProjectConfig();
      const jsconfig = this.createJSConfig();
      const tsconfig = this.createTSConfig();
      const settings = this.createProjectSettings();

      const settingsDir = path.join(global.paths.output, 'settings');
      await fsp.mkdir(settingsDir, { recursive: true });

      await fsp.writeFile(
        path.join(settingsDir, 'project.json'),
        JSON.stringify(settings, null, 2),
      );

      await fsp.writeFile(
        path.join(global.paths.output, 'project.json'),
        JSON.stringify(project, null, 2),
      );

      await fsp.writeFile(
        path.join(global.paths.output, 'jsconfig.json'),
        JSON.stringify(jsconfig, null, 2),
      );

      await fsp.writeFile(
        path.join(global.paths.output, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2),
      );

      logger.info('项目配置文件生成完成');
    } catch (err) {
      logger.error('生成项目配置文件时出错:', err);
      throw err;
    }
  },

  /**
   * 生成项目配置
   * @param {string} name 项目名称
   * @returns {Object}
   */
  createProjectConfig(name = 'project') {
    const version = this.getProjectVersion();

    return {
      engine: 'cocos-creator-js',
      packages: 'packages',
      name,
      id: uuidUtils.decodeUuid(uuidUtils.generateUuid()),
      version,
      isNew: false,
    };
  },

  /**
   * 获取项目版本号
   * @returns {string}
   */
  getProjectVersion() {
    if (global.cocosVersion === '2.4.x') {
      return '2.4.13';
    }
    return '2.3.4';
  },

  createJSConfig() {
    return {
      compilerOptions: {
        target: 'es6',
        module: 'commonjs',
        experimentalDecorators: true,
      },
      exclude: [
        'node_modules',
        '.vscode',
        'library',
        'local',
        'settings',
        'temp',
      ],
    };
  },

  createTSConfig() {
    return {
      compilerOptions: {
        module: 'commonjs',
        lib: ['es2015', 'es2017', 'dom'],
        target: 'es5',
        experimentalDecorators: true,
        skipLibCheck: true,
        outDir: 'temp/vscode-dist',
        forceConsistentCasingInFileNames: true,
      },
      exclude: [
        'node_modules',
        'library',
        'local',
        'temp',
        'build',
        'settings',
      ],
    };
  },

  createProjectSettings() {
    const settings = {
      'group-list': '',
      'collision-matrix': '',
      'excluded-modules': [
        '3D Physics/Builtin',
      ],
      'last-module-event-record-time': Date.now(),
      'design-resolution-width': 960,
      'design-resolution-height': 640,
      'fit-width': false,
      'fit-height': true,
      'use-project-simulator-setting': false,
      'simulator-orientation': false,
      'use-customize-simulator': true,
      'simulator-resolution': {
        height: 640,
        width: 960,
      },
      'assets-sort-type': 'name',
      facebook: {
        appID: '',
        audience: {
          enable: false,
        },
        enable: false,
        live: {
          enable: false,
        },
      },
      'migrate-history': [],
      'start-scene': 'current',
    };

    if (global.settings) {
      const cc = global.settings.CCSettings || global.settings;
      if (cc.groupList) {
        settings['group-list'] = cc.groupList;
      }
      if (cc.collisionMatrix) {
        settings['collision-matrix'] = cc.collisionMatrix;
      }
      if (cc.launchScene) {
        settings['start-scene'] = path.basename(cc.launchScene).split('.')[0];
      }
    }

    return settings;
  },
};

module.exports = { projectGenerator };
