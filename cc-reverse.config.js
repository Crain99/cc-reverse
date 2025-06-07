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