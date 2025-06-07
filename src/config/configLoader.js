/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 配置加载器
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

/**
 * 默认配置
 */
const defaultConfig = {
    // 输出配置
    output: {
        createMeta: true,
        prettify: true,
        includeComments: true
    },
    
    // 代码生成配置
    codeGen: {
        language: "typescript",
        moduleType: "commonjs",
        indentSize: 2,
        indent: "space"
    },
    
    // 资源处理配置
    assets: {
        extractTextures: true,
        extractAudio: true,
        extractAnimations: true,
        optimizeSprites: false
    },
    
    // 高级配置
    advanced: {
        debug: false,
        verbose: false,
        cacheEnabled: true,
        tempDir: "temp",
        maxParallel: 4
    }
};

/**
 * 配置加载器
 */
function loadConfig() {
    try {
        // 尝试从工作目录加载配置文件
        const configPath = path.join(process.cwd(), 'cc-reverse.config.js');
        
        // 检查配置文件是否存在
        if (fs.existsSync(configPath)) {
            logger.info(`加载配置文件: ${configPath}`);
            
            // 加载配置文件
            const userConfig = require(configPath);
            
            // 合并默认配置和用户配置
            return deepMerge(defaultConfig, userConfig);
        }
        
        // 如果配置文件不存在，返回默认配置
        logger.info('使用默认配置');
        return defaultConfig;
    } catch (err) {
        logger.error('加载配置文件时出错:', err);
        logger.warn('使用默认配置');
        return defaultConfig;
    }
}

/**
 * 深度合并对象
 * @param {Object} target 目标对象
 * @param {Object} source 源对象
 * @returns {Object} 合并后的对象
 */
function deepMerge(target, source) {
    // 创建目标对象的副本
    const output = Object.assign({}, target);
    
    // 如果源对象为空，直接返回目标对象
    if (!source) {
        return output;
    }
    
    // 遍历源对象的属性
    Object.keys(source).forEach(key => {
        // 如果值是对象，递归合并
        if (isObject(source[key])) {
            if (isObject(target[key])) {
                output[key] = deepMerge(target[key], source[key]);
            } else {
                output[key] = Object.assign({}, source[key]);
            }
        } else {
            // 否则，直接赋值
            output[key] = source[key];
        }
    });
    
    return output;
}

/**
 * 判断值是否为对象
 * @param {any} item 要检查的值
 * @returns {boolean} 如果是对象返回 true，否则返回 false
 */
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

module.exports = { loadConfig, defaultConfig }; 