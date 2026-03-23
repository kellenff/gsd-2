---
estimated_steps: 5
estimated_files: 16
skills_used: []
---

# T02: Strip all 16 lazy createRequire fallback paths from migrated callers

**Slice:** S06 — Parser deprecation + cleanup
**Milestone:** M001

## Description

Remove all `createRequire` imports, lazy parser singletons, and `else` fallback branches from the 16 files that were migrated to DB-primary in S04-S05. Each file currently has an `if (isDbAvailable()) { ...DB path... } else { ...parser fallback via createRequire... }` pattern. The `else` branches are dead code now that parsers are relocated to `parsers-legacy.ts` — the lazy singletons were importing from `files.ts` which no longer exports parsers. Replace each pattern with just the DB path, returning early/empty when DB is unavailable.

## Steps

1. **Strip hot-path callers (4 files):**
   - `dispatch-guard.ts`: Remove `import { createRequire } from "node:module"` (line 4). Remove the `_lazyParser` variable and `lazyParseRoadmapSlices()` function (lines 10-23). In `getPriorSliceCompletionBlocker()`, remove the `else` branch that reads the roadmap file and calls `lazyParseRoadmapSlices()` — when `!isDbAvailable()`, return `null`.
   - `auto-dispatch.ts`: Remove `import { createRequire } from "node:module"` (line 17). Remove `_lazyParseRoadmap` singleton (lines 19-29). At each of the 3 `if (isDbAvailable())` blocks (~lines 192, 532, 600), remove the `else` branch — when DB unavailable, skip/return empty.
   - `auto-verification.ts`: Remove `import { createRequire } from "node:module"` (line 16). Remove the inline `createRequire` fallback block (~lines 71-83) — when DB unavailable, return early.
   - `parallel-eligibility.ts`: Remove `import { createRequire } from "node:module"` (line 12). Remove the inline `createRequire` fallback block (~line 57+) — when DB unavailable, return empty eligibility.

2. **Strip warm-path callers batch 1 (7 files):**
   - `doctor.ts`: Remove `import { createRequire } from "node:module"` (line 19). Remove `_lazyParsers` singleton (~lines 21-28). At each `else` branch, skip/return empty.
   - `doctor-checks.ts`: Remove `import { createRequire } from "node:module"` (line 23). Remove `_lazyParseRoadmap` singleton (~lines 25-32). At each `else` branch, skip/return empty.
   - `visualizer-data.ts`: Remove `import { createRequire } from 'node:module'` (line 41). Remove `_lazyParsers` singleton (~lines 43-50). At `else` branches, return empty data.
   - `workspace-index.ts`: Remove `import { createRequire } from "node:module"` (line 19). Remove `_lazyParsers` singleton (~lines 21-28). The `titleFromRoadmapHeader` function at line 80 uses parser-only path with no DB equivalent — make it return `null` when DB unavailable (the caller already handles null).
   - `dashboard-overlay.ts`: Remove `import { createRequire } from "node:module"` (line 31). Remove `_lazyParsers` singleton (~lines 33-40). At `else` branches, return empty/skip.
   - `auto-dashboard.ts`: Remove `import { createRequire } from "node:module"` (line 30). Remove `_lazyParsers` singleton (~lines 32-39). At `else` branches, return empty/skip.
   - `guided-flow.ts`: Remove `import { createRequire } from "node:module"` (line 43). Remove `_lazyParseRoadmap` singleton (~lines 45-52). At `else` branches, return empty.

3. **Strip warm-path callers batch 2 (5 files):**
   - `auto-prompts.ts`: Remove both `lazyParseRoadmap()` and `lazyParsePlan()` async helper functions (~lines 32-49). At each of the 6 call sites, replace `lazyParseRoadmap()`/`lazyParsePlan()` calls with just the DB path. When DB unavailable, use empty arrays/null.
   - `auto-recovery.ts`: Remove `import { createRequire } from "node:module"` (line 13). Remove both inline `createRequire` fallback blocks (~lines 378-385, ~lines 424-430). Keep the DB path only.
   - `auto-direct-dispatch.ts`: Remove both inline `createRequire` + fallback blocks (~lines 164-173, ~lines 199-208). These are `await import("node:module")` style — remove the entire `else` blocks.
   - `auto-worktree.ts`: Remove `import { createRequire } from "node:module"` (line 21). Remove the `createRequire` fallback at ~line 1009. Keep DB path.
   - `reactive-graph.ts`: Remove the `createRequire` + fallback block (~lines 208-215). Keep DB path.

4. **Verify: no `createRequire` references remain in any of the 16 files** using the grep commands.

5. **Run the full test suite** to confirm no regressions — doctor.test.ts, auto-dashboard.test.ts, auto-recovery.test.ts, derive-state-db.test.ts, derive-state-crossval.test.ts, gsd-recover.test.ts, flag-file-db.test.ts, plus the parser/crossval/renderer tests from T01.

## Must-Haves

- [ ] Zero `createRequire` references in any of the 16 migrated caller files
- [ ] Zero `parseRoadmap`/`parsePlan`/`parseRoadmapSlices` references in the 4 hot-path files
- [ ] Each `if (isDbAvailable())` pattern simplified to DB-only with early return/skip when unavailable
- [ ] `auto-prompts.ts` `lazyParseRoadmap`/`lazyParsePlan` helper functions removed
- [ ] `workspace-index.ts` `titleFromRoadmapHeader` gracefully returns null when DB unavailable
- [ ] All test suites pass

## Verification

```bash
# Zero parser refs in hot-path
grep -rn 'parseRoadmap\|parsePlan\|parseRoadmapSlices' \
  src/resources/extensions/gsd/dispatch-guard.ts \
  src/resources/extensions/gsd/auto-dispatch.ts \
  src/resources/extensions/gsd/auto-verification.ts \
  src/resources/extensions/gsd/parallel-eligibility.ts
# Exit code 1 (no matches)

# Zero createRequire in all 16 callers
grep -rn 'createRequire' \
  src/resources/extensions/gsd/dispatch-guard.ts \
  src/resources/extensions/gsd/auto-dispatch.ts \
  src/resources/extensions/gsd/auto-verification.ts \
  src/resources/extensions/gsd/parallel-eligibility.ts \
  src/resources/extensions/gsd/doctor.ts \
  src/resources/extensions/gsd/doctor-checks.ts \
  src/resources/extensions/gsd/visualizer-data.ts \
  src/resources/extensions/gsd/workspace-index.ts \
  src/resources/extensions/gsd/dashboard-overlay.ts \
  src/resources/extensions/gsd/auto-dashboard.ts \
  src/resources/extensions/gsd/guided-flow.ts \
  src/resources/extensions/gsd/auto-prompts.ts \
  src/resources/extensions/gsd/auto-recovery.ts \
  src/resources/extensions/gsd/auto-direct-dispatch.ts \
  src/resources/extensions/gsd/auto-worktree.ts \
  src/resources/extensions/gsd/reactive-graph.ts
# Exit code 1 (no matches)

# Parser only in allowed files
grep -rn 'parseRoadmap\|parsePlan\|parseRoadmapSlices' src/resources/extensions/gsd/*.ts \
  | grep -v '/tests/' | grep -v 'parsers-legacy' | grep -v 'md-importer' \
  | grep -v 'debug-logger' | grep -v 'native-parser-bridge' \
  | grep -v 'state.ts' | grep -v 'commands-maintenance' | grep -v 'markdown-renderer'
# Exit code 1 (no matches)

# Full test suite
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/parsers.test.ts \
  src/resources/extensions/gsd/tests/roadmap-slices.test.ts \
  src/resources/extensions/gsd/tests/planning-crossval.test.ts \
  src/resources/extensions/gsd/tests/markdown-renderer.test.ts \
  src/resources/extensions/gsd/tests/doctor.test.ts \
  src/resources/extensions/gsd/tests/auto-dashboard.test.ts \
  src/resources/extensions/gsd/tests/auto-recovery.test.ts \
  src/resources/extensions/gsd/tests/derive-state-db.test.ts \
  src/resources/extensions/gsd/tests/derive-state-crossval.test.ts \
  src/resources/extensions/gsd/tests/gsd-recover.test.ts \
  src/resources/extensions/gsd/tests/flag-file-db.test.ts
```

## Inputs

- `src/resources/extensions/gsd/parsers-legacy.ts` — T01 output: parser functions now live here (confirms files.ts no longer exports them, so fallback singletons are dead code)
- `src/resources/extensions/gsd/dispatch-guard.ts` — has `_lazyParser`/`lazyParseRoadmapSlices()` at lines 4,10-23,88
- `src/resources/extensions/gsd/auto-dispatch.ts` — has `_lazyParseRoadmap` at lines 17,19-29; 3 `if/else` blocks at ~192,532,600
- `src/resources/extensions/gsd/auto-verification.ts` — has inline createRequire at lines 16,74
- `src/resources/extensions/gsd/parallel-eligibility.ts` — has inline createRequire at lines 12,57
- `src/resources/extensions/gsd/doctor.ts` — has `_lazyParsers` at lines 19,23
- `src/resources/extensions/gsd/doctor-checks.ts` — has `_lazyParseRoadmap` at lines 23,27
- `src/resources/extensions/gsd/visualizer-data.ts` — has `_lazyParsers` at lines 41,45
- `src/resources/extensions/gsd/workspace-index.ts` — has `_lazyParsers` at lines 19,23; `titleFromRoadmapHeader` at line 80
- `src/resources/extensions/gsd/dashboard-overlay.ts` — has `_lazyParsers` at lines 31,35
- `src/resources/extensions/gsd/auto-dashboard.ts` — has `_lazyParsers` at lines 30,34
- `src/resources/extensions/gsd/guided-flow.ts` — has `_lazyParseRoadmap` at lines 43,47
- `src/resources/extensions/gsd/auto-prompts.ts` — has async `lazyParseRoadmap`/`lazyParsePlan` at lines 32-49; 6 call sites
- `src/resources/extensions/gsd/auto-recovery.ts` — has `createRequire` at line 13; inline fallbacks at ~380,426
- `src/resources/extensions/gsd/auto-direct-dispatch.ts` — has inline `createRequire` at ~166-167,201-202
- `src/resources/extensions/gsd/auto-worktree.ts` — has `createRequire` at line 21; fallback at ~1009
- `src/resources/extensions/gsd/reactive-graph.ts` — has inline `createRequire` at ~210-211

## Expected Output

- `src/resources/extensions/gsd/dispatch-guard.ts` — lazy parser + createRequire removed, DB-only path
- `src/resources/extensions/gsd/auto-dispatch.ts` — lazy parser + createRequire removed, DB-only path
- `src/resources/extensions/gsd/auto-verification.ts` — createRequire fallback removed, DB-only path
- `src/resources/extensions/gsd/parallel-eligibility.ts` — createRequire fallback removed, DB-only path
- `src/resources/extensions/gsd/doctor.ts` — lazy parsers + createRequire removed, DB-only path
- `src/resources/extensions/gsd/doctor-checks.ts` — lazy parser + createRequire removed, DB-only path
- `src/resources/extensions/gsd/visualizer-data.ts` — lazy parsers + createRequire removed, DB-only path
- `src/resources/extensions/gsd/workspace-index.ts` — lazy parsers + createRequire removed, titleFromRoadmapHeader returns null when no DB
- `src/resources/extensions/gsd/dashboard-overlay.ts` — lazy parsers + createRequire removed, DB-only path
- `src/resources/extensions/gsd/auto-dashboard.ts` — lazy parsers + createRequire removed, DB-only path
- `src/resources/extensions/gsd/guided-flow.ts` — lazy parser + createRequire removed, DB-only path
- `src/resources/extensions/gsd/auto-prompts.ts` — async lazy helpers removed, DB-only paths at all 6 call sites
- `src/resources/extensions/gsd/auto-recovery.ts` — createRequire + fallbacks removed, DB-only path
- `src/resources/extensions/gsd/auto-direct-dispatch.ts` — createRequire + fallbacks removed, DB-only path
- `src/resources/extensions/gsd/auto-worktree.ts` — createRequire + fallback removed, DB-only path
- `src/resources/extensions/gsd/reactive-graph.ts` — createRequire + fallback removed, DB-only path
