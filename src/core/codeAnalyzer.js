/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 代码分析和生成工具
 */
const generator = require('@babel/generator');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const types = require('@babel/types');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uuidUtils } = require('../utils/uuidUtils');
const { fileManager } = require('../utils/fileManager');
const { logger } = require('../utils/logger');
const { forEachPool, getMaxParallel } = require('../utils/asyncPool');

/**
 * 代码分析器模块
 */
const codeAnalyzer = {
  _metaWrites: [],

  /**
   * 分析编译源代码
   * @param {string} code 要分析的源代码
   * @returns {Promise<void>}
   */
  async analyze(code) {
    try {
      this._metaWrites = [];
      // 1. 解析代码为 AST
      const ast = parser.parse(code);
      const values = [];
      // 内存中保存模块 body，避免 AST 落盘再读
      const modules = new Map(); // moduleName -> body AST node

      // 2. 收集模块名（字符串数组）
      const findValue = {
        ArrayExpression(path) {
          const { node } = path;
          if (node && node.elements) {
            for (const el of node.elements) {
              if (types.isStringLiteral(el)) {
                values.push(el.value);
              }
            }
          }
        },
      };

      // 辅助 — 处理模块参数，把 require/module/exports 注入函数体
      const processModuleParams = function (node) {
        const params = node.value.elements[0].params;
        const _require = params[0].name;
        const _module = params[1].name;
        const _exports = params[2].name;

        const declaration1 = types.variableDeclaration('let', [
          types.variableDeclarator(types.identifier(_require), types.identifier('require')),
        ]);
        const declaration2 = types.variableDeclaration('let', [
          types.variableDeclarator(types.identifier(_module), types.identifier('module')),
        ]);
        const declaration3 = types.variableDeclaration('let', [
          types.variableDeclarator(types.identifier(_exports), types.identifier('exports')),
        ]);

        node.value.elements[0].body.body.unshift(declaration1, declaration2, declaration3);
        return { _require, _module, _exports };
      };

      // 辅助 — 生成脚本 meta（同步登记，异步写文件由 createMetaFile 完成）
      const metaEntries = {};
      const generateMetaFiles = function (node) {
        if (node.type !== 'ExpressionStatement') return;

        const record = (args) => {
          if (!args || args.length !== 3) return;
          if (!args[1] || args[1].type !== 'StringLiteral') return;
          if (args[1].value === '__esModule') return;
          if (!args[2] || typeof args[2].value !== 'string') return;

          const filename = args[2].value.split('.')[0] + '.ts';
          metaEntries[filename] = uuidUtils.decodeUuid(uuidUtils.original_uuid(args[1].value));
        };

        if (node.expression.expressions) {
          for (const a of node.expression.expressions) {
            if (a.arguments) record(a.arguments);
          }
        }
        if (node.expression.arguments) {
          record(node.expression.arguments);
        }
      };

      // 辅助 — 处理导入路径（仅保留 basename）
      const processImportPaths = function (node) {
        if (node.type === 'VariableDeclaration' && node.declarations) {
          for (const j of node.declarations) {
            if (!j.init) continue;

            if (j.type === 'VariableDeclarator' && j.init.arguments) {
              if (j.init.arguments[0] && j.init.arguments[0].value) {
                j.init.arguments[0].value = path.basename(j.init.arguments[0].value);
              }
            }

            if (j.type === 'VariableDeclarator' && j.init.expressions) {
              for (const res of j.init.expressions) {
                if (res.type === 'CallExpression'
                    && res.arguments
                    && res.arguments[0]
                    && typeof res.arguments[0].value === 'string') {
                  res.arguments[0].value = path.basename(res.arguments[0].value);
                }
              }
            }
          }
        }

        if (node.type === 'ExpressionStatement' && node.expression) {
          if (node.expression.type === 'CallExpression' && node.expression.arguments) {
            const res = node.expression.arguments;
            if (res[0] && typeof res[0].value === 'string') {
              res[0].value = path.basename(res[0].value);
            }
          }
        }
      };

      // 3. 分割访问者：按模块名切开 project.js
      const splitVisitor = {
        Property(path) {
          const { node } = path;
          if (values.length === 0 || !node || !node.value || !node.value.elements) return;

          for (const value of values) {
            if (node.key.name === value || node.key.value === value) {
              processModuleParams(node);

              for (const stmt of node.value.elements[0].body.body) {
                generateMetaFiles(stmt);
                processImportPaths(stmt);
              }

              // 内存保存，不落盘
              modules.set(value, node.value.elements[0].body);
            }
          }
        },
      };

      traverse.default(ast, findValue);
      traverse.default(ast, splitVisitor);

      // 批量写 meta
      if (Object.keys(metaEntries).length > 0) {
        await fileManager.createMetaFile(metaEntries);
      }

      // 从内存直接生成代码
      await this.generateModules(modules);

      // 等待脚本 meta 写完
      if (this._metaWrites.length > 0) {
        await Promise.all(this._metaWrites);
        this._metaWrites = [];
      }

      // verbose 时可选落盘 AST 便于调试
      if (global.verbose && global.paths?.ast) {
        await fsp.mkdir(global.paths.ast, { recursive: true });
        for (const [name, body] of modules) {
          const astPath = path.join(global.paths.ast, `${name}.json`);
          await fsp.writeFile(astPath, JSON.stringify(body));
        }
      }

      logger.info(`代码分析完成，共 ${modules.size} 个模块`);
    } catch (err) {
      logger.error('分析编译代码时出错:', err);
      throw err;
    }
  },

  /**
   * 从内存中的模块 AST 并发生成代码
   * @param {Map<string, object>} modules
   */
  async generateModules(modules) {
    const entries = [...modules.entries()];
    const concurrency = getMaxParallel();

    await forEachPool(entries, concurrency, async ([filename, bodyAst]) => {
      await this.generateCode(bodyAst, filename);
    });
  },

  /**
   * 从 AST 生成代码
   * @param {Object} ast AST 对象（模块 body）
   * @param {string} filename 文件名
   */
  async generateCode(ast, filename) {
    try {
      const res = generator.default(ast, {}).code;
      // Babel 对 BlockStatement 会包一层 `{}`，去掉首尾花括号
      let code = res;
      if (code.startsWith('{') && code.endsWith('}')) {
        code = code.slice(1, -1);
      }

      const scriptsDir = path.join(global.paths.output, 'assets/Scripts');
      const outputPath = path.join(scriptsDir, `${filename}.ts`);

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, code, 'utf-8');

      this.generateMetaFile(filename);

      if (global.verbose) {
        logger.debug(`生成代码文件: ${filename}.ts`);
      }
    } catch (err) {
      logger.error(`生成代码 ${filename} 时出错:`, err);
    }
  },

  /**
   * 生成元数据文件（登记到 _metaWrites，analyze 末尾统一 await）
   * @param {string} filename 文件名
   */
  generateMetaFile(filename) {
    const meta = {
      ver: '1.0.8',
      uuid: uuidUtils.decodeUuid(uuidUtils.original_uuid(filename)),
      isPlugin: false,
      loadPluginInWeb: true,
      loadPluginInNative: true,
      loadPluginInEditor: false,
      subMetas: {},
    };

    this._metaWrites.push(
      fileManager.writeFile('Scripts', `${filename}.ts.meta`, meta).catch((err) => {
        logger.error(`写入脚本 meta ${filename}.ts.meta 失败:`, err);
      }),
    );
  },
};

module.exports = { codeAnalyzer };
