# 下一轮 — 2.x 优化待办列表

开启日期: 2026-05-12
负责人: 待定
前置条件: 3.x 大整改（本轮）合并完成。

本待办列表收录从 3.x 轮次中推迟的 2.x 改进项。本轮复用的基础设施会承担大部分工作；下列条目是 2.x 特有的剩余范围。

## 延续的 Wave 条目

- **R2. settings.js 安全解析**
  使用 `vm.createContext` 沙箱替换 `eval()` (reverseEngine.js:371)；拒绝访问 `process`、`require` 等。

- **R13. Atlas 时序修复**
  当前 SpriteFrame 在 SpriteAtlas 之前处理，导致引用断裂。重排 pass 顺序或采用两阶段解析。

## 2.x 脚本恢复增强

- 把 6 层管线（chunk-split → ESM → class → ccclass → type-infer → ts-emit）应用到 2.x 的 `project.js` 模块包。
- codeAnalyzer.js:51 处的 AST 形状假设（`node.value.elements[0].params`）很脆弱 — 改用结构化匹配。
- 2.x 压缩数组 → 对象的恢复已经可用；将其复用为 2.x Layer 5 的类型源。

## 2.x 测试 gold-sample 集成

- 把 `~/mini/dabaoyiqie-reverse` 和 `~/mini/cgxfd-reverse` 从仅回归测试提升为活跃样本。
- 增加 2.3.x 样本（通过 cocos-cli 构建或寻找真实样本）。

## 方法论 skill 扩展

- 在 `output-layers.md`（project.js 分层命名）和 `analyzing-scripts.md`（旧版 2.x 装饰器、`cc.Class.extend` 模式）中加入 2.x 细节。
- 如有新发现，更新 `cocos2x-format.md`。

## 该轮次的开放问题

- 是否有针对 2.3.x 的具体需求，还是 2.4.x 已足够？
- 2.x 是否应采用与 3.x 相同的 TS 输出目标，还是保持 `.ts`（当前默认）而不使用 ts-morph？
