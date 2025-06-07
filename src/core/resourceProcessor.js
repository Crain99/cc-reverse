/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 资源处理工具
 */
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const { uuidUtils } = require('../utils/uuidUtils');
const { fileManager } = require('../utils/fileManager');
const { logger } = require('../utils/logger');
const { converters } = require('./converters');

// 将 fs 方法转换为 Promise
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);

/**
 * 资源处理器模块
 */
const resourceProcessor = {
    // 数据存储
    fileList: [],
    fileMap: new Map(),
    cacheReadList: [],
    cacheWriteList: [],
    nodeData: {},
    
    // 资源映射
    sceneAssets: [],
    spriteFrames: {},
    audio: [],
    animation: [],
    
    /**
     * 处理资源文件
     * @returns {Promise<void>}
     */
    async processResources() {
        try {
            this.resetState();
            
            // 读取资源文件
            await this.readFiles(global.paths.res, true);
            
            // 转换为输出文件
            await this.convertToOutputFiles();
            
            logger.info('资源处理完成');
        } catch (err) {
            logger.error('处理资源文件时出错:', err);
            throw err;
        }
    },
    
    /**
     * 重置处理器状态
     */
    resetState() {
        this.fileList = [];
        this.fileMap = new Map();
        this.cacheReadList = [];
        this.cacheWriteList = [];
        this.nodeData = {};
        this.sceneAssets = [];
        this.spriteFrames = {};
        this.audio = [];
        this.animation = [];
    },
    
    /**
     * 递归读取目录下所有文件
     * @param {string} filePath 文件路径
     * @param {boolean} first 是否为首次调用
     * @returns {Promise<void>}
     */
    async readFiles(filePath, first) {
        try {
            const content = await readdir(filePath);
            
            for (let file of content) {
                const fullPath = path.join(filePath, file);
                const status = await stat(fullPath);
                
                if (status.isFile()) {
                    this.fileList.push(fullPath);
                    this.fileMap.set(path.basename(fullPath.split('.')[0]), fullPath);
                } else {
                    await this.readFiles(fullPath, false);
                }
            }
            
            if (first) {
                await this.processSubpackages();
                await this.processJsonFiles();
            }
        } catch (err) {
            logger.error(`读取目录 ${filePath} 时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 处理子包
     * @returns {Promise<void>}
     */
    async processSubpackages() {
        if (global.settings && !this.isEmptyObject(global.settings["subpackages"])) {
            const subpackagesPath = path.dirname(global.paths.res) + '/subpackages';
            
            if (fs.existsSync(subpackagesPath)) {
                await this.readFiles(subpackagesPath, false);
                logger.debug(`处理子包: ${subpackagesPath}`);
            } else {
                logger.warn(`子包路径不存在: ${subpackagesPath}`);
            }
        }
    },
    
    /**
     * 处理 JSON 文件
     * @returns {Promise<void>}
     */
    async processJsonFiles() {
        for (let currPath of this.fileList) {
            if (path.extname(currPath) === '.json') {
                try {
                    const currFile = await readFile(currPath);
                    let key = path.basename(currPath).split('.')[0];
                    const data = JSON.parse(currFile);
                    this.nodeData = data;
                    await this.processData(key, data);
                } catch (err) {
                    logger.error(`处理 JSON 文件 ${currPath} 时出错:`, err);
                }
            }
        }
    },
    
    /**
     * 检查对象是否为空
     * @param {Object} obj 要检查的对象
     * @returns {boolean} 如果对象为空返回 true，否则返回 false
     */
    isEmptyObject(obj) {
        for (let key in obj) {
            return false;
        }
        return true;
    },
    
    /**
     * 处理数据
     * @param {string} key 键名
     * @param {Object} data 要处理的数据
     */
    async processData(key, data) {
        if (!global.settings || this.isEmptyObject(global.settings)) {
            logger.warn('全局设置为空，跳过数据处理');
            return;
        }
        
        const processedData = await this.revealData(data);
        this.writeProcessedData(processedData, key);
    },
    
    /**
     * 解析数据对象
     * @param {Object} jsonObject 要解析的 JSON 对象
     * @returns {Promise<Object>} 解析后的对象
     */
    async revealData(jsonObject) {
        // 这里可以添加数据解析逻辑
        return jsonObject;
    },
    
    /**
     * 写入处理后的数据
     * @param {Object} data 处理后的数据
     * @param {string} key 键名
     */
    writeProcessedData(data, key) {
        if (typeof data === "object" && data["__type__"]) {
            this.processTypeData(data, key);
        } else {
            for (let i in data) {
                const type = data[i]['__type__'];
                if (Array.isArray(data[i])) {
                    this.writeProcessedData(data[i], key);
                } else if (type) {
                    this.processTypeObject(type, data, i, key);
                }
            }
        }
    },
    
    /**
     * 处理特定类型的数据
     * @param {Object} data 数据对象
     * @param {string} key 键名
     */
    processTypeData(data, key) {
        const type = data["__type__"];
        
        if (type) {
            if (type === "cc.AudioClip") {
                this.processAudioClip(data, key);
            } else if (type === "cc.TextAsset") {
                this.processTextAsset(data, key);
            } else if (type === "cc.AnimationClip") {
                this.processAnimationClip(data, key);
            }
        }
    },
    
    /**
     * 处理特定类型的对象
     * @param {string} type 对象类型
     * @param {Object} data 数据对象
     * @param {string} index 索引
     * @param {string} key 键名
     */
    processTypeObject(type, data, index, key) {
        if (type === 'cc.SceneAsset') {
            this.processSceneAsset(data, index, key);
        } else if (type === 'cc.SpriteFrame') {
            this.processSpriteFrame(data, index, key);
        }
        // 其他类型的处理可以在这里添加
    },
    
    /**
     * 处理音频资源
     * @param {Object} data 音频数据
     * @param {string} key 键名
     */
    processAudioClip(data, key) {
        const name = data["_name"] + data["_native"];
        const _mkdir = "Audio";
        const uuid = key;
        const metaData = {
            "ver": "1.2.7",
            "uuid": uuid,
            "optimizationPolicy": "AUTO",
            "asyncLoadAssets": false,
            "readonly": false,
            "subMetas": {}
        };
        
        if (this.fileMap.has(uuid)) {
            let writePath = name;
            let currPath = this.fileMap.get(uuid);
            
            this.cacheReadList.push(currPath);
            this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, writePath));
            this.fileMap.delete(uuid);
        }
        
        fileManager.writeFile(_mkdir, name + ".meta", metaData);
        this.audio.push(data);
    },
    
    /**
     * 处理文本资源
     * @param {Object} data 文本数据
     * @param {string} key 键名
     */
    processTextAsset(data, key) {
        const name = data['_name'] + ".json";
        const uuid = key;
        const _mkdir = "resource";
        const metaData = {
            "ver": "1.2.7",
            "uuid": uuid,
            "subMetas": {}
        };
        
        fileManager.writeFile(_mkdir, name, data);
        fileManager.writeFile(_mkdir, name + ".meta", metaData);
    },
    
    /**
     * 处理动画资源
     * @param {Object} data 动画数据
     * @param {string} key 键名
     */
    processAnimationClip(data, key) {
        const name = data["_name"];
        const _mkdir = "Animation";
        const filename = name + ".anim";
        
        fileManager.writeFile(_mkdir, filename, data);
        this.animation.push(data);
        
        const uuid = key;
        const metaData = {
            "ver": "1.2.7",
            "uuid": uuid,
            "optimizationPolicy": "AUTO",
            "asyncLoadAssets": false,
            "readonly": false,
            "subMetas": {}
        };
        
        fileManager.writeFile(_mkdir, filename + ".meta", metaData);
    },
    
    /**
     * 处理场景资源
     * @param {Object} data 场景数据
     * @param {string} index 索引
     * @param {string} key 键名
     */
    processSceneAsset(data, index, key) {
        const filename = data[0]['_name'] + '.fire';
        const _mkdir = 'Scene';
        
        this.sceneAssets.push(JSON.stringify(data));
        fileManager.writeFile(_mkdir, filename, data);
        
        for (let j in this.nodeData) {
            if (Array.isArray(this.nodeData[j])) {
                if (this.nodeData[j][0]["_name"] == data[0]["_name"]) {
                    const uuid = uuidUtils.decodeUuid(this.createLibrary(j, key));
                    const metaData = {
                        "ver": "1.2.7",
                        "uuid": uuid,
                        "optimizationPolicy": "AUTO",
                        "asyncLoadAssets": false,
                        "readonly": false,
                        "subMetas": {}
                    };
                    fileManager.writeFile(_mkdir, filename + ".meta", metaData);
                }
            }
        }
    },
    
    /**
     * 处理精灵帧资源
     * @param {Object} data 精灵帧数据
     * @param {string} index 索引
     * @param {string} key 键名
     */
    processSpriteFrame(data, index, key) {
        // 精灵帧处理逻辑
        this.spriteFrames[key] = data;
    },
    
    /**
     * 创建库
     * @param {string} index 索引
     * @param {string} key 键名
     * @returns {string} 库 ID
     */
    createLibrary(index, key) {
        if (global.settings && global.settings.uuids) {
            return global.settings.uuids[key] || uuidUtils.generateUuid();
        }
        return uuidUtils.generateUuid();
    },
    
    /**
     * 转换为输出文件
     * @returns {Promise<void>}
     */
    async convertToOutputFiles() {
        // 复制文件
        await this.copyFiles();
        
        // 转换特殊资源
        await converters.convertSpriteAtlas(this.spriteFrames);
        
        logger.info(`处理了 ${this.cacheReadList.length} 个资源文件`);
    },
    
    /**
     * 复制文件
     * @returns {Promise<void>}
     */
    async copyFiles() {
        try {
            for (let i = 0; i < this.cacheReadList.length; i++) {
                const sourcePath = this.cacheReadList[i];
                const targetPath = this.cacheWriteList[i];
                
                // 确保目标目录存在
                await fileManager.ensureDirectoryExists(path.dirname(targetPath));
                
                // 复制文件
                await fileManager.copyFile(sourcePath, targetPath);
                
                if (global.verbose) {
                    logger.debug(`复制文件: ${path.basename(sourcePath)} -> ${targetPath}`);
                }
            }
        } catch (err) {
            logger.error('复制文件时出错:', err);
            throw err;
        }
    }
};

module.exports = { resourceProcessor }; 