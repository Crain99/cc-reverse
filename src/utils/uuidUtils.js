/*
 * @Date: 2025-06-07 10:06:12
 * @Description: UUID 工具类
 */
const stringRandom = require('string-random');
const { logger } = require('./logger');

// Base64 编码映射表
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

// 创建 Base64 值映射数组
const BASE64_VALUES = new Array(123); // max char code in base64Keys
for (let i = 0; i < 123; ++i) BASE64_VALUES[i] = 64; // 填充占位符('=')索引
for (let i = 0; i < 64; ++i) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;

// 十六进制字符数组
const HexChars = '0123456789abcdef'.split('');

// UUID 模板构建（只读骨架；decode 时拷贝，避免并发互相覆盖）
const _t = ['', '', '', ''];
const UuidTemplate = _t.concat(_t, '-', _t, '-', _t, '-', _t, '-', _t, _t, _t);
const Indices = UuidTemplate.map((x, i) => (x === '-' ? NaN : i)).filter(isFinite);

/**
 * UUID 工具类
 */
const uuidUtils = {
  /**
   * 生成随机 UUID（22 位压缩格式）
   * @returns {string}
   */
  generateUuid() {
    return stringRandom(22);
  },

  /**
   * 将 Base64 编码的 UUID 转换为标准 UUID 格式
   * 示例: fcmR3XADNLgJ1ByKhqcC5Z -> fc991dd7-0033-4b80-9d41-c8a86a702e59
   *
   * @param {string} base64 Base64 编码的 UUID
   * @returns {string} 标准格式的 UUID
   */
  decodeUuid(base64) {
    if (typeof base64 !== 'string') {
      logger.warn('解码 UUID 失败: 输入必须是字符串');
      return undefined;
    }

    if (base64.length !== 22) {
      return base64;
    }

    try {
      // 每次拷贝模板，避免共享可变数组被并发写坏
      const template = UuidTemplate.slice();
      template[0] = base64[0];
      template[1] = base64[1];

      for (let i = 2, j = 2; i < 22; i += 2) {
        const lhs = BASE64_VALUES[base64.charCodeAt(i)];
        const rhs = BASE64_VALUES[base64.charCodeAt(i + 1)];

        template[Indices[j++]] = HexChars[lhs >> 2];
        template[Indices[j++]] = HexChars[((lhs & 3) << 2) | (rhs >> 4)];
        template[Indices[j++]] = HexChars[rhs & 0xF];
      }

      return template.join('');
    } catch (err) {
      logger.error('解码 UUID 时出错:', err);
      return base64;
    }
  },

  /**
   * 压缩 UUID (23位)
   * @param {string} uuid 标准 UUID
   * @returns {string}
   */
  compress_uuid(uuid) {
    try {
      const header = uuid.slice(0, 5);
      const content = uuid.slice(5).replace(/-/g, '') + 'f';

      const byteArray = [];
      for (let i = 0; i < content.length - 1; i += 2) {
        byteArray.push(parseInt(content.slice(i, i + 2), 16));
      }

      const base64Content = Buffer.from(byteArray).toString('base64');
      return header + base64Content.slice(0, base64Content.length - 2);
    } catch (err) {
      logger.error('压缩 UUID 时出错:', err);
      return uuid;
    }
  },

  /**
   * 解压缩 UUID (22位)
   * @param {string} uuid 22位 UUID
   * @returns {string}
   */
  decompress_uuid(uuid) {
    try {
      const header = uuid.slice(0, 2);
      const content = uuid.slice(2).replace(/-/g, '') + 'f';

      const byteArray = [];
      for (let i = 0; i < content.length - 1; i += 2) {
        byteArray.push(parseInt(content.slice(i, i + 2), 16));
      }

      const base64Content = Buffer.from(byteArray).toString('base64');
      return header + base64Content;
    } catch (err) {
      logger.error('解压缩 UUID 时出错:', err);
      return uuid;
    }
  },

  /**
   * 将 23 位 UUID 转换为 22 位格式
   * @param {string} uuid 23位 UUID
   * @returns {string}
   */
  original_uuid(uuid) {
    try {
      const header = uuid.slice(0, 5);
      const end = uuid.slice(5);

      let temp = end;
      if (end.length % 3 === 1) {
        temp += '==';
      } else if (end.length % 3 === 2) {
        temp += '=';
      }

      const base64Content = Buffer.from(temp, 'base64').toString('hex');
      const longUuid = header + base64Content;

      return this.decompress_uuid(longUuid).slice(0, 4) + end;
    } catch (err) {
      logger.error('转换 UUID 格式时出错:', err);
      return uuid;
    }
  },
};

module.exports = { uuidUtils };
