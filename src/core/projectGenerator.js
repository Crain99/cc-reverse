/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 项目配置文件生成工具
 */
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { uuidUtils } = require('../utils/uuidUtils');
const { logger } = require('../utils/logger');

// 将 fs 的异步方法转换为 Promise
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

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
            // 创建配置对象
            const project = this.createProjectConfig();
            const jsconfig = this.createJSConfig();
            const tsconfig = this.createTSConfig();
            const settings = this.createProjectSettings();

            // 确保目录存在
            const settingsDir = path.join(global.paths.output, 'settings');
            await mkdir(settingsDir, { recursive: true });

            // 写入配置文件
            await writeFile(
                path.join(settingsDir, 'project.json'), 
                JSON.stringify(settings, null, 2)
            );
            
            await writeFile(
                path.join(global.paths.output, 'project.json'), 
                JSON.stringify(project, null, 2)
            );
            
            await writeFile(
                path.join(global.paths.output, 'jsconfig.json'), 
                JSON.stringify(jsconfig, null, 2)
            );
            
            await writeFile(
                path.join(global.paths.output, 'tsconfig.json'), 
                JSON.stringify(tsconfig, null, 2)
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
     * @returns {Object} 项目配置对象
     */
    createProjectConfig(name = "project") {
        return {
            "engine": "cocos-creator-js",
            "packages": "packages",
            "name": name,
            "id": uuidUtils.decodeUuid(uuidUtils.generateUuid()),
            "version": "2.3.4",
            "isNew": false
        };
    },

    /**
     * 生成 JSConfig 配置
     * @returns {Object} JSConfig 配置对象
     */
    createJSConfig() {
        return {
            "compilerOptions": {
                "target": "es6",
                "module": "commonjs",
                "experimentalDecorators": true
            },
            "exclude": [
                "node_modules",
                ".vscode",
                "library",
                "local",
                "settings",
                "temp"
            ]
        };
    },

    /**
     * 生成 TSConfig 配置
     * @returns {Object} TSConfig 配置对象
     */
    createTSConfig() {
        return {
            "compilerOptions": {
                "module": "commonjs",
                "lib": ["es2015", "es2017", "dom"],
                "target": "es5",
                "experimentalDecorators": true,
                "skipLibCheck": true,
                "outDir": "temp/vscode-dist",
                "forceConsistentCasingInFileNames": true
            },
            "exclude": [
                "node_modules",
                "library",
                "local",
                "temp",
                "build",
                "settings"
            ]
        };
    },

    /**
     * 生成项目设置
     * @returns {Object} 项目设置对象
     */
    createProjectSettings() {
        const settings = {
            "group-list": "",
            "collision-matrix": "",
            "excluded-modules": [
                "3D Physics/Builtin"
            ],
            "last-module-event-record-time": Date.now(),
            "design-resolution-width": 960,
            "design-resolution-height": 640,
            "fit-width": false,
            "fit-height": true,
            "use-project-simulator-setting": false,
            "simulator-orientation": false,
            "use-customize-simulator": true,
            "simulator-resolution": {
                "height": 640,
                "width": 960
            },
            "assets-sort-type": "name",
            "facebook": {
                "appID": "",
                "audience": {
                    "enable": false
                },
                "enable": false,
                "live": {
                    "enable": false
                }
            },
            "migrate-history": [],
            "start-scene": "current"
        };

        // 添加全局设置
        if (global.settings) {
            if (global.settings["groupList"]) {
                settings["group-list"] = global.settings["groupList"];
            }
            
            if (global.settings["collisionMatrix"]) {
                settings["collision-matrix"] = global.settings["collisionMatrix"];
            }
            
            if (global.settings["launchScene"]) {
                settings["start-scene"] = path.basename(global.settings["launchScene"]).split(".")[0];
            }
        }

        return settings;
    }
};

module.exports = { projectGenerator }; 