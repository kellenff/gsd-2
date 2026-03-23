# S04: Hot-path caller migration + cross-validation tests — Research

**Date:** 2026-03-23
**Status:** Ready for planning

## Summary

S04 migrates the six highest-frequency parser callers to DB queries and adds cross-validation tests proving DB state matches rendered-then-parsed state. The callers are: `dispatch-guard.ts` (parseRoadmapSlices → getMilestoneSlices), three `auto-dispatch.ts` rules (parseRoadmap → getMilestoneSlices for uat-verdict-gate, validating-milestone, completing-milestone), `auto-verification.ts` (parsePlan → getTask for verify command), and `parallel-eligibility.ts` (parseRoadmap + parsePlan → getMilestoneSlices + getSliceTasks for dependency and file-overlap analysis).

R016 requires a `sequence` column on slices and tasks tables so `getMilestoneSlices()` and `getSliceTasks()` `ORDER BY sequence` instead of `ORDER BY id`. This column does not exist yet — it needs a schema v9 migration and propagation to all six query functions that currently `ORDER BY id`.

The work is straightforward: each caller is a narrow transformation from "read file → parse markdown → extract field" to "call DB query → map field". No new architectural patterns needed — just wiring up existing DB functions and adding the sequence column.

## Recommendation

Build in three phases: (1) schema v9 migration adding `sequence` column + fixing all `ORDER BY` clauses (unblocks everything), (2) caller migrations in parallel since they're independent files, (3) cross-validation tests last since they need the migrated callers and sequence ordering to produce meaningful comparisons.

The cross-validation tests should follow the `derive-state-crossval.test.ts` pattern: create fixture data in DB via insert functions, render to markdown via renderers, parse back via parsers, and assert field parity. This proves renderer fidelity during the transition window.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/gsd-db.ts` — Needs `sequence INTEGER` column on `slices` and `tasks` tables via schema v9 migration. Six query functions need `ORDER BY sequence, id` (fallback to id when sequence is null/0). Query functions: `getMilestoneSlices()` (line 1391), `getSliceTasks()` (line 1242), `getActiveSliceFromDb()` (line 1364), `getActiveTaskFromDb()` (line 1382), `getAllMilestones()` (line 1341), `getActiveMilestoneFromDb()` (line 1355).
- `src/resources/extensions/gsd/dispatch-guard.ts` — 106 lines. `getPriorSliceCompletionBlocker()` reads ROADMAP from disk via `readRoadmapFromDisk()`, calls `parseRoadmapSlices()`, uses `slice.done`, `slice.id`, `slice.depends`. Replace with `getMilestoneSlices(mid)` mapping `status === 'complete'` → `done`, preserving `depends` array from DB. Remove `readFileSync` and `parseRoadmapSlices` import.
- `src/resources/extensions/gsd/auto-dispatch.ts` — Three rules use `parseRoadmap()`: **uat-verdict-gate** (line ~176, iterates completed slices to check UAT verdict files), **validating-milestone** (line ~507, checks all slices have SUMMARY files), **completing-milestone** (line ~564, same pattern). All three need `getMilestoneSlices(mid)` instead. The `loadFile`/`parseRoadmap` import can be narrowed after migration.
- `src/resources/extensions/gsd/auto-verification.ts` — Line ~71: parses full PLAN file to find `taskEntry.verify` for a specific task. Replace with `getTask(mid, sid, tid)?.verify`. Removes `parsePlan` and `loadFile` imports entirely.
- `src/resources/extensions/gsd/parallel-eligibility.ts` — Lines 45/55: `parseRoadmap()` for slice list, `parsePlan()` for `filesLikelyTouched`. Replace with `getMilestoneSlices(mid)` for slices and aggregate `getSliceTasks(mid, sid)` → `task.files` for file collection. The `parsePlan` and `parseRoadmap` imports can be removed.
- `src/resources/extensions/gsd/tests/dispatch-guard.test.ts` — 187 lines. Existing tests create ROADMAP files on disk and test `getPriorSliceCompletionBlocker`. After migration, tests must seed DB instead of writing markdown files. May need a parallel test approach: keep existing disk-based tests to prove backward compat, add DB-backed tests.
- `src/resources/extensions/gsd/tests/derive-state-crossval.test.ts` — 527 lines. The M001 cross-validation pattern. New cross-validation tests should follow this structure: setup fixture in DB via inserts → render to markdown → parse back → compare DB state vs parsed state field by field.

### Interface Mapping

| Parser field | DB equivalent | Notes |
|---|---|---|
| `RoadmapSliceEntry.done` | `SliceRow.status === 'complete'` | Direct boolean mapping |
| `RoadmapSliceEntry.id` | `SliceRow.id` | Same field |
| `RoadmapSliceEntry.depends` | `SliceRow.depends` | Both `string[]` |
| `RoadmapSliceEntry.title` | `SliceRow.title` | Same field |
| `RoadmapSliceEntry.risk` | `SliceRow.risk` | Same field |
| `RoadmapSliceEntry.demo` | `SliceRow.demo` | Same field |
| `SlicePlan.filesLikelyTouched` | `getSliceTasks(mid, sid).flatMap(t => t.files)` | Aggregated from task rows |
| `TaskPlanEntry.verify` | `TaskRow.verify` | Direct field |

### Build Order

1. **Schema v9 + sequence ordering** — Add `sequence INTEGER DEFAULT 0` to slices and tasks tables. Update all six `ORDER BY id` queries to `ORDER BY sequence, id`. This is the prerequisite for R016 and must land first because all caller migrations depend on correct query ordering. Backfill sequence from positional order of existing rows.
2. **Caller migrations** — dispatch-guard.ts, auto-verification.ts, and the three auto-dispatch.ts rules can be migrated independently. parallel-eligibility.ts too. Each is a self-contained file change.
3. **Cross-validation tests** — Write tests that exercise the DB→render→parse round-trip for ROADMAP (slices with completion state, depends, risk) and PLAN (tasks with verify, files, description). These prove R014: renderer fidelity during the transition window.
4. **Test updates** — Update dispatch-guard.test.ts to seed DB state instead of writing markdown files. This is downstream of the dispatch-guard migration.

### Verification Approach

- Run all existing tests with the resolver harness to confirm no regressions: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-guard.test.ts src/resources/extensions/gsd/tests/derive-state-crossval.test.ts`
- Run new cross-validation tests: the new test file proves DB↔parsed field parity across multiple fixture scenarios
- Run slice-level proof: all S04 test files pass under the resolver harness
- Verify the four hot-path files no longer import parser functions (grep for `parseRoadmapSlices`, `parseRoadmap`, `parsePlan` in the migrated files)

## Constraints

- **Resolver-based test harness required** — Tests must run under `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test`. Bare `node --test` fails on `.js` sibling specifiers.
- **No ESM monkey-patching for cache tests** — Verify cache invalidation through observable parse-visible state, not by spying on imported ESM bindings. This was learned in S01 and recorded in KNOWLEDGE.md.
- **`deleteTask()` requires manual FK cascade** — No `ON DELETE CASCADE` in schema. When tests clean up: evidence → tasks → slices. This matters if cross-validation tests need teardown between scenarios.
- **`upsertSlicePlanning()` vs `updateSliceFields()`** — Planning fields use the former, basic metadata (title, risk, depends, demo) uses the latter. Caller migration code should use the existing query functions, not introduce new ones.
- **`dispatch-guard.ts` reads from working tree, not git** — The migration must preserve this semantic: DB state is always current (like disk), not committed state. Since DB is the write target for planning tools, this is satisfied by default.
- **`parallel-eligibility.ts` uses `deriveState()`** — This file also calls `deriveState(basePath)` for milestone status. That function already has a DB path (`deriveStateFromDb`). The migration should not change the `deriveState` call — only replace the parser calls within `collectTouchedFiles`.

## Common Pitfalls

- **Forgetting fallback when DB is empty** — dispatch-guard and auto-dispatch currently read from disk. If DB has no slices (pre-migration project), `getMilestoneSlices()` returns `[]` which could unblock all dispatches incorrectly. Callers should check for empty DB results and potentially fall back to disk parsing during the transition, OR the migration path (S05's `migrateHierarchyToDb`) guarantees DB is populated before callers run.
- **`ORDER BY sequence, id` with NULL sequence** — SQLite sorts NULLs first by default. Use `ORDER BY COALESCE(sequence, 999999), id` or `DEFAULT 0` to ensure pre-migration rows sort lexicographically by id when sequence hasn't been set.
- **dispatch-guard test coupling to markdown format** — The 187-line test file writes ROADMAP markdown to disk and tests the function. After migration, these fixtures need DB seeding instead. Don't try to make the function work with both paths simultaneously — pick DB and update tests.
- **Removing too many imports from auto-dispatch.ts** — Only 3 of the 18 rules use `parseRoadmap`. The file still has other `loadFile` and `parseRoadmap` usages outside S04's scope (warm/cold callers in S05). Only narrow the import, don't remove it entirely yet.
