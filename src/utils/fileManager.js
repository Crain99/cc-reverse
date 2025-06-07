/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 文件管理工具
 */
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const { logger } = require('./logger');

// 将 fs 的异步方法转换为 Promise
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);

/**
 * 文件管理工具
 */
const fileManager = {
    /**
     * 确保目录存在
     * @param {string} directory 目录路径
     * @returns {Promise<void>}
     */
    async ensureDirectoryExists(directory) {
        try {
            await mkdir(directory, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
    },
    
    /**
     * 读取目录内容
     * @param {string} directory 目录路径
     * @returns {Promise<string[]>} 文件名列表
     */
    async readDirectory(directory) {
        try {
            return await readdir(directory);
        } catch (err) {
            logger.error(`读取目录 ${directory} 时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 读取文件内容
     * @param {string} filePath 文件路径
     * @param {string} encoding 编码方式，默认为 utf-8
     * @returns {Promise<string|Buffer>} 文件内容
     */
    async readFile(filePath, encoding = 'utf-8') {
        try {
            return await readFile(filePath, encoding);
        } catch (err) {
            logger.error(`读取文件 ${filePath} 时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 写入文件
     * @param {string} directory 目录名
     * @param {string} filename 文件名
     * @param {any} data 要写入的数据
     * @returns {Promise<void>}
     */
    async writeFile(directory, filename, data) {
        try {
            const outputDir = path.join(global.paths.output, 'assets', directory);
            await this.ensureDirectoryExists(outputDir);
            
            const outputPath = path.join(outputDir, filename);
            
            // 格式化数据
            let content;
            if (typeof data === 'object') {
                content = JSON.stringify(data, null, 2);
            } else {
                content = String(data);
            }
            
            // 写入文件
            await writeFile(outputPath, content);
            
            if (global.verbose) {
                logger.debug(`写入文件: ${outputPath}`);
            }
        } catch (err) {
            logger.error(`写入文件 ${directory}/${filename} 时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 创建元数据文件
     * @param {Set} fileMap 文件映射表
     * @returns {Promise<void>}
     */
    async createMetaFile(fileMap) {
        try {
            for (const filename in fileMap) {
                const meta = {
                    "ver": "1.0.8",
                    "uuid": fileMap[filename],
                    "isPlugin": false,
                    "loadPluginInWeb": true,
                    "loadPluginInNative": true,
                    "loadPluginInEditor": false,
                    "subMetas": {}
                };
                
                await this.writeFile("Scripts", filename + ".meta", meta);
            }
        } catch (err) {
            logger.error(`创建元数据文件时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 复制文件
     * @param {string} source 源文件路径
     * @param {string} target 目标文件路径
     * @returns {Promise<void>}
     */
    async copyFile(source, target) {
        try {
            await this.ensureDirectoryExists(path.dirname(target));
            
            // 创建可读流和可写流
            const readStream = fs.createReadStream(source);
            const writeStream = fs.createWriteStream(target);
            
            // 返回 Promise
            return new Promise((resolve, reject) => {
                readStream.on('error', err => {
                    reject(err);
                });
                
                writeStream.on('error', err => {
                    reject(err);
                });
                
                writeStream.on('finish', () => {
                    resolve();
                });
                
                // 开始流式复制
                readStream.pipe(writeStream);
            });
        } catch (err) {
            logger.error(`复制文件 ${source} 到 ${target} 时出错:`, err);
            throw err;
        }
    },
    
    /**
     * 递归删除目录
     * @param {string} directory 要删除的目录
     * @returns {Promise<void>}
     */
    async cleanDirectory(directory) {
        try {
            if (!fs.existsSync(directory)) {
                return;
            }
            
            const files = await readdir(directory);
            
            for (const file of files) {
                const currentPath = path.join(directory, file);
                const stats = await stat(currentPath);
                
                if (stats.isDirectory()) {
                    await this.cleanDirectory(currentPath);
                } else {
                    await unlink(currentPath);
                }
            }
            
            await rmdir(directory);
            
            logger.debug(`删除目录: ${directory}`);
        } catch (err) {
            logger.error(`删除目录 ${directory} 时出错:`, err);
            throw err;
        }
    }
};

module.exports = { fileManager }; 