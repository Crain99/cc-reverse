/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 代码分析和生成工具
 */
const generator = require("@babel/generator");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse");
const types = require("@babel/types");
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const { uuidUtils } = require('../utils/uuidUtils');
const { fileManager } = require('../utils/fileManager');
const { logger } = require('../utils/logger');

// 将 fs 的异步方法转换为 Promise
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const appendFile = promisify(fs.appendFile);

/**
 * 代码分析器模块
 */
const codeAnalyzer = {
    /**
     * 分析编译源代码
     * @param {string} code 要分析的源代码
     * @returns {Promise<void>}
     */
    async analyze(code) {
        try {
            // 1. 解析代码为 AST
            const ast = parser.parse(code);
            const values = [];
            
            // 2. 定义访问者函数查找值
            const findValue = {
                ArrayExpression(path) {
                    const { node } = path;
                    if (node && node.elements) {
                        for (let i of node.elements) {
                            if (types.isStringLiteral(i)) {
                                values.push(i.value);
                            }
                        }
                    }
                },
            };
            
            // 3. 定义分割访问者
            const splitVisitor = {
                Property(path) {
                    const { node } = path;
                    if (values.length > 0) {
                        for (let value of values) {
                            if (node && (node.key.name == value || node.key.value == value) && node.value.elements) {
                                // 处理模块参数
                                const moduleParams = this.processModuleParams(node);
                                
                                // 处理节点元素
                                this.processNodeElements(node, value);
                            }
                        }
                    }
                }
            };
            
            // 添加方法到 splitVisitor
            splitVisitor.processModuleParams = function(node) {
                let _require = node.value.elements[0].params[0].name;
                let _module = node.value.elements[0].params[1].name;
                let _exports = node.value.elements[0].params[2].name;
                
                // 创建变量声明
                let id1 = types.identifier(`${_require}`);
                let id2 = types.identifier(`${_module}`);
                let id3 = types.identifier(`${_exports}`);
                let init1 = types.identifier("require");
                let init2 = types.identifier("module");
                let init3 = types.identifier("exports");
                let variable1 = types.variableDeclarator(id1, init1);
                let declaration1 = types.variableDeclaration("let", [variable1]);
                let variable2 = types.variableDeclarator(id2, init2);
                let declaration2 = types.variableDeclaration("let", [variable2]);
                let variable3 = types.variableDeclarator(id3, init3);
                let declaration3 = types.variableDeclaration("let", [variable3]);
                
                // 将声明添加到节点
                node.value.elements[0].body.body.unshift(declaration1, declaration2, declaration3);
                
                return { _require, _module, _exports };
            };
            
            splitVisitor.processNodeElements = function(node, value) {
                for (let i of node.value.elements[0].body.body) {
                    // 生成元数据文件
                    this.generateMetaFiles(i);
                    
                    // 处理导入路径
                    this.processImportPaths(i);
                }
                
                // 保存 AST 到文件
                this.saveAstToFile(node, value);
            };
            
            splitVisitor.generateMetaFiles = function(node) {
                if (node.type == 'ExpressionStatement') {
                    // 处理表达式数组
                    if (node.expression.expressions) {
                        for (let a of node.expression.expressions) {
                            if (a.arguments && a.arguments.length == 3) {
                                if (a.arguments[1]) {
                                    if (a.arguments[1].type && a.arguments[1].type == "StringLiteral" && a.arguments[1].value != "__esModule") {
                                        let filename = a.arguments[2].value.split('.')[0] + ".ts";
                                        
                                        let fileMap = new Set();
                                        fileMap[filename] = uuidUtils.decodeUuid(uuidUtils.original_uuid(a.arguments[1].value));
                                        fileManager.createMetaFile(fileMap);
                                    }
                                }
                            }
                        }
                    }
                    
                    // 处理单个表达式
                    if (node.expression.arguments && node.expression.arguments.length == 3) {
                        if (node.expression.arguments[1]) {                                        
                            if (node.expression.arguments[1].type && node.expression.arguments[1].type == "StringLiteral" && node.expression.arguments[1].value != "__esModule") {
                                let filename = node.expression.arguments[2].value.split('.')[0] + ".ts";
                                let fileMap = new Set();
                                fileMap[filename] = uuidUtils.decodeUuid(uuidUtils.original_uuid(node.expression.arguments[1].value));
                                fileManager.createMetaFile(fileMap);
                            }
                        }
                    }
                }
            };
            
            splitVisitor.processImportPaths = function(node) {
                // 处理变量声明中的导入路径
                if (node.type == 'VariableDeclaration' && node.declarations) {
                    for (let j of node.declarations) {
                        if (j.init) {
                            // 处理初始化表达式的参数
                            if (j.type == "VariableDeclarator" && j.init.arguments) {
                                if (j.init.arguments[0] && j.init.arguments[0].value) {
                                    j.init.arguments[0].value = path.basename(j.init.arguments[0].value);
                                }
                            }
                            
                            // 处理初始化表达式序列
                            if (j.type == "VariableDeclarator" && j.init.expressions) {
                                for (let res of j.init.expressions) {
                                    if (res.type == "CallExpression") {
                                        if (res.arguments && res.arguments[0] && res.arguments[0].value) {
                                            if (typeof res.arguments[0].value == "string") {
                                                res.arguments[0].value = path.basename(res.arguments[0].value);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // 处理表达式语句中的导入路径
                if (node.type == 'ExpressionStatement' && node.expression) {
                    if (node.expression.type == "CallExpression" && node.expression.arguments) {
                        let res = node.expression.arguments;
                        if (res[0] && typeof res[0].value == "string") {
                            res[0].value = path.basename(res[0].value);
                        }
                    }
                }
            };
            
            splitVisitor.saveAstToFile = async function(node, value) {
                try {
                    const str = JSON.stringify(node.value.elements[0].body);
                    const astPath = path.join(global.paths.ast, `${value}.json`);
                    
                    // 写入文件
                    await writeFile(astPath, str, { flag: 'w+' });
                    
                    if (global.verbose) {
                        logger.debug(`保存 AST 到文件: ${astPath}`);
                    }
                } catch (err) {
                    logger.error(`保存 AST 到文件时出错:`, err);
                }
            };
            
            // 遍历 AST
            await traverse.default(ast, findValue);
            await traverse.default(ast, splitVisitor);
            
            // 处理 AST 文件生成代码
            await this.processAstFiles();
            
            logger.info('代码分析完成');
        } catch (err) {
            logger.error('分析编译代码时出错:', err);
            throw err;
        }
    },
    
    /**
     * 处理 AST 文件生成代码
     */
    async processAstFiles() {
        try {
            const astFiles = await fileManager.readDirectory(global.paths.ast);
            
            for (const file of astFiles) {
                const fullPath = path.join(global.paths.ast, file);
                const content = await fileManager.readFile(fullPath);
                
                try {
                    const key = path.basename(file, '.json');
                    await this.generateCode(JSON.parse(content), key);
                } catch (err) {
                    logger.error(`处理 AST 文件 ${file} 时出错:`, err);
                }
            }
        } catch (err) {
            logger.error('处理 AST 文件时出错:', err);
            throw err;
        }
    },
    
    /**
     * 从 AST 生成代码
     * @param {Object} ast AST 对象
     * @param {string} filename 文件名
     */
    async generateCode(ast, filename) {
        try {
            // 生成代码
            let res = generator.default(ast, {})["code"];
            const scriptsDir = path.join(global.paths.output, 'assets/Scripts');
            const outputPath = path.join(scriptsDir, `${filename}.ts`);
            
            // 确保输出目录存在
            await mkdir(path.dirname(outputPath), { recursive: true });
            
            // 写入生成的代码
            await appendFile(
                outputPath, 
                JSON.parse(JSON.stringify(res.slice(1, res.length - 1))), 
                { encoding: "utf-8", flag: 'w+' }
            );
            
            // 生成元数据文件
            this.generateMetaFile(filename);
            
            if (global.verbose) {
                logger.debug(`生成代码文件: ${filename}.ts`);
            }
        } catch (err) {
            logger.error(`生成代码 ${filename} 时出错:`, err);
        }
    },
    
    /**
     * 生成元数据文件
     * @param {string} filename 文件名
     */
    generateMetaFile(filename) {
        const meta = {
            "ver": "1.0.8",
            "uuid": uuidUtils.decodeUuid(uuidUtils.original_uuid(filename)),
            "isPlugin": false,
            "loadPluginInWeb": true,
            "loadPluginInNative": true,
            "loadPluginInEditor": false,
            "subMetas": {}
        };
        
        fileManager.writeFile("Scripts", filename + ".ts.meta", meta);
    }
};

module.exports = { codeAnalyzer }; 