# Cocos Creator 3.x 逆向工程大整改 — 设计

日期: 2026-05-12
范围: cc-reverse 3.x 管线 + cocos-reverse-engineering-skill 方法论
状态: 已批准（头脑风暴完成）
范围外: 2.x 优化（推迟到下一轮，见 `NEXT-ROUND-2x-backlog.md`）

## 1. 目标

将 3.x 逆向工程从"结构空洞"提升至"生产级"：

1. 真正的脚本恢复（而非 chunk 拷贝）— System.register chunk 反编译为 TypeScript 工程，恢复类名、装饰器、推断字段类型。
2. 完整的 3.x 资源反序列化 — CCON v2、IPackedFileData、TypedArray、跨 bundle 重定向。
3. 诚实的工程元数据 — 生成的 `project.json` 反映实际源构建，而非硬编码常量。
4. 方法论级 skill — 配套 `cocos-reverse-engineering` 插件教用户*如何*使用产物，而不仅是*如何运行工具*。

本轮非目标：
- 2.x 改进（下一轮复用本轮基础设施）。
- 在没有 sourcemap 的情况下恢复混淆变量名（Layer 7 humanify 是可选项，发布时不预配置）。
- 原生二进制解包（.so / .dll 脚本提取）。

## 2. 架构概览

### 2.1 脚本恢复 — 7 层

`src/core/cocos3x/scriptRecovery/` 下的新模块树：

```
src/chunks/*.js  ────────┐
                          ▼
  Layer 1  chunkSplitter      System.register parsing → 1 file per module
                          ▼
  Layer 2  esmRebuilder       setters/_export → import/export
                          ▼
  Layer 3  classRestorer      __extends/__decorate → class syntax + decorators
                          ▼
  Layer 4  ccclassNamer       _RF.push + ccclass("Name") → restore class names + uuid mapping
                          ▼
  Layer 5  typeInferer        scan .scene/.prefab → infer field types
                          ▼
  Layer 6  tsProjectEmitter   ts-morph + prettier → assets/scripts/<bundle>/<module>.ts + tsconfig
                          ▼
  Layer 7  humanify           [opt-in] minified-name renaming via humanify CLI
```

每一层：
- 接收并返回 Babel AST（层间不重新解析）。
- Fail closed：某层崩溃 → 下游使用上游输出 → 最坏情况退化为当前行为（原始 chunk 拷贝）。
- 可通过 `--script-layers <1-7>` 切换。

我们依赖的外部工具（避免重复造轮子）：
- `webcrack` — 驱动 Layer 1 + Layer 2 大部分 + Layer 3 的 `__extends` 还原。
- `@babel/*` — 项目已有依赖，用于 Cocos 特定的 AST。
- `ts-morph` — Layer 6 的 TS 输出（处理 TS 装饰器比 Babel 更干净）。
- `prettier` — 最终格式化。
- `humanify`（local 模式）— Layer 7，可选，用户单独安装。文档同时说明通过 `copilot-api` 走 GitHub Copilot 路径作为用户自担风险的选项（参见 §6）。

### 2.2 资源管线 — Wave 0/1/2/3

按"是否被前一波解锁"分组的已识别弱点：

```
Wave 0 — corrective baseline (this round, slimmed from original plan)
  R1.  JSC key extraction hardening
  R3.  Sync IO → async (fs.promises)
  R4.  Per-asset error isolation

Wave 1 — 3.x deserialization completion
  R5.  CCON v2 (notepack) decoder
  R6.  IPackedFileData full rehydrate
  R7.  TypedArray DataTypeID coverage
  R8.  Cross-bundle redirect resolution

Wave 2 — project structure honesty
  R9.  Dynamic project.json from source settings
  R10. Use SharedClasses dynamic type table (drop hardcoded typeDefinitions for 3.x)
  R11. Smart class → output dir mapping
  R12. Complete .meta files

Wave 3 — extended asset coverage
  R14. 3.x Spine (sp.SkeletonData)
  R15. 3.x DragonBones
  R16. Binary settings deserialization
```

从计划中移除（推到下一轮 2.x）：
- R2 settings.js eval 安全（2.x 独占代码路径）。
- R13 atlas 时序（主要是 2.x sprite-frame-before-atlas 问题）。

### 2.3 PR 顺序

堆叠式 worktree 拓扑（参见 §4）：

```
PR 1: Wave 0 (R1, R3, R4)                       ~400 LOC
PR 2: Wave 1 (R5–R8)                            ~1200 LOC
PR 3: Script Layer 1–3 (webcrack integration)   ~400 LOC
PR 4: Script Layer 4–6 (cocos + type inference) ~1000 LOC
PR 5: Wave 2 (R9–R12) + Layer 7                 ~800 LOC
PR 6: Wave 3 (R14–R16)                          ~600 LOC
PR 7: skill methodology A–F (separate repo)     6 docs + SKILL.md refactor
```

合并顺序 = 列表顺序。PR 3 在 PR 2 之后启动，因为 Layer 5 的类型推断需要读取 scene/prefab JSON，而后者依赖 Wave 1 的修复。

## 3. 方法论 Skill — A–F 全量

`cocos-reverse-engineering-skill` 配套插件获得 7 阶段工作流（原为 5 阶段）：

```
Phase 0  legal-preflight      [F]   mandatory checklist before any bytes touched
Phase 1  check-deps           [—]   unchanged
Phase 2  detect-project       [—]   unchanged
Phase 3  decrypt-jsc          [—]   unchanged (uses PR1 R1 hardening)
Phase 4  triage               [E]   pick scope (assets-only / scripts-only / target system)
Phase 5  unpack               [—]   unchanged invocation; output now multi-layered
Phase 6  navigate-output      [A]   how to read the 7-layer script tree
Phase 7  validate-recovery    [B]   5 quality gates run via `cc-reverse validate`
Phase 8  analyze-recovered    [D]   how to read recovered code; SDK fingerprint library
        recovery-decisions    [C]   decision tree referenced from any failing phase
```

`references/` 下六个新参考文件：

| 文件 | 主题 |
|---|---|
| `legal-preflight.md` | DMCA §1201(f)、欧盟 2009/24 第 6 条、中国著作权法第 24 条第 4 项 — 快速核查清单 |
| `triage.md` | 由范围驱动的调用模式 |
| `output-layers.md` | 何时使用原始 chunk vs ESM vs TS 工程 |
| `quality-gates.md` | 5 个质量门：类名覆盖率 ≥ 80%、类型化字段覆盖率 ≥ 60%、UUID 闭包、tsc --noEmit、RECOVERY_REPORT 交叉校验 |
| `recovery-decisions.md` | 部分 / 失败管线运行的决策树 |
| `analyzing-scripts.md` | 阅读恢复后的 TS、依赖图、SDK fingerprint 库（国内：友盟 / 微信 / 字节 / 腾讯 / Bugly。海外：AppLovin / Unity Ads / GameAnalytics / Firebase / IronSource） |

`SKILL.md` 新增顶层 "Reverse Engineering Principles" 一节，将方法论编纂入文。

## 4. Worktree 与 PR 工作流

`.worktrees/` 下的布局（已 gitignore，项目本地）：

```
.worktrees/
  pr1-wave0-foundation/        branched from main
  pr2-wave1-3x-deserialize/    branched from main
  pr3-scripts-layer1-3/        branched from pr2 head (stacked)
  pr4-scripts-layer4-6/        branched from pr3 head (stacked)
  pr5-wave2-and-humanify/      branched from pr4 head (stacked)
  pr6-wave3-extended-assets/   branched from main
```

Skill 仓库（`/Users/lcf/code/cocos-reverse-engineering-skill/`）的 PR 7 在自有的 `.worktrees/pr7-skill-methodology-AF/` 中，于 PR 5 合并后启动（这样分层输出已经存在）。

每个 PR 的 Definition of Done：
1. 设计文档对应章节标记为 "implemented"。
2. ≥ 1 个 golden sample 通过 E2E（`npm run e2e -- <sample>`）。
3. 所有 5 个质量门要么通过，要么在基线中有 "known regression" 条目。
4. 添加 CHANGELOG 条目。
5. 用户可见的部分，更新 README 章节。
6. 2.x golden 样本（dabaoyiqie、cgxfd）回归测试 "无退化"。

远端布局（已配置）：
- `origin` → `clawnet-ai/cc-reverse` (clawnet fork，PR 目标)
- `upstream` → `Crain99/cc-reverse` (原仓库)

## 5. 测试策略

测试金字塔：

```
E2E:           5 golden samples, baseline diffing
Integration:   per-module, ≥ 3 cases each
Unit:          vitest, coverage on utility & boundary code
```

框架：`vitest`。测试根目录：`test/{unit,integration,e2e}`。

Golden 样本（在外部 `~/code/cc-reverse-fixtures/` 管理，不入库）：

| 样本 | 引擎 | 来源 | 角色 |
|---|---|---|---|
| zqndtz | 3.x web-mobile, 4 bundles | `~/mini/zqndtz` | 3.x 主 golden |
| 3x-vanilla | 3.x cocos example | self-built via cocos-cli | 3.x 干净基线 |
| 3x-jsc | 3.x native + XXTEA | self-built | 加密脚本 |
| dabaoyiqie | 2.4.x bilibili | `~/mini/dabaoyiqie-reverse` | 2.x 仅回归 |
| cgxfd | 2.4.x bilibili + subpkg | `~/mini/cgxfd-reverse` | 2.x 仅回归 |

质量门（`cc-reverse validate <output-dir>`）：
1. 类名覆盖率 ≥ 80%（命名类 / 总类数）
2. 类型化字段覆盖率 ≥ 60%（非 `any` 字段 / 总字段数）
3. UUID 闭包：scenes/prefabs 中每个 `__uuid__` 都能在 `import/` 找到对应文件
4. 对发出的 Layer 6 工程执行 `tsc --noEmit` 退出码 0
5. `RECOVERY_REPORT.md` 中的资源数等于文件系统中的数量

每个 PR 的 CI 都对所有 golden 样本运行所有质量门；基线存放在 `test/baselines/<sample>/manifest.json`。失败的质量门要么修复，要么提交一次显式的 baseline-update commit 并附说明原因的注释。

## 6. 决策与风险

### 已锁定决策

- **范围**：本轮仅 3.x；2.x 下一轮，复用本轮基础设施。
- **外部工具**：webcrack + ts-morph + prettier 加入 deps。humanify 不是硬依赖 — 它是用户安装的 CLI，PR 5 用 `cc-reverse humanify <dir>` 包装。
- **humanify 的 LLM provider**：支持 `local`（默认，离线，可下载模型）和 `openai`（可配置 `OPENAI_BASE_URL`）；将 `copilot-api` 文档化为用户自担风险的选项，绝不自动安装。
- **Worktree 拓扑**：PR 3-5 堆叠；PR 1、2、6 独立。
- **SDK fingerprint 库**：覆盖国内 + 海外 SDK。
- **方法论范围**：完整 A–F。
- **脚本恢复层数**：7（原为 6 — 在 Copilot 讨论后将 Layer 7 humanify 加回）。

### 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| webcrack 漏掉 Cocos 特有的 SystemJS 形状 | 中 | 中 | PR 3 验收门是 "zqndtz 通过"；fallback 是手写的 Layer 1 |
| CCON v2 notepack 变种 | 中 | 高 | 1:1 移植 `external/deserialize/notepack_decode.js`；按分支做集成测试 |
| Layer 5 类型推断在大型项目上慢 | 低 | 中 | 缓存 + 增量索引；提供 `--no-type-infer` 逃生口 |
| humanify 本地模型下载被阻断 | 低 | 低 | 仅文档 fallback（手动下载路径） |
| Crain99/cc-reverse 上游漂移 | 中 | 低 | 每 PR 执行 `git fetch upstream main && rebase` 纪律 |
| 2.x 静默回归 | 中 | 高 | dabaoyiqie + cgxfd 在 CI 中作为仅回归套件 |

## 7. "本轮完成" 验收

全部 7 个 PR 合并。所有 3 个 3.x golden 样本通过全部 5 个质量门。2.x 回归套件无退化。CHANGELOG 覆盖每个 PR。README + skill SKILL.md 描述新管线。
