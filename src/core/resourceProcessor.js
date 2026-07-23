/*
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 资源处理工具
 *
 * 2.x import 布局要点：
 * - 普通文档：单对象 / 对象数组（共享 __id__ 空间，如 .prefab / .fire）
 * - packedAssets：一个 json 数组，每项是独立资源（对象）或完整子文档（嵌套数组）
 * - settings.packedAssets[packId][i] 给出第 i 项的 uuid（可为 uuids[] 下标）
 * - settings.rawAssets 给出原生路径；raw-assets/<uuid前2位>/<uuid>.ext
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
  fileList: [],
  fileMap: new Map(),
  // decodedUuid / compactUuid / basename → absolute path (raw-assets + imports)
  nativeMap: new Map(),
  cacheReadList: [],
  cacheWriteList: [],
  nodeData: {},
  _writeQueue: [],

  sceneAssets: [],
  spriteFrames: {},
  audio: [],
  animation: [],
  prefabs: [],

  // settings-derived indexes
  _uuidList: [],
  _packedMap: {}, // packKey → uuidRef[]
  _rawAssetMap: new Map(), // compact|decoded|index → { path, type, typeName }
  _handledUuids: new Set(),

  typeHandlers: new Map(),

  getCCSettings() {
    if (!global.settings) return {};
    return global.settings.CCSettings || global.settings;
  },

  enqueueWrite(directory, filename, data) {
    this._writeQueue.push(fileManager.writeFile(directory, filename, data));
  },

  async flushWrites() {
    if (this._writeQueue.length === 0) return;
    const pending = this._writeQueue;
    this._writeQueue = [];
    await Promise.all(pending);
  },

  async processResources() {
    try {
      this.resetState();
      this.buildSettingsIndex();

      await this.readFiles(global.paths.res, true);
      await this.convertToOutputFiles();
      await this.flushWrites();

      logger.info(
        `资源处理完成 (scenes=${this.sceneAssets.length}, sprites=${Object.keys(this.spriteFrames).length}, audio=${this.audio.length}, prefabs=${this.prefabs.length}, copies=${this.cacheReadList.length})`,
      );
    } catch (err) {
      logger.error('处理资源文件时出错:', err);
      throw err;
    }
  },

  resetState() {
    this.fileList = [];
    this.fileMap = new Map();
    this.nativeMap = new Map();
    this.cacheReadList = [];
    this.cacheWriteList = [];
    this.nodeData = {};
    this.sceneAssets = [];
    this.spriteFrames = {};
    this.audio = [];
    this.animation = [];
    this.prefabs = [];
    this._writeQueue = [];
    this._uuidList = [];
    this._packedMap = {};
    this._rawAssetMap = new Map();
    this._handledUuids = new Set();
    this.initHandlers();
  },

  registerHandler(type, handler) {
    this.typeHandlers.set(type, handler);
  },

  initHandlers() {
    this.typeHandlers = new Map();
    this.registerHandler('cc.SceneAsset', (data, key, ctx) => this.processSceneAsset(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.Prefab', (data, key, ctx) => this.processPrefabAsset(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.SpriteFrame', (data, key, ctx) => {
      // writeProcessedData passes (item, key, ctx); item is the spriteframe
      this.processSpriteFrame(data, key, ctx);
    });
    this.registerHandler('cc.AudioClip', (data, key) => this.processAudioClip(data, key));
    this.registerHandler('cc.TextAsset', (data, key) => this.processTextAsset(data, key));
    this.registerHandler('cc.AnimationClip', (data, key) => this.processAnimationClip(data, key));
    this.registerHandler('cc.LabelAtlas', (data, key) => this.processLabelAtlas(data, key));
    this.registerHandler('sp.SkeletonData', (data, key) => this.processSpineSkeletonData(data, key));
    this.registerHandler('dragonBones.DragonBonesAsset', (data, key) => this.processDragonBonesAsset(data, key));
    this.registerHandler('dragonBones.DragonBonesAtlasAsset', (data, key) => this.processDragonBonesAtlasAsset(data, key));
  },

  /**
   * 从 settings 构建 uuid / packed / rawAssets 索引
   */
  buildSettingsIndex() {
    const settings = this.getCCSettings();
    this._uuidList = Array.isArray(settings.uuids) ? settings.uuids : [];
    this._packedMap = settings.packedAssets && typeof settings.packedAssets === 'object'
      ? settings.packedAssets
      : {};

    const assetTypes = Array.isArray(settings.assetTypes) ? settings.assetTypes : [];
    const rawAssets = settings.rawAssets || {};

    for (const group of Object.keys(rawAssets)) {
      const table = rawAssets[group] || {};
      for (const key of Object.keys(table)) {
        const entry = table[key];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const relPath = entry[0];
        const typeIndex = entry[1];
        const typeName = assetTypes[typeIndex] || null;
        const info = { path: relPath, type: typeIndex, typeName, group };

        // key may be uuids[] index or compact uuid
        const compact = this.expandUuidRef(key);
        const decoded = this.decodeMaybe(compact);
        this._rawAssetMap.set(String(key), info);
        if (compact != null) this._rawAssetMap.set(String(compact), info);
        if (decoded) this._rawAssetMap.set(decoded, info);
      }
    }

    if (global.verbose) {
      logger.debug(
        `settings index: uuids=${this._uuidList.length}, packs=${Object.keys(this._packedMap).length}, rawAssets=${this._rawAssetMap.size}`,
      );
    }
  },

  /**
   * packedAssets / scenes 里的 uuid 引用：数字或数字字符串 → uuids[i]
   */
  expandUuidRef(ref) {
    if (ref == null) return null;
    if (typeof ref === 'number') {
      return this._uuidList[ref] != null ? this._uuidList[ref] : String(ref);
    }
    const s = String(ref);
    if (/^\d+$/.test(s) && this._uuidList[Number(s)] != null) {
      return this._uuidList[Number(s)];
    }
    return s;
  },

  decodeMaybe(compact) {
    if (compact == null) return null;
    const s = String(compact);
    if (s.length === 22) return uuidUtils.decodeUuid(s) || s;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      return s.toLowerCase();
    }
    return s;
  },

  getKeyFromPath(filePath) {
    const basename = path.basename(filePath);
    return basename.substring(0, basename.lastIndexOf('.')) || basename;
  },

  async readFiles(filePath, first) {
    try {
      const entries = await fsp.readdir(filePath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(filePath, entry.name);
        if (entry.isFile()) {
          this.fileList.push(fullPath);
          const key = this.getKeyFromPath(fullPath);
          this.fileMap.set(key, fullPath);
          this.indexNativeFile(fullPath, key);
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
   * Index native files under raw-assets by multiple key forms.
   */
  indexNativeFile(fullPath, key) {
    const base = path.basename(fullPath);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;

    const add = (k) => {
      if (k != null && k !== '') this.nativeMap.set(String(k), fullPath);
    };

    add(key);
    add(stem);
    add(base);

    // full uuid filename
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) {
      add(stem.toLowerCase());
      // also try compress? not needed for lookup from decoded
    }

    // short hash names like 18858a142
    if (/^[0-9a-f]{8,12}$/i.test(stem)) {
      add(stem);
    }
  },

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
   * 处理 JSON 文件：并行读盘，串行拆包/分发
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
        await this.processImportFile(item.key, item.data, item.path);
      } catch (err) {
        logger.error(`处理 JSON 文件 ${item.path} 时出错:`, err);
      }
    }
  },

  isEmptyObject(obj) {
    if (obj == null || typeof obj !== 'object') return true;
    for (const key in obj) {
      return false;
    }
    return true;
  },

  /**
   * 判断是否为 packedAssets 映射到的多资源包
   */
  isPackedImportKey(key) {
    return Object.prototype.hasOwnProperty.call(this._packedMap, key);
  },

  /**
   * 处理单个 import JSON（可能是 packed 或独立文档）
   */
  async processImportFile(key, data, filePath) {
    if (!global.settings || this.isEmptyObject(global.settings)) {
      logger.warn('全局设置为空，跳过数据处理');
      return;
    }

    // Texture2D serialized as { type, data } — skip binary blob meta
    if (data && typeof data === 'object' && !Array.isArray(data) && data.type === 'cc.Texture2D') {
      return;
    }

    if (this.isPackedImportKey(key) && Array.isArray(data)) {
      await this.processPackedImport(key, data);
      return;
    }

    // Standalone document
    if (Array.isArray(data)) {
      // Prefab / scene-like document (shared __id__ space)
      if (this.isDocumentArray(data)) {
        this.processDocumentArray(data, key);
        return;
      }
      // Compressed type-table format
      if (this.isCompressedFormat(data)) {
        const restored = this.restoreCompressedData(data);
        this.dispatchRestoredArray(restored, key);
        return;
      }
      // Plain array of independent objects (treat like packed without uuid list)
      await this.processPackedImport(key, data);
      return;
    }

    if (data && typeof data === 'object' && data.__type__) {
      this.decodeUuids(data);
      this.dispatchAsset(data, key, data);
    }
  },

  /**
   * 对象数组且首项是 SceneAsset/Prefab → 整文档共享 __id__
   */
  isDocumentArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const first = arr[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
    const t = first.__type__;
    return t === 'cc.SceneAsset' || t === 'cc.Prefab' || t === 'cc.Scene';
  },

  /**
   * packed import：逐项拆出独立资源
   */
  async processPackedImport(packKey, items) {
    const uuidRefs = this._packedMap[packKey] || [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item == null) continue;

      const uuidRef = uuidRefs[i] != null ? uuidRefs[i] : `${packKey}_${i}`;
      const compact = this.expandUuidRef(uuidRef);
      const uuid = this.decodeMaybe(compact) || String(compact);

      if (Array.isArray(item)) {
        // Nested document (scene / prefab) — keep local __id__ space, do NOT
        // resolveReferences across the outer pack.
        this.processDocumentArray(item, uuid);
      } else if (item && typeof item === 'object') {
        if (item.__type__) {
          this.decodeUuids(item);
          this.dispatchAsset(item, uuid, item);
        } else if (item.type === 'cc.Texture2D') {
          // skip
        } else {
          // unknown object — still try decode
          this.decodeUuids(item);
        }
      }
    }
  },

  /**
   * 处理共享 __id__ 的文档数组（场景 / 预制体）
   * 保留 {__id__}，只解码 uuid。
   */
  processDocumentArray(doc, uuidKey) {
    if (!Array.isArray(doc) || doc.length === 0) return;

    // Deep clone so we never mutate nodeData / shared pack entries
    const clone = JSON.parse(JSON.stringify(doc));
    this.decodeUuids(clone);

    const root = clone[0];
    const rootType = root && root.__type__;

    if (rootType === 'cc.SceneAsset') {
      this.writeSceneDocument(clone, uuidKey);
      return;
    }
    if (rootType === 'cc.Prefab') {
      this.writePrefabDocument(clone, uuidKey);
      return;
    }

    // Fallback: dispatch root if it has a handler; also walk for known types
    // without resolving cross-ids into object graphs.
    this.dispatchRestoredArray(clone, uuidKey);
  },

  writeSceneDocument(doc, uuidKey) {
    const name = (doc[0] && doc[0]._name) || 'Scene';
    const filename = `${name}.fire`;
    const dir = 'Scene';

    this.sceneAssets.push(JSON.stringify(doc));
    this.enqueueWrite(dir, filename, doc);

    const uuid = this.decodeMaybe(uuidKey) || uuidKey;
    this._handledUuids.add(String(uuid));
    this.enqueueWrite(dir, `${filename}.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });

    if (global.verbose) {
      logger.debug(`Scene: ${filename} (${doc.length} objects, uuid=${uuid})`);
    }
  },

  writePrefabDocument(doc, uuidKey) {
    const name = (doc[0] && doc[0]._name) || 'Prefab';
    const uuid = this.decodeMaybe(uuidKey) || uuidKey;
    this._handledUuids.add(String(uuid));
    this.prefabs.push(name);

    // Prefer path from rawAssets when available
    const raw = this._rawAssetMap.get(String(uuidKey))
      || this._rawAssetMap.get(String(uuid))
      || this._rawAssetMap.get(this.expandUuidRef(uuidKey));

    let dir = 'Prefab';
    let filename = `${name}.prefab`;
    if (raw && raw.path) {
      const base = path.basename(raw.path, path.extname(raw.path)) + '.prefab';
      const sub = path.dirname(raw.path).replace(/\\/g, '/');
      if (sub && sub !== '.') dir = path.posix.join('Prefab', sub);
      filename = base;
    }

    this.enqueueWrite(dir, filename, doc);
    this.enqueueWrite(dir, `${filename}.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
  },

  /**
   * 兼容旧路径：reveal + writeProcessedData
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
   * 解析数据对象（测试兼容：默认会 resolve __id__）
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
   * 将已 resolve 的对象数组重新编码为带 {__id__} 的可序列化结构。
   */
  toIdReferencedArray(data) {
    if (!Array.isArray(data)) return data;

    const objToId = new WeakMap();
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] && typeof data[i] === 'object') {
        objToId.set(data[i], i);
      }
    }

    const encode = (value, isRootElement, stack) => {
      if (!value || typeof value !== 'object') return value;

      if (!isRootElement && objToId.has(value)) {
        return { __id__: objToId.get(value) };
      }
      if (stack.has(value)) return undefined;

      stack.add(value);
      let result;
      if (Array.isArray(value)) {
        result = value.map((item) => encode(item, false, stack));
      } else {
        result = {};
        for (const k of Object.keys(value)) {
          const encoded = encode(value[k], false, stack);
          if (encoded !== undefined) result[k] = encoded;
        }
      }
      stack.delete(value);
      return result;
    };

    return data.map((item) => encode(item, true, new WeakSet()));
  },

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
      // SpriteFrame content.texture often stores compact uuid as plain string
      if (obj.content && typeof obj.content === 'object' && typeof obj.content.texture === 'string') {
        const t = obj.content.texture;
        if (t.length === 22) {
          obj.content.texture = uuidUtils.decodeUuid(t) || t;
        }
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
   * 分发已还原数组中的根级资源类型（不把整表当场景）
   */
  dispatchRestoredArray(data, key) {
    if (!Array.isArray(data)) {
      this.writeProcessedData(data, key);
      return;
    }
    // If it looks like a scene/prefab document, handle as document
    if (this.isDocumentArray(data)) {
      this.processDocumentArray(data, key);
      return;
    }
    for (let i = 0; i < data.length; i += 1) {
      const item = data[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (!item.__type__) continue;
      // Only dispatch top-level asset types, not every cc.Node inside a doc
      if (this.typeHandlers.has(item.__type__)) {
        this.dispatchAsset(item, key, data, i);
      }
    }
  },

  /**
   * 旧 writeProcessedData：遍历并分发（测试仍依赖）
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
        // Nested document array inside packed-like structure
        if (this.isDocumentArray(item)) {
          this.processDocumentArray(item, key);
        } else {
          this.writeProcessedData(item, key);
        }
      } else if (item.__type__) {
        const handler = this.typeHandlers.get(item.__type__);
        if (handler) handler(item, key, { parentData: data, index: i });
      }
    }
  },

  dispatchAsset(data, key, parentData, index) {
    if (!data || !data.__type__) return;
    const handler = this.typeHandlers.get(data.__type__);
    if (!handler) return;
    handler(data, key, { parentData: parentData || data, index: index != null ? index : null });
  },

  // ---- type handlers ----

  processAudioClip(data, key) {
    const nativeExt = data._native || '.mp3';
    const baseName = data._name || 'audio';
    const fileName = baseName + (nativeExt.startsWith('.') ? nativeExt : `.${nativeExt}`);
    const dir = 'Audio';
    const uuid = this.decodeMaybe(key) || key;

    // Prefer rawAssets path (music/success.mp3)
    const raw = this._rawAssetMap.get(String(key))
      || this._rawAssetMap.get(uuid)
      || this._rawAssetMap.get(this.expandUuidRef(key));

    let outName = fileName;
    let outDir = dir;
    if (raw && raw.path) {
      outName = path.basename(raw.path);
      const sub = path.dirname(raw.path).replace(/\\/g, '/');
      if (sub && sub !== '.') outDir = path.posix.join(dir, sub);
    }

    const nativeSrc = this.findNativeFile(uuid, key, nativeExt)
      || this.findNativeFile(data._name, key, nativeExt);

    if (nativeSrc) {
      this.queueCopy(nativeSrc, path.join(global.paths.output, 'assets', outDir, outName));
    }

    this.enqueueWrite(outDir, `${outName}.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
    this.audio.push(data);
    this._handledUuids.add(String(uuid));
  },

  processTextAsset(data, key) {
    const name = (data._name || 'text') + '.json';
    const uuid = this.decodeMaybe(key) || key;
    const dir = 'resource';
    this.enqueueWrite(dir, name, data);
    this.enqueueWrite(dir, `${name}.meta`, { ver: '1.2.7', uuid, subMetas: {} });
  },

  processAnimationClip(data, key) {
    const name = data._name || 'anim';
    const dir = 'Animation';
    const filename = `${name}.anim`;
    const uuid = this.decodeMaybe(key) || key;

    // Keep __id__ form if somehow resolved — animation clips are usually plain
    this.enqueueWrite(dir, filename, data);
    this.animation.push(data);
    this.enqueueWrite(dir, `${filename}.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
    this._handledUuids.add(String(uuid));
  },

  processLabelAtlas(data, key) {
    const name = data._name || 'labelatlas';
    const dir = 'LabelAtlas';
    const filename = `${name}.labelatlas`;
    const uuid = this.decodeMaybe(key) || key;
    this.enqueueWrite(dir, filename, data);
    this.enqueueWrite(dir, `${filename}.meta`, {
      ver: '1.2.7',
      uuid,
      subMetas: {},
    });
    this._handledUuids.add(String(uuid));
  },

  /**
   * 场景：支持 (documentArray, index, key) 旧签名与直接 document 写出
   */
  processSceneAsset(data, index, key) {
    // Old signature: processSceneAsset(parentData, index, key) where parentData is array
    if (Array.isArray(data) && data[0] && data[0].__type__ === 'cc.SceneAsset') {
      // If references were resolved, re-encode; if already id-refs, clone is fine
      let doc = data;
      const hasObjectRef = data.some((it, i) => {
        if (!it || typeof it !== 'object') return false;
        // heuristic: scene field became a full object with __type__ instead of __id__
        return false;
      });
      // Prefer pristine id-ref form via toIdReferencedArray if cycles present
      try {
        JSON.stringify(doc);
        // still re-encode if any property points to another root element by identity
        doc = this.toIdReferencedArray(data);
      } catch {
        doc = this.toIdReferencedArray(data);
      }
      this.writeSceneDocument(doc, key);
      return;
    }

    // Called with SceneAsset object only — cannot reconstruct full doc
    if (data && data.__type__ === 'cc.SceneAsset') {
      logger.warn(`SceneAsset without document array, skip full write: ${data._name || key}`);
    }
  },

  processPrefabAsset(data, index, key) {
    if (Array.isArray(data) && data[0] && data[0].__type__ === 'cc.Prefab') {
      let doc;
      try {
        JSON.stringify(data);
        doc = this.toIdReferencedArray(data);
      } catch {
        doc = this.toIdReferencedArray(data);
      }
      this.writePrefabDocument(doc, key);
      return;
    }
    if (data && data.__type__ === 'cc.Prefab') {
      // Single object without node graph — still write stub
      const name = data._name || 'Prefab';
      this.enqueueWrite('Prefab', `${name}.prefab`, [data]);
    }
  },

  /**
   * SpriteFrame handler.
   * Supports:
   * - New: processSpriteFrame(spriteObj, uuid, ctx?)
   * - Legacy test/API: processSpriteFrame(parentData, index, key)
   */
  processSpriteFrame(data, keyOrIndex, ctxOrKey) {
    let spriteData = data;
    let key = keyOrIndex;

    // Legacy: (parentMapOrArray, index, key)
    if (
      data
      && typeof data === 'object'
      && data.__type__ !== 'cc.SpriteFrame'
      && (typeof keyOrIndex === 'string' || typeof keyOrIndex === 'number')
      && typeof ctxOrKey === 'string'
      && data[keyOrIndex]
    ) {
      spriteData = data[keyOrIndex];
      key = ctxOrKey;
    } else if (data && data.__type__ === 'cc.SpriteFrame') {
      spriteData = data;
      key = keyOrIndex;
    } else if (ctxOrKey && ctxOrKey.parentData && ctxOrKey.index != null) {
      const parent = ctxOrKey.parentData;
      if (parent && parent[ctxOrKey.index] && parent[ctxOrKey.index].__type__ === 'cc.SpriteFrame') {
        spriteData = parent[ctxOrKey.index];
      }
      key = keyOrIndex;
    }

    if (!spriteData || typeof spriteData !== 'object') return;

    const name = (spriteData.content && spriteData.content.name)
      || spriteData._name
      || key;
    this.spriteFrames[key] = spriteData;

    const outputMode = (global.config && global.config.assets && global.config.assets.spriteOutputMode) || 'single';
    if (outputMode === 'single') {
      this.processSpriteFrameSingle(spriteData, name, key);
    }
  },

  processSpriteFrameSingle(spriteData, name, key) {
    const dir = 'Texture';
    const uuid = this.decodeMaybe(key) || key;

    let texUuid = null;
    if (spriteData.content && spriteData.content.texture) {
      texUuid = spriteData.content.texture.__uuid__ || spriteData.content.texture;
    } else if (spriteData.content && spriteData.content.atlas) {
      texUuid = spriteData.content.atlas.__uuid__ || spriteData.content.atlas;
    } else if (spriteData._texture) {
      texUuid = spriteData._texture.__uuid__ || spriteData._texture;
    }

    const texDecoded = this.decodeMaybe(texUuid) || texUuid;
    const safeName = String(name).replace(/[\/\\?%*:|"<>]/g, '_');

    const nativeSrc = this.findNativeFile(texDecoded, texUuid, '.png')
      || this.findNativeFile(uuid, key, '.png');

    if (nativeSrc) {
      this.queueCopy(nativeSrc, path.join(global.paths.output, 'assets', dir, `${safeName}.png`));
    }

    // Build rect info from content or classic fields
    const content = spriteData.content || {};
    const rect = content.rect || spriteData._rect || [0, 0, 0, 0];
    const offset = content.offset || spriteData._offset || [0, 0];
    const originalSize = content.originalSize || spriteData._originalSize || [0, 0];
    const rotated = content.rotated || spriteData._rotated || false;

    const rectX = Array.isArray(rect) ? rect[0] : (rect.x || 0);
    const rectY = Array.isArray(rect) ? rect[1] : (rect.y || 0);
    const rectW = Array.isArray(rect) ? rect[2] : (rect.width || 0);
    const rectH = Array.isArray(rect) ? rect[3] : (rect.height || 0);
    const offX = Array.isArray(offset) ? offset[0] : (offset.x || 0);
    const offY = Array.isArray(offset) ? offset[1] : (offset.y || 0);
    const rawW = Array.isArray(originalSize) ? originalSize[0] : (originalSize.width || 0);
    const rawH = Array.isArray(originalSize) ? originalSize[1] : (originalSize.height || 0);

    const subMetas = {};
    subMetas[safeName] = {
      ver: '1.0.4',
      uuid,
      rawTextureUuid: texDecoded || uuid,
      trimType: 'auto',
      trimThreshold: 1,
      rotated: !!rotated,
      offsetX: offX,
      offsetY: offY,
      trimX: rectX,
      trimY: rectY,
      width: rectW,
      height: rectH,
      rawWidth: rawW,
      rawHeight: rawH,
      borderTop: 0,
      borderBottom: 0,
      borderLeft: 0,
      borderRight: 0,
      subMetas: {},
    };

    this.enqueueWrite(dir, `${safeName}.png.meta`, {
      ver: '1.2.7',
      uuid: texDecoded || uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas,
    });
    this._handledUuids.add(String(uuid));
  },

  processDragonBonesAsset(data, key) {
    const name = data._name || 'dragon';
    const dir = 'DragonBones';
    const uuid = this.decodeMaybe(key) || key;

    if (data._dragonBonesJson) {
      this.enqueueWrite(dir, `${name}_ske.json`, data._dragonBonesJson);
    } else {
      const src = this.findNativeFile(uuid, key, data._native || '.json');
      if (src) {
        this.queueCopy(src, path.join(global.paths.output, 'assets', dir, name + (data._native || '_ske.json')));
      }
    }

    this.enqueueWrite(dir, `${name}_ske.json.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
  },

  processDragonBonesAtlasAsset(data, key) {
    const name = data._name || 'dragon';
    const dir = 'DragonBones';
    const uuid = this.decodeMaybe(key) || key;

    if (data._textureAtlasData) {
      this.enqueueWrite(dir, `${name}_tex.json`, data._textureAtlasData);
    } else {
      const src = this.findNativeFile(uuid, key, data._native || '.json');
      if (src) {
        this.queueCopy(src, path.join(global.paths.output, 'assets', dir, name + (data._native || '_tex.json')));
      }
    }

    const texRef = data._texture;
    if (texRef) {
      const texUuid = texRef.__uuid__ || texRef;
      const src = this.findNativeFile(this.decodeMaybe(texUuid) || texUuid, texUuid, '.png');
      if (src) {
        this.queueCopy(src, path.join(global.paths.output, 'assets', dir, `${name}_tex.png`));
      }
    }

    this.enqueueWrite(dir, `${name}_tex.json.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
  },

  processSpineSkeletonData(data, key) {
    const name = data._name || 'spine';
    const dir = 'Spine';
    const uuid = this.decodeMaybe(key) || key;

    if (data._skeletonJson) {
      this.enqueueWrite(dir, `${name}.json`, data._skeletonJson);
    } else {
      const src = this.findNativeFile(uuid, key, data._native || '.json');
      if (src) {
        this.queueCopy(src, path.join(global.paths.output, 'assets', dir, name + (data._native || '.json')));
      }
    }

    if (data._atlasText) {
      this.enqueueWrite(dir, `${name}.atlas`, data._atlasText);
    }

    if (data.textures && Array.isArray(data.textures)) {
      data.textures.forEach((tex, i) => {
        const texUuid = tex.__uuid__ || tex;
        const src = this.findNativeFile(this.decodeMaybe(texUuid) || texUuid, texUuid, '.png');
        if (src) {
          const ext = i === 0 ? '.png' : `_${i}.png`;
          this.queueCopy(src, path.join(global.paths.output, 'assets', dir, name + ext));
        }
      });
    }

    this.enqueueWrite(dir, `${name}.json.meta`, {
      ver: '1.2.7',
      uuid,
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false,
      subMetas: {},
    });
  },

  createLibrary(index, key) {
    const settings = this.getCCSettings();
    if (settings.uuids) {
      return settings.uuids[key] || uuidUtils.generateUuid();
    }
    return uuidUtils.generateUuid();
  },

  /**
   * Locate a native file by uuid / short name.
   */
  findNativeFile(decodedOrName, compact, preferredExt) {
    const candidates = [];
    const add = (k) => {
      if (k != null && k !== '') candidates.push(String(k));
    };
    add(decodedOrName);
    add(compact);
    add(this.expandUuidRef(compact));
    add(this.decodeMaybe(compact));
    if (decodedOrName && String(decodedOrName).length > 2) {
      // stem only
      add(path.basename(String(decodedOrName), preferredExt || ''));
    }

    for (const k of candidates) {
      if (this.nativeMap.has(k)) return this.nativeMap.get(k);
      if (this.fileMap.has(k)) {
        const p = this.fileMap.get(k);
        // prefer non-json for native
        if (!p.endsWith('.json')) return p;
      }
    }

    // Direct path probe under res/raw-assets
    const resRoot = global.paths && global.paths.res;
    if (resRoot) {
      for (const k of candidates) {
        if (!k || k.length < 2) continue;
        const prefix = k.slice(0, 2);
        const exts = preferredExt
          ? [preferredExt, preferredExt.toLowerCase(), preferredExt.toUpperCase()]
          : ['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.ogg', '.wav', '.bin'];
        for (const ext of exts) {
          const e = ext.startsWith('.') ? ext : `.${ext}`;
          const probe = path.join(resRoot, 'raw-assets', prefix, k + e);
          if (fs.existsSync(probe)) return probe;
          // also without raw-assets mid folder
          const probe2 = path.join(resRoot, prefix, k + e);
          if (fs.existsSync(probe2)) return probe2;
        }
      }
    }
    return null;
  },

  queueCopy(sourcePath, targetPath) {
    if (!sourcePath || !targetPath) return;
    // de-dupe exact pairs
    for (let i = 0; i < this.cacheReadList.length; i += 1) {
      if (this.cacheReadList[i] === sourcePath && this.cacheWriteList[i] === targetPath) {
        return;
      }
    }
    this.cacheReadList.push(sourcePath);
    this.cacheWriteList.push(targetPath);
  },

  async convertToOutputFiles() {
    await this.copyFiles();
    await converters.convertSpriteAtlas(this.spriteFrames);
    logger.info(`处理了 ${this.cacheReadList.length} 个资源文件`);
  },

  async copyFiles() {
    try {
      const concurrency = getMaxParallel();
      const pairs = this.cacheReadList.map((src, i) => ({
        sourcePath: src,
        targetPath: this.cacheWriteList[i],
      }));

      await forEachPool(pairs, concurrency, async ({ sourcePath, targetPath }) => {
        if (!fs.existsSync(sourcePath)) {
          logger.warn(`源文件不存在，跳过复制: ${sourcePath}`);
          return;
        }
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
