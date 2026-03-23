---
id: T01
parent: S02
milestone: M001
key_files:
  - src/resources/extensions/gsd/markdown-renderer.ts
  - src/resources/extensions/gsd/tests/markdown-renderer.test.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - .gsd/KNOWLEDGE.md
key_decisions:
  - Rendered task-plan files use conservative `skills_used: []` frontmatter so execution-time skill activation remains explicit and no secret-bearing or speculative values are emitted from DB state.
  - Slice-plan verification content is sourced from the slice `observability_impact` field when present so the DB-backed renderer preserves inspectable diagnostics/failure-path expectations instead of emitting a placeholder-only section.
  - `renderPlanFromDb()` eagerly renders all child task-plan files after writing the slice plan so `verifyExpectedArtifact("plan-slice", ...)` sees a truthful on-disk artifact set immediately.
duration: ""
verification_result: mixed
completed_at: 2026-03-23T15:58:46.134Z
blocker_discovered: false
---

# T01: Add DB-backed slice and task plan renderers with compatibility and recovery tests

**Add DB-backed slice and task plan renderers with compatibility and recovery tests**

## What Happened

Implemented DB-backed plan rendering in `src/resources/extensions/gsd/markdown-renderer.ts` by adding `renderPlanFromDb()` and `renderTaskPlanFromDb()`. The slice-plan renderer now reads slice/task rows from SQLite, emits parse-compatible `S##-PLAN.md` content with goal, demo, must-haves, verification, checklist tasks, and files-likely-touched, then persists the artifact to disk and the artifacts table. The task-plan renderer now emits `tasks/T##-PLAN.md` files with conservative YAML frontmatter (`estimated_steps`, `estimated_files`, `skills_used: []`) plus `Steps`, `Inputs`, `Expected Output`, `Verification`, and optional `Observability Impact` sections. Extended `markdown-renderer.test.ts` to prove DB-backed plan rendering round-trips through `parsePlan()` and `parseTaskPlanFile()`, writes truthful on-disk artifacts, stores those artifacts in SQLite, and surfaces clear failure behavior for missing task rows. Extended `auto-recovery.test.ts` to prove a rendered slice plan plus rendered task-plan files satisfies `verifyExpectedArtifact("plan-slice", ...)`, and that deleting a rendered task-plan file still fails recovery verification as intended. Also recorded the local verification gotcha in `.gsd/KNOWLEDGE.md`: the slice plan references `plan-slice.test.ts` / `plan-task.test.ts`, but those files are not present in this checkout, so the resolver-harness renderer/recovery/prompt tests are currently the inspectable proof surface for this task.

## Verification

Verified the task contract with the targeted resolver-harness command for `markdown-renderer.test.ts` and `auto-recovery.test.ts`; all renderer and recovery assertions passed, including explicit failure-path checks for missing task-plan files and stale-render diagnostics. Ran the broader slice-level resolver-harness command covering `markdown-renderer.test.ts`, `auto-recovery.test.ts`, and `prompt-contracts.test.ts`; it passed and confirmed the DB-backed planning prompt contract remains aligned. Attempted the slice-plan verification command for `plan-slice.test.ts` and `plan-task.test.ts`, then confirmed those referenced files do not exist in this checkout, so that command cannot currently execute here. This is a checkout/test-surface mismatch, not a regression introduced by this task.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts --test-name-pattern="renderPlanFromDb|renderTaskPlanFromDb|plan-slice|task plan"` | 0 | ✅ pass | 693ms |
| 2 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts` | 1 | ❌ fail | 51ms |
| 3 | `ls src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts src/resources/extensions/gsd/tests/prompt-contracts.test.ts` | 1 | ❌ fail | 0ms |
| 4 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/prompt-contracts.test.ts --test-name-pattern="plan-slice|plan-task|renderPlanFromDb|renderTaskPlanFromDb|task plan|DB-backed planning"` | 0 | ✅ pass | 697ms |


## Deviations

Did not edit `src/resources/extensions/gsd/files.ts`; the existing parser contract already accepted the truthful renderer output. The slice plan’s referenced `plan-slice.test.ts` and `plan-task.test.ts` verification command could not be executed because those files are absent in the working tree, so I documented that local mismatch and used the existing resolver-harness renderer/recovery/prompt tests as the effective proof surface.

## Known Issues

The slice plan still references `src/resources/extensions/gsd/tests/plan-slice.test.ts` and `src/resources/extensions/gsd/tests/plan-task.test.ts`, but neither file exists in this checkout. Until those tests land, slice-level verification for planning work must rely on the existing `markdown-renderer.test.ts`, `auto-recovery.test.ts`, and related prompt-contract tests.

## Files Created/Modified

- `src/resources/extensions/gsd/markdown-renderer.ts`
- `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts`
- `.gsd/KNOWLEDGE.md`
