# Cocos Creator 3.x Reverse Engineering Overhaul — Design

Date: 2026-05-12
Scope: cc-reverse 3.x pipeline + cocos-reverse-engineering-skill methodology
Status: Approved (brainstorming complete)
Out-of-scope: 2.x optimization (deferred to next round, see `NEXT-ROUND-2x-backlog.md`)

## 1. Goals

Bring 3.x reverse engineering from "structurally hollow" to "production-grade":

1. Real script recovery (not chunk copying) — System.register chunks decompile into a TypeScript project with restored class names, decorators, and inferred field types.
2. Complete 3.x asset deserialization — CCON v2, IPackedFileData, TypedArray, cross-bundle redirect.
3. Honest project metadata — generated `project.json` reflects the actual source build instead of hardcoded constants.
4. Methodology-grade skill — the companion `cocos-reverse-engineering` plugin teaches users *how* to use the output, not just *how to run the tool*.

Non-goals this round:
- 2.x improvements (will reuse this round's infrastructure next round).
- Recovering minified variable names without a sourcemap (Layer 7 humanify is opt-in, ships unconfigured).
- Native binary unpacking (.so / .dll script extraction).

## 2. Architecture Overview

### 2.1 Script recovery — 7 layers

New module tree under `src/core/cocos3x/scriptRecovery/`:

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

Each layer:
- Accepts and returns Babel AST (no re-parse between layers).
- Fails closed: layer crash → downstream uses upstream output → worst case is current behaviour (raw chunk copy).
- Toggleable via `--script-layers <1-7>`.

External tools we lean on (avoid reinventing):
- `webcrack` — drives Layer 1 + most of Layer 2 + Layer 3's `__extends` undoing.
- `@babel/*` — already a project dep, used for Cocos-specific ASTs.
- `ts-morph` — Layer 6 TS emission (cleaner than Babel for TS decorators).
- `prettier` — final formatting.
- `humanify` (local mode) — Layer 7, optional, user installs separately. Documentation also explains the GitHub Copilot route via `copilot-api` as a user-borne risk option (see §6).

### 2.2 Resource pipeline — Wave 0/1/2/3

Identified weaknesses, grouped by "is unblocked by previous wave":

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

Removed from plan (kicked to next 2.x round):
- R2 settings.js eval safety (2.x exclusive code path).
- R13 atlas timing (primarily a 2.x sprite-frame-before-atlas issue).

### 2.3 PR sequence

Stacked worktree topology (see §4):

```
PR 1: Wave 0 (R1, R3, R4)                       ~400 LOC
PR 2: Wave 1 (R5–R8)                            ~1200 LOC
PR 3: Script Layer 1–3 (webcrack integration)   ~400 LOC
PR 4: Script Layer 4–6 (cocos + type inference) ~1000 LOC
PR 5: Wave 2 (R9–R12) + Layer 7                 ~800 LOC
PR 6: Wave 3 (R14–R16)                          ~600 LOC
PR 7: skill methodology A–F (separate repo)     6 docs + SKILL.md refactor
```

Merge order = list order. PR 3 starts after PR 2 because Layer 5's type inference reads scene/prefab JSON which depends on Wave 1 fixes.

## 3. Methodology Skill — A–F all in

`cocos-reverse-engineering-skill` companion plugin gains a 7-phase workflow (was 5):

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

Six new reference files under `references/`:

| File | Topic |
|---|---|
| `legal-preflight.md` | DMCA §1201(f), EU 2009/24 art.6, China copyright art.24(4) — quick checklist |
| `triage.md` | Scope-driven invocation patterns |
| `output-layers.md` | When to use raw chunks vs ESM vs TS project |
| `quality-gates.md` | 5 gates: class-name coverage ≥ 80%, typed-field coverage ≥ 60%, UUID closure, tsc --noEmit, RECOVERY_REPORT cross-check |
| `recovery-decisions.md` | Decision tree for partial / failing pipeline runs |
| `analyzing-scripts.md` | Reading recovered TS, dependency graph, SDK fingerprint library (CN: 友盟 / 微信 / 字节 / 腾讯 / Bugly. International: AppLovin / Unity Ads / GameAnalytics / Firebase / IronSource) |

`SKILL.md` gains a top-level "Reverse Engineering Principles" section codifying the methodology.

## 4. Worktree & PR Workflow

Layout under `.worktrees/` (gitignored, project-local):

```
.worktrees/
  pr1-wave0-foundation/        branched from main
  pr2-wave1-3x-deserialize/    branched from main
  pr3-scripts-layer1-3/        branched from pr2 head (stacked)
  pr4-scripts-layer4-6/        branched from pr3 head (stacked)
  pr5-wave2-and-humanify/      branched from pr4 head (stacked)
  pr6-wave3-extended-assets/   branched from main
```

Skill repo (`/Users/lcf/code/cocos-reverse-engineering-skill/`) gets PR 7 in its own `.worktrees/pr7-skill-methodology-AF/`, started after PR 5 merges (so layered output is real).

Per-PR Definition of Done:
1. Design doc section flagged "implemented".
2. ≥ 1 golden sample passes E2E (`npm run e2e -- <sample>`).
3. All 5 quality gates either pass or have a "known regression" entry in baseline.
4. CHANGELOG entry added.
5. README sections updated where user-visible.
6. 2.x golden samples (dabaoyiqie, cgxfd) regression-tested for "no degradation".

Remote layout (already configured):
- `origin` → `clawnet-ai/cc-reverse` (clawnet fork, target for PRs)
- `upstream` → `Crain99/cc-reverse` (original)

## 5. Testing Strategy

Test pyramid:

```
E2E:           5 golden samples, baseline diffing
Integration:   per-module, ≥ 3 cases each
Unit:          vitest, coverage on utility & boundary code
```

Framework: `vitest`. Test root: `test/{unit,integration,e2e}`.

Golden samples (managed in external `~/code/cc-reverse-fixtures/`, not committed):

| Sample | Engine | Source | Role |
|---|---|---|---|
| zqndtz | 3.x web-mobile, 4 bundles | `~/mini/zqndtz` | 3.x main golden |
| 3x-vanilla | 3.x cocos example | self-built via cocos-cli | 3.x clean baseline |
| 3x-jsc | 3.x native + XXTEA | self-built | encrypted scripts |
| dabaoyiqie | 2.4.x bilibili | `~/mini/dabaoyiqie-reverse` | 2.x regression-only |
| cgxfd | 2.4.x bilibili + subpkg | `~/mini/cgxfd-reverse` | 2.x regression-only |

Quality gates (`cc-reverse validate <output-dir>`):
1. Class-name coverage ≥ 80% (named classes / total classes)
2. Typed-field coverage ≥ 60% (non-`any` fields / total fields)
3. UUID closure: every `__uuid__` in scenes/prefabs resolves to a file in `import/`
4. `tsc --noEmit` exit 0 against emitted Layer 6 project
5. `RECOVERY_REPORT.md` asset count equals filesystem count

Each PR's CI runs all gates against all golden samples; baselines stored at `test/baselines/<sample>/manifest.json`. A failing gate must either be fixed or get an explicit baseline-update commit with a comment explaining why.

## 6. Decisions & Risks

### Locked decisions

- **Scope**: 3.x only this round; 2.x next round, reusing this round's infrastructure.
- **External tools**: webcrack + ts-morph + prettier in deps. humanify NOT a hard dep — it's a user-installed CLI that PR 5 wraps with `cc-reverse humanify <dir>`.
- **LLM provider for humanify**: support `local` (default, offline, downloadable model) and `openai` (configurable `OPENAI_BASE_URL`); document `copilot-api` as a user-borne risk option, never auto-installed.
- **Worktree topology**: stacked PR 3-5; independent PR 1, 2, 6.
- **SDK fingerprint library**: covers CN + international SDKs.
- **Methodology scope**: full A–F.
- **Script recovery layers**: 7 (was 6 — Layer 7 humanify added back after Copilot discussion).

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| webcrack misses Cocos-specific SystemJS shapes | medium | medium | PR 3 acceptance gate is "zqndtz pass"; fallback is hand-rolled Layer 1 |
| CCON v2 notepack variants | medium | high | port `external/deserialize/notepack_decode.js` 1:1; integration test per branch |
| Layer 5 type inference slow on large projects | low | medium | cache + incremental indexing; `--no-type-infer` escape hatch |
| humanify local model download blocked | low | low | doc-only fallback (manual download path) |
| Crain99/cc-reverse upstream drift | medium | low | per-PR `git fetch upstream main && rebase` discipline |
| 2.x regression broken silently | medium | high | dabaoyiqie + cgxfd in CI as regression-only suite |

## 7. Acceptance for "round complete"

All 7 PRs merged. All 3 3.x golden samples pass all 5 quality gates. 2.x regression suite shows no degradation. CHANGELOG covers each PR. README + skill SKILL.md describe the new pipeline.
