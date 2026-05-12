# Next Round — 2.x Optimization Backlog

Date opened: 2026-05-12
Owner: TBD
Prerequisite: 3.x overhaul (this round) merged.

This backlog captures 2.x improvements deferred from the 3.x round. Reused infrastructure from the 3.x round will absorb most of the work; the items below are the residual 2.x-specific scope.

## Carried-over Wave items

- **R2. settings.js safe parsing**
  Replace `eval()` (reverseEngine.js:371) with a `vm.createContext` sandbox; reject on access to `process`, `require`, etc.

- **R13. Atlas timing fix**
  SpriteFrame is currently processed before SpriteAtlas, breaking references. Reorder pass or do a two-phase resolution.

## 2.x script recovery enhancements

- Apply the 6-layer pipeline (chunk-split → ESM → class → ccclass → type-infer → ts-emit) to 2.x's `project.js` module pack.
- AST shape assumption at codeAnalyzer.js:51 (`node.value.elements[0].params`) is brittle — replace with structural matching.
- 2.x compressed array → object recovery already works; reuse it as the type source for 2.x Layer 5.

## 2.x test gold-sample integration

- Promote `~/mini/dabaoyiqie-reverse` and `~/mini/cgxfd-reverse` from regression-only to active samples.
- Add 2.3.x sample (build via cocos-cli or find a real one).

## Methodology skill extensions

- Add 2.x specifics to `output-layers.md` (project.js layer naming) and `analyzing-scripts.md` (legacy 2.x decorators, `cc.Class.extend` patterns).
- Update `cocos2x-format.md` if any new findings.

## Open questions for that round

- Is there demand for 2.3.x specifically, or is 2.4.x enough?
- Should 2.x adopt the same TS-output target as 3.x, or keep `.ts` (current default) without ts-morph?
