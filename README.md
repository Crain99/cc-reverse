<!--
 * @Date: 2025-06-07 10:06:12
 * @Description: Cocos Creator 逆向工程工具
-->

# cc-reverse

Cocos Creator 逆向工程工具，用于从编译后的 Cocos Creator 游戏中提取和重建源代码与资源。
## 项目热度

如果您觉得这个项目对您有帮助，请给我们一个 Star ⭐️，这是对我们最大的鼓励！

[![Star History Chart](https://api.star-history.com/svg?repos=Crain99/cc-reverse&type=Date)](https://star-history.com/#Crain99/cc-reverse&Date)

## 功能特性

- 解析和重建 Cocos Creator 项目结构
- 提取并转换游戏脚本和资源文件
- 处理 UUID 和元数据信息
- 支持场景、预制体、动画等资源的提取
- 生成符合 Cocos Creator 格式要求的项目文件

## 安装

### 全局安装

```bash
# 全局安装
npm install -g cc-reverse

# 使用
cc-reverse --path <源项目路径>
```

### 项目安装

```bash
# 克隆仓库
git clone https://github.com/Crain99/cc-reverse.git
cd cc-reverse

# 安装依赖
npm install

# 使用
npm start -- --path <源项目路径>
```

## 使用方法

### 命令行参数

```
选项:
  -V, --version       显示版本号
  -p, --path <path>   源项目路径
  -o, --output <path> 输出路径 (默认: "./output")
  -v, --verbose       显示详细日志
  -s, --silent        静默模式，不显示进度
  -h, --help          显示帮助信息
```

### 示例

```bash
# 基本用法
cc-reverse --path ./games/sample-game

# 指定输出目录
cc-reverse --path ./games/sample-game --output ./extracted-game

# 显示详细日志
cc-reverse --path ./games/sample-game --verbose

# 静默模式
cc-reverse --path ./games/sample-game --silent
```

### 配置文件

您可以在项目根目录创建 `cc-reverse.config.js` 配置文件来自定义工具行为：

```js
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
  }
}
```

## 注意事项

- 此工具主要用于学习和研究目的
- 无法还原经过加密的代码
- 建议先在简单的开源项目上测试（例如"合成大西瓜"）
- 请遵守相关法律法规和软件许可协议

## 项目结构

```
cc-reverse/
├── src/                     # 源代码目录
│   ├── core/                # 核心功能模块
│   │   ├── codeAnalyzer.js  # 代码分析器
│   │   ├── converters.js    # 格式转换器
│   │   ├── projectGenerator.js # 项目生成器
│   │   ├── resourceProcessor.js # 资源处理器
│   │   └── reverseEngine.js # 逆向工程引擎
│   ├── utils/              # 工具函数
│   │   ├── fileManager.js  # 文件管理工具
│   │   ├── logger.js       # 日志工具
│   │   └── uuidUtils.js    # UUID 工具
│   ├── config/             # 配置文件
│   │   └── configLoader.js # 配置加载器
│   └── index.js           # 主入口文件
├── bin/                    # 命令行工具
│   └── cc-reverse.js       # 命令行入口
├── cc-reverse.config.js    # 示例配置文件
├── package.json            # 项目依赖配置
└── README.md               # 项目说明文档
```

## 依赖项

- @babel/* - JavaScript 解析和生成工具
- commander - 命令行解析
- chalk - 终端颜色支持
- ora - 终端加载动画
- progress - 进度条
- 其他工具库 (async, uuid, string-random 等)

## 开发

```bash
# 开发模式运行
npm run dev

# 代码检查
npm run lint

# 运行测试
npm run test

# 构建
npm run build
```

## 支持项目

如果您觉得这个项目对您有所帮助，请考虑给我们一个 Star ⭐️！您的支持是我们持续改进的动力。

<p align="center">
  <a href="https://github.com/Crain99/cc-reverse">
    <img src="https://img.shields.io/github/stars/Crain99/cc-reverse?style=social" alt="给项目点个Star">
  </a>
</p>

## 许可证

MIT

## 贡献

欢迎提交问题报告和改进建议！
