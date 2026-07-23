/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 资源格式转换工具
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const XMLWriter = require('xml-writer');
const sizeOf = require('image-size');
const { uuidUtils } = require('../utils/uuidUtils');
const { fileManager } = require('../utils/fileManager');
const { logger } = require('../utils/logger');

/**
 * 资源格式转换工具
 */
const converters = {
  /**
   * 转换精灵图集
   * @param {Object} spriteFrames 精灵帧对象
   * @returns {Promise<void>}
   */
  async convertSpriteAtlas(spriteFrames) {
    try {
      const outputMode = (global.config && global.config.assets && global.config.assets.spriteOutputMode) || 'single';

      if (outputMode !== 'atlas' || !spriteFrames || Object.keys(spriteFrames).length === 0) {
        logger.info('精灵图集处理完成');
        return;
      }

      // Group sprite frames by texture UUID
      const atlasGroups = {};
      for (const key in spriteFrames) {
        const frame = spriteFrames[key];
        let texUuid = 'default';
        if (frame._texture) {
          texUuid = frame._texture.__uuid__ || frame._texture || 'default';
        } else if (frame.content && frame.content.atlas) {
          texUuid = frame.content.atlas.__uuid__ || frame.content.atlas || 'default';
        }
        if (!atlasGroups[texUuid]) {
          atlasGroups[texUuid] = { frames: {}, name: null };
        }
        const frameName = frame._name || key;
        if (!atlasGroups[texUuid].name) {
          atlasGroups[texUuid].name = frameName;
        }
        atlasGroups[texUuid].frames[frameName] = {
          frame: {
            x: frame._rect ? frame._rect.x || 0 : 0,
            y: frame._rect ? frame._rect.y || 0 : 0,
            w: frame._rect ? frame._rect.width || 0 : 0,
            h: frame._rect ? frame._rect.height || 0 : 0,
          },
          offset: {
            x: frame._offset ? frame._offset.x || 0 : 0,
            y: frame._offset ? frame._offset.y || 0 : 0,
          },
          rotated: frame._rotated || false,
          sourceColorRect: {
            x: frame._rect ? frame._rect.x || 0 : 0,
            y: frame._rect ? frame._rect.y || 0 : 0,
            w: frame._rect ? frame._rect.width || 0 : 0,
            h: frame._rect ? frame._rect.height || 0 : 0,
          },
          sourceSize: {
            w: frame._originalSize ? frame._originalSize.width || 0 : 0,
            h: frame._originalSize ? frame._originalSize.height || 0 : 0,
          },
        };
      }

      for (const texUuid in atlasGroups) {
        const group = atlasGroups[texUuid];
        const atlasName = group.name || texUuid;

        const plistData = { frames: group.frames };
        const xml = this.createXmlDocument(plistData);
        await fileManager.writeFile('Texture', atlasName + '.plist', xml.toString());
      }

      logger.info(`生成了 ${Object.keys(atlasGroups).length} 个精灵图集`);
    } catch (err) {
      logger.error('转换精灵图集时出错:', err);
    }
  },

  /**
   * 将 JSON 转换为 PLIST 格式
   * @param {string} fileName 文件名（不含扩展名）
   * @returns {Promise<void>}
   */
  async jsonToPlist(fileName) {
    try {
      const data = await fsp.readFile(fileName + '.json', 'utf-8');
      const json = JSON.parse(data);

      const enhancedJson = this.addProperties(json, fileName);
      const xml = this.createXmlDocument(enhancedJson);

      await fsp.writeFile(fileName + '.plist', xml.toString());

      logger.debug(`转换完成: ${fileName}.json -> ${fileName}.plist`);
    } catch (err) {
      logger.error(`转换文件 ${fileName} 时出错:`, err);
    }
  },

  /**
   * 创建 XML 文档
   * @param {Object} json JSON 对象
   * @returns {XMLWriter}
   */
  createXmlDocument(json) {
    const xml = new XMLWriter();

    xml.startDocument();
    xml.writeDocType('plist', '-//Apple Computer//DTD PLIST 1.0//EN', 'http://www.apple.com/DTDs/PropertyList-1.0.dtd');

    xml.startElement('plist');
    xml.writeAttribute('version', '1.0');

    xml.startElement('dict');
    this.parsetoXML(xml, json);

    xml.endElement(); // dict
    xml.endElement(); // plist
    xml.endDocument();

    return xml;
  },

  /**
   * 将 JSON 对象解析为 XML
   */
  parsetoXML(xml, json) {
    for (const key in json) {
      const value = json[key];

      if (typeof value === 'object' && value !== null) {
        xml.startElement('key');
        xml.text(key);
        xml.endElement();

        if (key === 'frame' || key === 'offset' || key === 'sourceColorRect'
            || key === 'sourceSize' || key === 'spriteSourceSize') {
          this.parsetoJson(xml, value);
        } else {
          xml.startElement('dict');
          this.parsetoXML(xml, value);
          xml.endElement();
        }
      } else {
        this.toXML(xml, key, value);
      }
    }
  },

  /**
   * 将基本类型的键值对写入 XML
   */
  toXML(xml, key, value) {
    xml.startElement('key');
    xml.text(key);
    xml.endElement();

    if (typeof value === 'boolean') {
      xml.startElement(value.toString());
    } else if (typeof value === 'number') {
      xml.startElement('integer');
      xml.text(value.toString());
    } else {
      xml.startElement('string');
      xml.text(value == null ? '' : value.toString());
    }

    xml.endElement();
  },

  /**
   * 将对象解析为特定格式的 JSON 字符串
   */
  parsetoJson(xml, value) {
    xml.startElement('string');

    let json;
    if (value.x !== undefined && value.w !== undefined) {
      json = `{{${value.x},${value.y}},{${value.w},${value.h}}}`;
    } else {
      json = `{${value.w},${value.h}}`;
    }

    xml.text(json);
    xml.endElement();
  },

  /**
   * 添加必要的属性到 JSON 对象
   */
  addProperties(json, fileName) {
    const metadata = {
      format: 3,
      pixelFormat: 'RGBA8888',
      premultiplyAlpha: false,
      realTextureFileName: path.basename(fileName) + '.png',
      size: this.getImageSize(fileName),
      smartupdate: `$TexturePacker:SmartUpdate:${uuidUtils.generateUuid()}:${uuidUtils.generateUuid()}:${uuidUtils.generateUuid()}$`,
      textureFileName: path.basename(fileName) + '.png',
    };

    const result = { ...json };
    result.metadata = metadata;

    if (result.meta) {
      delete result.meta;
    }

    return result;
  },

  /**
   * 获取图像尺寸（仅用 image-size，去掉冗余 imageinfo）
   */
  getImageSize(fileName) {
    try {
      const dimensions = sizeOf(fileName + '.png');
      return `{${dimensions.width},${dimensions.height}}`;
    } catch (err) {
      logger.error(`读取图像文件 ${fileName}.png 时出错:`, err);
      return '{0,0}';
    }
  },
};

module.exports = { converters };
