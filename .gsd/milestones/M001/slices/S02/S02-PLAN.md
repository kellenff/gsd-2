# S02: plan_slice + plan_task tools + PLAN/task-plan renderers

**Goal:** Add DB-backed slice and task planning write paths that persist flat planning payloads, render parse-compatible `S##-PLAN.md` and `tasks/T##-PLAN.md` artifacts from DB state, and keep task plan files present on disk so planning/execution recovery continues to work.
**Demo:** Running the S02 planning proof writes slice/task planning data through `gsd_plan_slice` and `gsd_plan_task`, regenerates `S02-PLAN.md` and `tasks/T01-PLAN.md`/`tasks/T02-PLAN.md` from DB, and passes runtime checks that reject missing task plan files.

## Must-Haves

- `gsd_plan_slice` validates a flat payload, requires an existing slice, writes slice planning plus task rows transactionally, renders `S##-PLAN.md`, and clears both state and parse caches. (R003)
- `gsd_plan_task` validates a flat payload, requires an existing parent slice, writes task planning fields, renders `tasks/T##-PLAN.md`, and clears both caches. (R004)
- `renderPlanFromDb()` and `renderTaskPlanFromDb()` emit markdown that still round-trips through `parsePlan()` / `parseTaskPlanFile()` and satisfies `auto-recovery.ts` plan-slice artifact checks, including on-disk task plan existence. (R008, R019)
- Prompt and tool registration surfaces expose the new DB-backed planning path instead of leaving slice/task planning as direct file writes.

## Proof Level

- This slice proves: integration
- Real runtime required: yes
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/prompt-contracts.test.ts --test-name-pattern="plan-slice|plan-task|renderPlanFromDb|renderTaskPlanFromDb|task plan|DB-backed planning"`

## Observability / Diagnostics

- Runtime signals: handler error strings for validation / DB write / render failure, plus stale-render diagnostics from `markdown-renderer.ts` when rendered plan artifacts drift from DB state.
- Inspection surfaces: `src/resources/extensions/gsd/tests/plan-slice.test.ts`, `src/resources/extensions/gsd/tests/plan-task.test.ts`, `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`, `src/resources/extensions/gsd/tests/auto-recovery.test.ts`, and SQLite rows returned by `getSlice()`, `getTask()`, and `getSliceTasks()`.
- Failure visibility: failed handler result payloads, missing `tasks/T##-PLAN.md` artifact assertions, and renderer/parser mismatches surfaced by the resolver-based test harness.
- Redaction constraints: no secrets expected; task-plan frontmatter must expose skill names only, never secret values or environment data.

## Integration Closure

- Upstream surfaces consumed: `src/resources/extensions/gsd/tools/plan-milestone.ts`, `src/resources/extensions/gsd/bootstrap/db-tools.ts`, `src/resources/extensions/gsd/gsd-db.ts`, `src/resources/extensions/gsd/markdown-renderer.ts`, `src/resources/extensions/gsd/files.ts`, `src/resources/extensions/gsd/auto-recovery.ts`, and `src/resources/extensions/gsd/prompts/plan-slice.md`.
- New wiring introduced in this slice: canonical tool handlers/registrations for `gsd_plan_slice` and `gsd_plan_task`, DB→markdown renderers for slice and task plans, and prompt-contract coverage that points planning flows at those tools.
- What remains before the milestone is truly usable end-to-end: S03 still needs replan/reassess structural enforcement, and S04 still needs hot-path caller migration plus DB↔rendered cross-validation.

## Tasks

I’m splitting this into three tasks because there are three distinct failure boundaries and each needs its own proof. The highest-risk boundary is renderer compatibility: if the generated `PLAN.md` or task-plan markdown drifts from parser/runtime expectations, the rest of the slice is fake progress. That work goes first and includes the runtime contract around `skills_used` frontmatter and task-plan file existence. Once the render target is stable, the handler/registration work becomes straightforward because S01 already established the validation → transaction → render → invalidate pattern. The last task is prompt/tool-surface closure, which is intentionally small but necessary: without it, the system still has a gap between the new DB-backed implementation and the planning instructions/registrations the LLM actually sees.

- [x] **T01: Add DB-backed slice and task plan renderers with compatibility tests** `est:1.5h`
  - Why: This closes the main transition-window risk first: rendered plan artifacts must stay parse-compatible and satisfy runtime recovery checks before any new planning handler can be trusted.
  - Files: `src/resources/extensions/gsd/markdown-renderer.ts`, `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`, `src/resources/extensions/gsd/tests/auto-recovery.test.ts`, `src/resources/extensions/gsd/files.ts`
  - Do: Implement `renderPlanFromDb()` and `renderTaskPlanFromDb()` using existing DB query helpers, emit slice/task markdown that preserves `parsePlan()` and `parseTaskPlanFile()` expectations, include conservative task-plan frontmatter (`estimated_steps`, `estimated_files`, `skills_used`), and add tests that prove rendered slice plans plus task plan files satisfy `verifyExpectedArtifact("plan-slice", ...)`.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts --test-name-pattern="renderPlanFromDb|renderTaskPlanFromDb|plan-slice|task plan"`
  - Done when: DB rows can be rendered into `S##-PLAN.md` and `tasks/T##-PLAN.md` files that parse cleanly and pass the existing plan-slice runtime artifact checks.
- [ ] **T02: Implement and register gsd_plan_slice and gsd_plan_task** `est:1.5h`
  - Why: This delivers the actual S02 capability: flat DB-backed planning tools for slices and tasks that write structured planning state, render truthful markdown, and clear stale caches after success.
  - Files: `src/resources/extensions/gsd/tools/plan-slice.ts`, `src/resources/extensions/gsd/tools/plan-task.ts`, `src/resources/extensions/gsd/bootstrap/db-tools.ts`, `src/resources/extensions/gsd/gsd-db.ts`, `src/resources/extensions/gsd/tests/plan-slice.test.ts`, `src/resources/extensions/gsd/tests/plan-task.test.ts`
  - Do: Follow the S01 handler pattern exactly for both tools, add any missing DB upsert/query helpers needed to populate task planning fields and retrieve slice/task planning state, register canonical tools plus aliases in `db-tools.ts`, and test validation, missing-parent rejection, transactional DB writes, render-failure handling, idempotent reruns, and observable cache invalidation.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts`
  - Done when: `gsd_plan_slice` and `gsd_plan_task` exist as registered DB tools, reject malformed input, render plan artifacts after successful writes, and refresh parse-visible state immediately.
- [ ] **T03: Close prompt and contract coverage around DB-backed slice planning** `est:45m`
  - Why: The implementation is incomplete until the planning prompt/test surface actually points at the new tools and proves the DB-backed route is the expected contract instead of manual markdown edits.
  - Files: `src/resources/extensions/gsd/prompts/plan-slice.md`, `src/resources/extensions/gsd/tests/prompt-contracts.test.ts`, `src/resources/extensions/gsd/bootstrap/db-tools.ts`, `src/resources/extensions/gsd/tests/plan-slice-prompt.test.ts`
  - Do: Update the slice planning prompt text to require tool-backed planning state when `gsd_plan_slice` / `gsd_plan_task` are available, tighten prompt-contract assertions for the new tools, and add/adjust prompt template tests so the planning surface stays aligned with the registered tool path.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-contracts.test.ts src/resources/extensions/gsd/tests/plan-slice-prompt.test.ts --test-name-pattern="plan-slice|plan task|DB-backed"`
  - Done when: slice planning prompts and prompt tests explicitly reference the DB-backed slice/task planning tools and no longer leave direct plan-file writes as the intended path.

## Files Likely Touched

- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/markdown-renderer.ts`
- `src/resources/extensions/gsd/tools/plan-slice.ts`
- `src/resources/extensions/gsd/tools/plan-task.ts`
- `src/resources/extensions/gsd/bootstrap/db-tools.ts`
- `src/resources/extensions/gsd/prompts/plan-slice.md`
- `src/resources/extensions/gsd/tests/plan-slice.test.ts`
- `src/resources/extensions/gsd/tests/plan-task.test.ts`
- `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts`
- `src/resources/extensions/gsd/tests/prompt-contracts.test.ts`
- `src/resources/extensions/gsd/tests/plan-slice-prompt.test.ts`
