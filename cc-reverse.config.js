/*
 * @Date: 2025-06-07 10:06:12
 * @Description: cc-reverse 配置文件
 */

module.exports = {
    // 输出配置
    output: {
        createMeta: true,
        prettify: true,
        includeComments: true
    },
    
    // 代码生成配置
    codeGen: {
        language: "typescript", // "typescript" 或 "javascript"
        moduleType: "commonjs", // "commonjs", "esmodule", 或 "amd"
        indentSize: 2,
        indent: "space" // "space" 或 "tab"
    },
    
    // 资源处理配置
    assets: {
        extractTextures: true,
        extractAudio: true,
        extractAnimations: true,
        optimizeSprites: false,
        spriteOutputMode: "single" // "single"（逐张导出）或 "atlas"（图集模式）
    },

    // 解密配置
    decrypt: {
        key: null // XXTEA 密钥；也可通过 --key 参数指定
    },

    // Cocos Creator 3.x 专用配置
    cocos3x: {
        // 仅处理指定 bundle（空数组 = 全部）。CLI --bundle 会追加到这里。
        bundles: [],
        // 是否在解码 CCON v2（notepack 格式）文件时保留原始 JSON 数据
        preserveCconV2Raw: true
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