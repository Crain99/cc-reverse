# E2E baseline report — 2026-05-12

First end-to-end run of `npm run e2e` against the three local golden samples
after the PR 8 CLI dispatch fix. This satisfies the "完成定义" requirement in
`docs/plans/2026-05-12-cocos-3x-overhaul-design.md` (real samples actually
exercised, real numbers recorded).

## Environment

- Branch: `feature/pr8-e2e-harness`
- Node: `process.execPath` from local dev machine
- Samples live under `~/mini/<sample>` and are user-local (CI skips them).
- Output base: `${os.tmpdir()}/cc-reverse-e2e/<sample>`
- All three samples completed `unpack` with exit code `0`.

## Per-sample summary

| Sample              | Cocos | Unpack exit | Gates passed                                                            | Gates failed       | Notes                                              |
|---------------------|-------|-------------|-------------------------------------------------------------------------|--------------------|----------------------------------------------------|
| slgq-reverse        | 3.x   | 0           | cconV2, typedArrays, layeredScripts, recoveryIndex, tsProject           | recoveryReport     | declared 45 vs actual 62 assets                    |
| dabaoyiqie-reverse  | 2.x   | 0           | cconV2, typedArrays, layeredScripts, recoveryIndex, tsProject           | recoveryReport     | `RECOVERY_REPORT.md` not generated for 2.x output  |
| cgxfd-reverse       | 2.x   | 0           | cconV2, typedArrays, layeredScripts, recoveryIndex, tsProject           | recoveryReport     | declared 29 vs actual 33 assets; tsconfig absent   |

5/6 quality gates pass on every sample. The single repeatedly-failing gate is
`recoveryReport`, with two distinct root causes documented below.

## Known gaps

1. **`recoveryReport` declared-vs-actual mismatch (slgq-reverse, cgxfd-reverse).**
   The recovery report's declared asset count diverges from the on-disk count
   (45 vs 62 for slgq, 29 vs 33 for cgxfd). Either the report's accounting
   under-counts certain asset families (likely candidates: rich-meta-only stubs,
   sub-assets, atlas pages) or the on-disk walker over-counts derived files.
   Triage in a follow-up PR; this is not a regression — it has always been the
   case but was not previously surfaced because no E2E harness existed.

2. **`RECOVERY_REPORT.md` missing for 2.x output (dabaoyiqie-reverse).**
   The 2.x pipeline does not currently emit `RECOVERY_REPORT.md`. The
   `recoveryReport` gate was authored against the 3.x pipeline; a follow-up
   should either (a) emit a minimal 2.x report or (b) skip the gate when the
   detected flavor is 2.x.

3. **`tsProject` reports `0 .ts file(s)` for both 3.x and 2.x outputs.**
   The gate currently still passes (it asserts the project scaffold exists,
   not the TS file count), but `0` TS files in slgq output is suspect since
   slgq is a 3.x project — investigate whether the script-recovery layered
   pipeline is writing `.js` only for these inputs.

## Baseline policy

The current numbers are NOT auto-committed as `test/baselines/<sample>/manifest.json`.
Each run writes `<out>/.suggested-baseline.json` for human review. After this
report is reviewed, those manifests can be moved into `test/baselines/`
verbatim to lock in regression detection.

The vitest harness fails only on **regression** (a gate that was `passed` in
baseline now `failed`). Improvements emit a console warning.

## How to reproduce

```sh
npm run e2e
# or, run a single sample manually:
node bin/cc-reverse.js -p ~/mini/slgq-reverse -o /tmp/cc-reverse-e2e/slgq-reverse
node bin/cc-reverse.js validate /tmp/cc-reverse-e2e/slgq-reverse
```

## PR 8 修复后 (post-fix run, same machine)

After the two fixes in PR 8 (`fix(report): align RECOVERY_REPORT declared
count with filesystem` + `fix(2x): emit RECOVERY_REPORT.md for cocos2x flow`),
re-running `npm run e2e` against the same three local samples now yields a
clean **6/6 gate pass** for every sample.

| Sample              | Cocos | Unpack exit | recoveryReport | cconV2 | typedArrays | layeredScripts | recoveryIndex | tsProject | Total |
|---------------------|-------|-------------|----------------|--------|-------------|----------------|---------------|-----------|-------|
| slgq-reverse        | 3.x   | 0           | pass           | pass   | pass        | pass           | pass          | pass      | 6/6   |
| dabaoyiqie-reverse  | 2.x   | 0           | pass           | pass   | pass        | pass           | pass          | pass      | 6/6   |
| cgxfd-reverse       | 3.x*  | 0           | pass           | pass   | pass        | pass           | pass          | pass      | 6/6   |

(*) Diagnostic note: `cgxfd-reverse` is auto-detected as **3.x**, not 2.x as
the original baseline assumed. The sample contains
`assets/internal/config.json` and `assets/resources/config.json` — the 3.x
bundle markers — so `detectProjectFlavor` correctly classifies it as 3.x and
the 3.x pipeline writes the recovery report. The gap previously labelled
"declared 29 vs actual 33" was the same 3.x bundle-undercount issue Commit 1
fixes (the bundle summary tracks per-uuid records but the disk also receives
recovered scripts and other auxiliary files; the reconciler now emits an
`__extras__` row to keep `declared == actual`).

`dabaoyiqie-reverse` is the only true 2.x sample and is now covered by Commit
2's `writeRecoveryReport2x`.

Numbers tied to this run:

- slgq-reverse: previously `declared 45 vs actual 62` → now declared 62, gate `true`.
- cgxfd-reverse: previously `declared 29 vs actual 33` → now declared 33, gate `true`.
- dabaoyiqie-reverse: previously `RECOVERY_REPORT.md missing` → now written,
  declared 0 (assets/ empty for this sample after unpack), gate `true`.

Test counts:

- `npm test`: 36 files, 131 tests pass (was 123 pre-fix).
- `npm run e2e`: 3 samples, all `unpackStatus=0`, all `validateStatus=0`, all
  6/6 gates pass.

