/*
 * @Date: 2025-06-07 10:06:12
 * @Description: UUID 工具类
 */
const stringRandom = require('string-random');
const uuid = require('uuid');

// Base64 编码映射表
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

// 创建 Base64 值映射数组
const BASE64_VALUES = new Array(123); // max char code in base64Keys
for (let i = 0; i < 123; ++i) BASE64_VALUES[i] = 64; // 填充占位符('=')索引
for (let i = 0; i < 64; ++i) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;

// 十六进制字符数组
const HexChars = '0123456789abcdef'.split('');

// UUID 模板构建
const _t = ['', '', '', ''];
const UuidTemplate = _t.concat(_t, '-', _t, '-', _t, '-', _t, '-', _t, _t, _t);
const Indices = UuidTemplate.map((x, i) => x === '-' ? NaN : i).filter(isFinite);

/**
 * UUID 工具类
 */
const uuidUtils = {
    /**
     * 生成随机 UUID
     * @returns {string} 随机 UUID
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
        // 参数检查
        if (typeof base64 !== "string") {
            console.warn("解码 UUID 失败: 输入必须是字符串");
            return undefined;
        }
        
        // 长度检查
        if (base64.length !== 22) {
            // 如果不是标准长度的 Base64 UUID，直接返回原值
            return base64;
        }
        
        try {
            // 填充模板的前两个字符
            UuidTemplate[0] = base64[0];
            UuidTemplate[1] = base64[1];
            
            // 解码剩余字符
            for (let i = 2, j = 2; i < 22; i += 2) {
                const lhs = BASE64_VALUES[base64.charCodeAt(i)];
                const rhs = BASE64_VALUES[base64.charCodeAt(i + 1)];
                
                UuidTemplate[Indices[j++]] = HexChars[lhs >> 2];
                UuidTemplate[Indices[j++]] = HexChars[((lhs & 3) << 2) | rhs >> 4];
                UuidTemplate[Indices[j++]] = HexChars[rhs & 0xF];
            }
            
            // 返回标准 UUID
            return UuidTemplate.join('');
        } catch (err) {
            console.error("解码 UUID 时出错:", err);
            return base64; // 出错时返回原始值
        }
    },
    
    /**
     * 压缩 UUID (23位)
     * 将标准的 UUID 转换为压缩的 23 位格式
     * 
     * @param {string} uuid 标准 UUID
     * @returns {string} 压缩后的 UUID
     */
    compress_uuid(uuid) {
        try {
            // 分离 UUID 前缀和内容
            const header = uuid.slice(0, 5);
            const content = uuid.slice(5).replace(/-/g, "") + "f";
            
            // 转换内容为字节数组
            const byteArray = [];
            for (let i = 0; i < content.length - 1; i += 2) {
                byteArray.push(parseInt(content.slice(i, i + 2), 16));
            }
            
            // 转换为 Base64 并返回结果
            const base64Content = Buffer.from(byteArray).toString('base64');
            return header + base64Content.slice(0, base64Content.length - 2);
        } catch (err) {
            console.error("压缩 UUID 时出错:", err);
            return uuid; // 出错时返回原始值
        }
    },
    
    /**
     * 解压缩 UUID (22位)
     * 将 22 位格式的 UUID 转换为标准格式
     * 
     * @param {string} uuid 22位 UUID
     * @returns {string} 解压缩后的 UUID
     */
    decompress_uuid(uuid) {
        try {
            // 分离 UUID 前缀和内容
            const header = uuid.slice(0, 2);
            const content = uuid.slice(2).replace(/-/g, "") + "f";
            
            // 转换内容为字节数组
            const byteArray = [];
            for (let i = 0; i < content.length - 1; i += 2) {
                byteArray.push(parseInt(content.slice(i, i + 2), 16));
            }
            
            // 转换为 Base64 并返回结果
            const base64Content = Buffer.from(byteArray, 'utf-8').toString('base64');
            return header + base64Content;
        } catch (err) {
            console.error("解压缩 UUID 时出错:", err);
            return uuid; // 出错时返回原始值
        }
    },
    
    /**
     * 将 23 位 UUID 转换为 22 位格式
     * 
     * @param {string} uuid 23位 UUID
     * @returns {string} 22位 UUID
     */
    original_uuid(uuid) {
        try {
            // 转换成长的 UUID
            const header = uuid.slice(0, 5);
            const end = uuid.slice(5);
            
            // 处理 Base64 填充
            let temp = end;
            if (end.length % 3 === 1) {
                temp += "==";
            } else if (end.length % 3 === 2) {
                temp += "=";
            }
            
            // 转换为十六进制
            const base64Content = Buffer.from(temp, "base64").toString("hex");
            const longUuid = header + base64Content;
            
            // 返回转换后的 UUID
            const result = this.decompress_uuid(longUuid).slice(0, 4) + end;
            return result;
        } catch (err) {
            console.error("转换 UUID 格式时出错:", err);
            return uuid; // 出错时返回原始值
        }
    }
};

module.exports = { uuidUtils }; 