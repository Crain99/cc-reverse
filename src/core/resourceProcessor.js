/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 资源处理工具
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uuidUtils } = require('../utils/uuidUtils');
const { fileManager } = require('../utils/fileManager');
const { logger } = require('../utils/logger');
const { converters } = require('./converters');
const { forEachPool, mapPool, getMaxParallel } = require('../utils/asyncPool');

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
  // 异步写文件任务队列（handler 同步登记，processResources 末尾统一 flush）
  _writeQueue: [],

  // 资源映射
  sceneAssets: [],
  spriteFrames: {},
  audio: [],
  animation: [],

  // 类型处理器注册表
  typeHandlers: new Map(),

  /**
   * 获取 Cocos 配置对象
   * @returns {Object}
   */
  getCCSettings() {
    if (!global.settings) {
      return {};
    }
    return global.settings.CCSettings || global.settings;
  },

  /**
   * 登记一次异步写，避免 handler 忘记 await 导致文件未落盘
   * @param {string} directory
   * @param {string} filename
   * @param {any} data
   */
  enqueueWrite(directory, filename, data) {
    this._writeQueue.push(fileManager.writeFile(directory, filename, data));
  },

  /**
   * 等待所有已登记写操作完成
   */
  async flushWrites() {
    if (this._writeQueue.length === 0) return;
    const pending = this._writeQueue;
    this._writeQueue = [];
    await Promise.all(pending);
  },

  /**
   * 处理资源文件
   * @returns {Promise<void>}
   */
  async processResources() {
    try {
      this.resetState();

      await this.readFiles(global.paths.res, true);
      await this.convertToOutputFiles();
      await this.flushWrites();

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
    this._writeQueue = [];
    this.initHandlers();
  },

  /**
   * 注册类型处理器
   * @param {string} type 类型名称
   * @param {Function} handler 处理函数 (data, key, context) => void
   */
  registerHandler(type, handler) {
    this.typeHandlers.set(type, handler);
  },

  /**
   * 初始化默认类型处理器
   */
  initHandlers() {
    this.typeHandlers = new Map();
    this.registerHandler('cc.SceneAsset', (data, key, ctx) => this.processSceneAsset(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.SpriteFrame', (data, key, ctx) => this.processSpriteFrame(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.AudioClip', (data, key) => this.processAudioClip(data, key));
    this.registerHandler('cc.TextAsset', (data, key) => this.processTextAsset(data, key));
    this.registerHandler('cc.AnimationClip', (data, key) => this.processAnimationClip(data, key));
    this.registerHandler('sp.SkeletonData', (data, key) => this.processSpineSkeletonData(data, key));
    this.registerHandler('dragonBones.DragonBonesAsset', (data, key) => this.processDragonBonesAsset(data, key));
    this.registerHandler('dragonBones.DragonBonesAtlasAsset', (data, key) => this.processDragonBonesAtlasAsset(data, key));
  },

  /**
   * 从文件路径中提取不含扩展名的键名
   * @param {string} filePath 文件路径
   * @returns {string} 键名
   */
  getKeyFromPath(filePath) {
    const basename = path.basename(filePath);
    return basename.substring(0, basename.lastIndexOf('.')) || basename;
  },

  /**
   * 递归读取目录下所有文件
   * @param {string} filePath 文件路径
   * @param {boolean} first 是否为首次调用
   * @returns {Promise<void>}
   */
  async readFiles(filePath, first) {
    try {
      const entries = await fsp.readdir(filePath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(filePath, entry.name);
        if (entry.isFile()) {
          this.fileList.push(fullPath);
          this.fileMap.set(this.getKeyFromPath(fullPath), fullPath);
        } else if (entry.isDirectory()) {
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
    const settings = this.getCCSettings();
    if (!this.isEmptyObject(settings.subpackages)) {
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
   * 处理 JSON 文件：并行读盘+解析，串行 processData
   * （processSceneAsset 依赖完整 nodeData，不能边读边处理）
   * @returns {Promise<void>}
   */
  async processJsonFiles() {
    const jsonFiles = this.fileList.filter((p) => path.extname(p) === '.json');
    const concurrency = getMaxParallel();

    const parsed = await mapPool(jsonFiles, concurrency, async (currPath) => {
      try {
        const currFile = await fsp.readFile(currPath, 'utf-8');
        const key = this.getKeyFromPath(currPath);
        return { key, data: JSON.parse(currFile), path: currPath };
      } catch (err) {
        logger.error(`读取 JSON 文件 ${currPath} 时出错:`, err);
        return null;
      }
    });

    for (const item of parsed) {
      if (!item) continue;
      this.nodeData[item.key] = item.data;
    }

    for (const item of parsed) {
      if (!item) continue;
      try {
        await this.processData(item.key, item.data);
      } catch (err) {
        logger.error(`处理 JSON 文件 ${item.path} 时出错:`, err);
      }
    }
  },

  /**
   * 检查对象是否为空
   * @param {Object} obj
   * @returns {boolean}
   */
  isEmptyObject(obj) {
    if (obj == null || typeof obj !== 'object') return true;
    for (const key in obj) {
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
   * @param {Object} jsonObject
   * @returns {Promise<Object>}
   */
  async revealData(jsonObject) {
    if (!jsonObject || typeof jsonObject !== 'object') return jsonObject;

    if (Array.isArray(jsonObject)) {
      return this.restoreCompressedData(jsonObject);
    }

    this.decodeUuids(jsonObject);
    return jsonObject;
  },

  isCompressedFormat(data) {
    if (!Array.isArray(data) || data.length < 2) return false;
    const header = data[0];
    return Array.isArray(header) && header.length > 0 && typeof header[0] === 'string';
  },

  restoreCompressedData(data) {
    if (!this.isCompressedFormat(data)) {
      this.resolveReferences(data);
      this.decodeUuids(data);
      return data;
    }

    const { typeDefinitions } = require('./typeDefinitions');
    const typeList = data[0];
    const result = [typeList];

    for (let i = 1; i < data.length; i++) {
      const item = data[i];
      if (Array.isArray(item) && item.length > 0 && typeof item[0] === 'number') {
        const typeIndex = item[0];
        const typeName = typeList[typeIndex];
        if (typeName) {
          const obj = this.arrayToObject(typeName, item.slice(1), typeDefinitions);
          result.push(obj);
        } else {
          result.push(item);
        }
      } else if (typeof item === 'object' && item !== null) {
        result.push(item);
      } else {
        result.push(item);
      }
    }

    this.resolveReferences(result);
    this.decodeUuids(result);
    return result;
  },

  arrayToObject(typeName, values, typeDefinitions) {
    const settings = this.getCCSettings();
    let properties = null;

    if (settings && settings.types && settings.types[typeName]) {
      properties = settings.types[typeName];
    }

    if (!properties) {
      properties = typeDefinitions.getProperties(typeName);
    }

    if (!properties) {
      return { __type__: typeName, _values: values };
    }

    const obj = { __type__: typeName };
    for (let i = 0; i < values.length && i < properties.length; i++) {
      obj[properties[i]] = values[i];
    }
    return obj;
  },

  /**
   * 解析 {__id__: n} 为对象引用。
   * 使用已访问集合防止循环引用导致无限递归。
   */
  resolveReferences(data) {
    if (!Array.isArray(data)) return;

    const resolve = (obj, seen) => {
      if (!obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);

      for (const key in obj) {
        const val = obj[key];
        if (!val || typeof val !== 'object') continue;

        if (val.__id__ !== undefined && data[val.__id__] !== undefined) {
          obj[key] = data[val.__id__];
        } else if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            if (val[i] && val[i].__id__ !== undefined && data[val[i].__id__] !== undefined) {
              val[i] = data[val[i].__id__];
            } else if (val[i] && typeof val[i] === 'object') {
              resolve(val[i], seen);
            }
          }
        } else {
          resolve(val, seen);
        }
      }
    };

    const seen = new WeakSet();
    for (let i = 0; i < data.length; i++) {
      if (typeof data[i] === 'object' && data[i] !== null) {
        resolve(data[i], seen);
      }
    }
  },

  decodeUuids(data) {
    const walk = (obj, seen) => {
      if (!obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);

      if (obj.__uuid__ && typeof obj.__uuid__ === 'string' && obj.__uuid__.length === 22) {
        obj.__uuid__ = uuidUtils.decodeUuid(obj.__uuid__);
      }
      for (const key in obj) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          walk(obj[key], seen);
        }
      }
    };

    const seen = new WeakSet();
    if (Array.isArray(data)) {
      data.forEach((item) => walk(item, seen));
    } else {
      walk(data, seen);
    }
  },

  /**
   * 写入处理后的数据（同步分发 handler；写文件经 enqueueWrite 异步落盘）
   * @param {Object} data
   * @param {string} key
   */
  writeProcessedData(data, key) {
    if (!data || typeof data !== 'object') return;

    if (data.__type__) {
      const handler = this.typeHandlers.get(data.__type__);
      if (handler) handler(data, key, { parentData: data, index: null });
      return;
    }

    for (const i in data) {
      const item = data[i];
      if (!item || typeof item !== 'object') continue;

      if (Array.isArray(item)) {
        this.writeProcessedData(item, key);
      } else if (item.__type__) {
        const handler = this.typeHandlers.get(item.__type__);
        if (handler) handler(item, key, { parentData: data, index: i });
      }
    }
  },

  processAudioClip(data, key) {
    const name = data._name + data._native;
    const _mkdir = 'Audio';
    const uuid = key;
    const metaData = {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    };

    if (this.fileMap.has(uuid)) {
      const writePath = name;
      const currPath = this.fileMap.get(uuid);

      this.cacheReadList.push(currPath);
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, writePath));
      this.fileMap.delete(uuid);
    }

    this.enqueueWrite(_mkdir, name + '.meta', metaData);
    this.audio.push(data);
  },

  processTextAsset(data, key) {
    const name = data._name + '.json';
    const uuid = key;
    const _mkdir = 'resource';
    const metaData = {
      ver: '1.2.7',
      uuid,
      subMetas: {},
    };

    this.enqueueWrite(_mkdir, name, data);
    this.enqueueWrite(_mkdir, name + '.meta', metaData);
  },

  processAnimationClip(data, key) {
    const name = data._name;
    const _mkdir = 'Animation';
    const filename = name + '.anim';

    this.enqueueWrite(_mkdir, filename, data);
    this.animation.push(data);

    const uuid = key;
    const metaData = {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    };

    this.enqueueWrite(_mkdir, filename + '.meta', metaData);
  },

  processSceneAsset(data, index, key) {
    if (!Array.isArray(data) || data.length === 0 || !data[0]) return;
    const filename = data[0]._name + '.fire';
    const _mkdir = 'Scene';

    this.sceneAssets.push(JSON.stringify(data));
    this.enqueueWrite(_mkdir, filename, data);

    for (const dataKey in this.nodeData) {
      const nodeDataEntry = this.nodeData[dataKey];
      for (const j in nodeDataEntry) {
        if (Array.isArray(nodeDataEntry[j]) && nodeDataEntry[j].length > 0 && nodeDataEntry[j][0]) {
          if (nodeDataEntry[j][0]._name == data[0]._name) {
            const uuid = uuidUtils.decodeUuid(this.createLibrary(j, dataKey));
            const metaData = {
              ver: '1.2.7',
              uuid,
              optimizationPolicy: 'AUTO',
              asyncLoadAssets: false,
              readonly: false,
              subMetas: {},
            };
            this.enqueueWrite(_mkdir, filename + '.meta', metaData);
          }
        }
      }
    }
  },

  processSpriteFrame(data, index, key) {
    const spriteData = data[index] || data;
    const name = spriteData._name || key;
    this.spriteFrames[key] = spriteData;

    const outputMode = (global.config && global.config.assets && global.config.assets.spriteOutputMode) || 'single';

    if (outputMode === 'single') {
      this.processSpriteFrameSingle(spriteData, name, key);
    }
  },

  processSpriteFrameSingle(spriteData, name, key) {
    const _mkdir = 'Texture';

    let texUuid = null;
    if (spriteData.content && spriteData.content.atlas) {
      texUuid = spriteData.content.atlas.__uuid__ || spriteData.content.atlas;
    } else if (spriteData._texture) {
      texUuid = spriteData._texture.__uuid__ || spriteData._texture;
    }

    if (texUuid && this.fileMap.has(texUuid)) {
      this.cacheReadList.push(this.fileMap.get(texUuid));
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + '.png'));
      this.fileMap.delete(texUuid);
    } else if (this.fileMap.has(key)) {
      this.cacheReadList.push(this.fileMap.get(key));
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + '.png'));
      this.fileMap.delete(key);
    }

    const subMetas = {};
    subMetas[name] = {
      ver: '1.0.4',
      uuid: key,
      rawTextureUuid: texUuid || key,
      trimType: 'auto',
      trimThreshold: 1,
      rotated: spriteData._rotated || false,
      offsetX: spriteData._offset ? spriteData._offset.x || 0 : 0,
      offsetY: spriteData._offset ? spriteData._offset.y || 0 : 0,
      trimX: spriteData._rect ? spriteData._rect.x || 0 : 0,
      trimY: spriteData._rect ? spriteData._rect.y || 0 : 0,
      width: spriteData._rect ? spriteData._rect.width || 0 : 0,
      height: spriteData._rect ? spriteData._rect.height || 0 : 0,
      rawWidth: spriteData._originalSize ? spriteData._originalSize.width || 0 : 0,
      rawHeight: spriteData._originalSize ? spriteData._originalSize.height || 0 : 0,
      borderTop: 0,
      borderBottom: 0,
      borderLeft: 0,
      borderRight: 0,
      subMetas: {},
    };

    const metaData = {
      ver: '1.2.7',
      uuid: texUuid || key,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas,
    };
    this.enqueueWrite(_mkdir, name + '.png.meta', metaData);
  },

  processDragonBonesAsset(data, key) {
    const name = data._name;
    const _mkdir = 'DragonBones';
    const uuid = key;

    if (data._dragonBonesJson) {
      this.enqueueWrite(_mkdir, name + '_ske.json', data._dragonBonesJson);
    } else if (this.fileMap.has(uuid)) {
      this.cacheReadList.push(this.fileMap.get(uuid));
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data._native || '_ske.json')));
      this.fileMap.delete(uuid);
    }

    const metaData = {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    };
    this.enqueueWrite(_mkdir, name + '_ske.json.meta', metaData);
  },

  processDragonBonesAtlasAsset(data, key) {
    const name = data._name;
    const _mkdir = 'DragonBones';
    const uuid = key;

    if (data._textureAtlasData) {
      this.enqueueWrite(_mkdir, name + '_tex.json', data._textureAtlasData);
    } else if (this.fileMap.has(uuid)) {
      this.cacheReadList.push(this.fileMap.get(uuid));
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data._native || '_tex.json')));
      this.fileMap.delete(uuid);
    }

    const texRef = data._texture;
    if (texRef) {
      const texUuid = texRef.__uuid__ || texRef;
      if (this.fileMap.has(texUuid)) {
        this.cacheReadList.push(this.fileMap.get(texUuid));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + '_tex.png'));
        this.fileMap.delete(texUuid);
      }
    }

    const metaData = {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    };
    this.enqueueWrite(_mkdir, name + '_tex.json.meta', metaData);
  },

  createLibrary(index, key) {
    const settings = this.getCCSettings();
    if (settings.uuids) {
      return settings.uuids[key] || uuidUtils.generateUuid();
    }
    return uuidUtils.generateUuid();
  },

  async convertToOutputFiles() {
    await this.copyFiles();
    await converters.convertSpriteAtlas(this.spriteFrames);
    logger.info(`处理了 ${this.cacheReadList.length} 个资源文件`);
  },

  processSpineSkeletonData(data, key) {
    const name = data._name;
    const _mkdir = 'Spine';
    const uuid = key;

    if (data._skeletonJson) {
      this.enqueueWrite(_mkdir, name + '.json', data._skeletonJson);
    } else if (this.fileMap.has(uuid)) {
      this.cacheReadList.push(this.fileMap.get(uuid));
      this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data._native || '.json')));
      this.fileMap.delete(uuid);
    }

    if (data._atlasText) {
      this.enqueueWrite(_mkdir, name + '.atlas', data._atlasText);
    }

    if (data.textures && Array.isArray(data.textures)) {
      data.textures.forEach((tex, i) => {
        const texUuid = tex.__uuid__ || tex;
        if (this.fileMap.has(texUuid)) {
          const ext = i === 0 ? '.png' : `_${i}.png`;
          this.cacheReadList.push(this.fileMap.get(texUuid));
          this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + ext));
          this.fileMap.delete(texUuid);
        }
      });
    }

    const metaData = {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    };
    this.enqueueWrite(_mkdir, name + '.json.meta', metaData);
  },

  /**
   * 限流并发复制文件
   */
  async copyFiles() {
    try {
      const concurrency = getMaxParallel();
      const pairs = this.cacheReadList.map((src, i) => ({
        sourcePath: src,
        targetPath: this.cacheWriteList[i],
      }));

      await forEachPool(pairs, concurrency, async ({ sourcePath, targetPath }) => {
        await fileManager.ensureDirectoryExists(path.dirname(targetPath));
        await fileManager.copyFile(sourcePath, targetPath);
        if (global.verbose) {
          logger.debug(`复制文件: ${path.basename(sourcePath)} -> ${targetPath}`);
        }
      });
    } catch (err) {
      logger.error('复制文件时出错:', err);
      throw err;
    }
  },
};

module.exports = { resourceProcessor };
