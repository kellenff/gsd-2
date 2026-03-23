# S06: Parser deprecation + cleanup

**Goal:** Remove `parseRoadmap()`, `parsePlan()`, and `parseRoadmapSlices()` from the production runtime path. Parser functions survive only in a `parsers-legacy.ts` module used by `md-importer.ts` (migration), `state.ts` (pre-migration fallback), `detectStaleRenders()` (intentional disk-vs-DB comparison), and `commands-maintenance.ts` (cold-path branch cleanup). All 16 lazy `createRequire` fallback paths in migrated callers are stripped. Zero `parseRoadmap`/`parsePlan`/`parseRoadmapSlices` calls remain in the dispatch loop.
**Demo:** `grep -rn 'parseRoadmap\|parsePlan\|parseRoadmapSlices' src/resources/extensions/gsd/{dispatch-guard,auto-dispatch,auto-verification,parallel-eligibility}.ts` returns no matches. `grep -rn 'createRequire' src/resources/extensions/gsd/{dispatch-guard,auto-dispatch,auto-verification,parallel-eligibility,doctor,doctor-checks,visualizer-data,workspace-index,dashboard-overlay,auto-dashboard,guided-flow,auto-prompts,auto-recovery,auto-direct-dispatch,auto-worktree,reactive-graph}.ts` returns no matches. Full test suite passes.

## Must-Haves

- `parsers-legacy.ts` module contains `parseRoadmap()`, `parsePlan()`, `parseRoadmapSlices()`, and all supporting impl functions
- `files.ts` no longer exports `parseRoadmap` or `parsePlan` — no longer imports from `roadmap-slices.js`
- `state.ts`, `md-importer.ts`, `commands-maintenance.ts`, and `markdown-renderer.ts` (detectStaleRenders) import parsers from `parsers-legacy.ts`
- All 8 test files that import parsers updated to use `parsers-legacy.ts`
- All 16 migrated caller files have their lazy `createRequire` singletons and fallback `else` branches removed
- Zero `createRequire` imports remain in any of the 16 migrated caller files
- Full test suite passes with no regressions

## Verification

```bash
# 1. Zero parser references in dispatch-loop hot-path files
grep -rn 'parseRoadmap\|parsePlan\|parseRoadmapSlices' \
  src/resources/extensions/gsd/dispatch-guard.ts \
  src/resources/extensions/gsd/auto-dispatch.ts \
  src/resources/extensions/gsd/auto-verification.ts \
  src/resources/extensions/gsd/parallel-eligibility.ts
# Must return exit code 1 (no matches)

# 2. Zero createRequire in any of the 16 migrated caller files
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
# Must return exit code 1 (no matches)

# 3. Parser references only in allowed files (parsers-legacy, md-importer, state, commands-maintenance, markdown-renderer, debug-logger, native-parser-bridge, tests)
grep -rn 'parseRoadmap\|parsePlan\|parseRoadmapSlices' src/resources/extensions/gsd/*.ts \
  | grep -v '/tests/' | grep -v 'parsers-legacy' | grep -v 'md-importer' \
  | grep -v 'debug-logger' | grep -v 'native-parser-bridge' \
  | grep -v 'state.ts' | grep -v 'commands-maintenance' | grep -v 'markdown-renderer'
# Must return exit code 1 (no matches) — files.ts no longer has them

# 4. Test suite passes
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
  src/resources/extensions/gsd/tests/flag-file-db.test.ts \
  src/resources/extensions/gsd/tests/migrate-writer.test.ts \
  src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts \
  src/resources/extensions/gsd/tests/complete-milestone.test.ts
```

## Tasks

- [ ] **T01: Create parsers-legacy.ts and relocate all parser functions from files.ts** `est:45m`
  - Why: Parser functions must be extracted from `files.ts` into a dedicated legacy module before fallback paths can be stripped — otherwise removing exports from `files.ts` breaks the 4 legitimate consumers and 8 test files simultaneously
  - Files: `src/resources/extensions/gsd/parsers-legacy.ts` (new), `src/resources/extensions/gsd/files.ts`, `src/resources/extensions/gsd/state.ts`, `src/resources/extensions/gsd/md-importer.ts`, `src/resources/extensions/gsd/commands-maintenance.ts`, `src/resources/extensions/gsd/markdown-renderer.ts`, `src/resources/extensions/gsd/tests/parsers.test.ts`, `src/resources/extensions/gsd/tests/roadmap-slices.test.ts`, `src/resources/extensions/gsd/tests/planning-crossval.test.ts`, `src/resources/extensions/gsd/tests/auto-recovery.test.ts`, `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`, `src/resources/extensions/gsd/tests/complete-milestone.test.ts`, `src/resources/extensions/gsd/tests/migrate-writer.test.ts`, `src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts`
  - Do: Create `parsers-legacy.ts` containing `parseRoadmap()`, `_parseRoadmapImpl()`, `parsePlan()`, `_parsePlanImpl()`, `cachedParse()`, and re-exporting `parseRoadmapSlices` from `roadmap-slices.js`. Import `extractSection`, `parseBullets`, `extractBoldField` from `./files.js`. Import `splitFrontmatter`, `parseFrontmatterMap` from `../shared/frontmatter.js`. Import `nativeParseRoadmap`, `nativeParsePlanFile` from `./native-parser-bridge.js`. Import `debugTime`, `debugCount` from `./debug-logger.js`. Keep `clearParseCache()` exported from `files.ts` (other callers depend on it) — have `parsers-legacy.ts` import it from `./files.js`. Remove `parseRoadmap`, `_parseRoadmapImpl`, `parsePlan`, `_parsePlanImpl` from `files.ts`. Remove `import { parseRoadmapSlices }` and `nativeParseRoadmap`/`nativeParsePlanFile` from `files.ts` imports (keep `nativeExtractSection`/`nativeParseSummaryFile`/`NATIVE_UNAVAILABLE` — used by non-parser functions). Update `state.ts` import to `./parsers-legacy.js`. Update `md-importer.ts` import to `./parsers-legacy.js`. Update `commands-maintenance.ts` dynamic import to `./parsers-legacy.js`. Update `markdown-renderer.ts` detectStaleRenders lazy import to `./parsers-legacy.ts`/`.js`. Update all 8 test files' imports.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers.test.ts src/resources/extensions/gsd/tests/roadmap-slices.test.ts src/resources/extensions/gsd/tests/planning-crossval.test.ts src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/migrate-writer.test.ts src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts src/resources/extensions/gsd/tests/complete-milestone.test.ts` — all pass
  - Done when: `parseRoadmap` and `parsePlan` no longer exported from `files.ts`, all consumers import from `parsers-legacy.ts`, all parser/crossval/renderer tests pass

- [ ] **T02: Strip all 16 lazy createRequire fallback paths from migrated callers** `est:35m`
  - Why: With parsers relocated, the lazy fallback singletons in all 16 migrated callers are dead code — they imported from `files.ts` which no longer exports parsers. Strip them to complete the parser deprecation.
  - Files: `src/resources/extensions/gsd/dispatch-guard.ts`, `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/auto-verification.ts`, `src/resources/extensions/gsd/parallel-eligibility.ts`, `src/resources/extensions/gsd/doctor.ts`, `src/resources/extensions/gsd/doctor-checks.ts`, `src/resources/extensions/gsd/visualizer-data.ts`, `src/resources/extensions/gsd/workspace-index.ts`, `src/resources/extensions/gsd/dashboard-overlay.ts`, `src/resources/extensions/gsd/auto-dashboard.ts`, `src/resources/extensions/gsd/guided-flow.ts`, `src/resources/extensions/gsd/auto-prompts.ts`, `src/resources/extensions/gsd/auto-recovery.ts`, `src/resources/extensions/gsd/auto-direct-dispatch.ts`, `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/reactive-graph.ts`
  - Do: For each of the 16 files: (1) remove `import { createRequire } from "node:module"`, (2) remove the lazy parser singleton declaration and function, (3) replace `if (isDbAvailable()) { ...DB path... } else { ...parser fallback... }` with just the DB path body — when DB unavailable, return early with empty/null/skip. Special cases: `workspace-index.ts` `titleFromRoadmapHeader` was parser-only with no DB equivalent — remove it or return null when DB unavailable. `auto-prompts.ts` has async `lazyParseRoadmap`/`lazyParsePlan` helpers wrapping 6 call sites — remove the helpers entirely and inline the DB-only path. `auto-recovery.ts` has `import { createRequire }` at top and 2 inline `createRequire` usages — remove all. Remove `import { createRequire }` from files that imported it only for parser fallback (check if any remaining non-parser `createRequire` usage exists before removing).
  - Verify: Run all 4 grep verification commands from the slice verification section (all must exit 1 = no matches). Run full test suite: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor.test.ts src/resources/extensions/gsd/tests/auto-dashboard.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/derive-state-db.test.ts src/resources/extensions/gsd/tests/derive-state-crossval.test.ts src/resources/extensions/gsd/tests/gsd-recover.test.ts src/resources/extensions/gsd/tests/flag-file-db.test.ts`
  - Done when: All 4 grep checks return exit code 1. All test suites pass. Zero `createRequire` in any of the 16 files.

## Files Likely Touched

- `src/resources/extensions/gsd/parsers-legacy.ts` (new)
- `src/resources/extensions/gsd/files.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/md-importer.ts`
- `src/resources/extensions/gsd/commands-maintenance.ts`
- `src/resources/extensions/gsd/markdown-renderer.ts`
- `src/resources/extensions/gsd/dispatch-guard.ts`
- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/auto-verification.ts`
- `src/resources/extensions/gsd/parallel-eligibility.ts`
- `src/resources/extensions/gsd/doctor.ts`
- `src/resources/extensions/gsd/doctor-checks.ts`
- `src/resources/extensions/gsd/visualizer-data.ts`
- `src/resources/extensions/gsd/workspace-index.ts`
- `src/resources/extensions/gsd/dashboard-overlay.ts`
- `src/resources/extensions/gsd/auto-dashboard.ts`
- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/auto-recovery.ts`
- `src/resources/extensions/gsd/auto-direct-dispatch.ts`
- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/reactive-graph.ts`
- `src/resources/extensions/gsd/tests/parsers.test.ts`
- `src/resources/extensions/gsd/tests/roadmap-slices.test.ts`
- `src/resources/extensions/gsd/tests/planning-crossval.test.ts`
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts`
- `src/resources/extensions/gsd/tests/markdown-renderer.test.ts`
- `src/resources/extensions/gsd/tests/complete-milestone.test.ts`
- `src/resources/extensions/gsd/tests/migrate-writer.test.ts`
- `src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts`
