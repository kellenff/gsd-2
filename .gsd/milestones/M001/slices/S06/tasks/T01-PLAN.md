---
estimated_steps: 6
estimated_files: 14
skills_used: []
---

# T01: Create parsers-legacy.ts and relocate all parser functions from files.ts

**Slice:** S06 — Parser deprecation + cleanup
**Milestone:** M001

## Description

Extract `parseRoadmap()`, `parsePlan()`, and all supporting implementation functions from `files.ts` into a new `parsers-legacy.ts` module. Update the 4 legitimate production consumers and 8 test files to import from the new location. Remove parser exports from `files.ts`. This is the structural foundation — T02 cannot strip fallback paths until parsers live in their own module.

## Steps

1. **Create `src/resources/extensions/gsd/parsers-legacy.ts`** with these contents:
   - Import `extractSection`, `parseBullets`, `extractBoldField`, `clearParseCache` from `./files.js` (these stay in files.ts — used by non-parser code too)
   - Import `splitFrontmatter`, `parseFrontmatterMap` from `../shared/frontmatter.js`
   - Import `nativeParseRoadmap`, `nativeParsePlanFile` from `./native-parser-bridge.js`
   - Import `debugTime`, `debugCount` from `./debug-logger.js`
   - Import `CACHE_MAX` from `./constants.js`
   - Import relevant types from `./types.js` (Roadmap, BoundaryMapEntry, SlicePlan, TaskPlanEntry, TaskPlanFrontmatter, etc.)
   - Re-export `parseRoadmapSlices` from `./roadmap-slices.js`
   - Copy `cachedParse()` function (the caching wrapper used by parseRoadmap/parsePlan — note: `clearParseCache` stays in `files.ts` and clears the cache there; `parsers-legacy.ts` needs its own cache instance OR imports the cache map from `files.ts`. Investigate which approach works — likely need a local `cachedParse` with its own WeakMap/Map since the cache in `files.ts` is module-private)
   - Move `_parseRoadmapImpl()` and its `parseRoadmap()` wrapper
   - Move `_parsePlanImpl()` and its `parsePlan()` wrapper
   - Export `parseRoadmap` and `parsePlan`

2. **Handle `cachedParse` carefully.** The cache in `files.ts` is module-private (`const parseCache = new Map()`). Options: (a) `parsers-legacy.ts` has its own local cache, (b) export the cache from `files.ts` — option (a) is cleaner. Also export a `clearLegacyParseCache()` from `parsers-legacy.ts` and have `clearParseCache()` in `files.ts` call it (since `clearParseCache` is called by `cache.ts`, `db-writer.ts`, `auto-recovery.ts`, `markdown-renderer.ts` and they expect it to clear parser caches). Alternatively: just duplicate `cachedParse` in `parsers-legacy.ts` with its own `parseCache` Map. The existing `clearParseCache()` in `files.ts` would only clear the `files.ts` caches (parseSummary, parseContinue), and since no production code uses `parseRoadmap`/`parsePlan` from `files.ts` anymore, the old cache entries for those would never accumulate. This is simplest.

3. **Remove from `files.ts`:** Delete `parseRoadmap()`, `_parseRoadmapImpl()`, `parsePlan()`, `_parsePlanImpl()`. Remove `import { parseRoadmapSlices } from './roadmap-slices.js'` (only used by `_parseRoadmapImpl`). Remove `nativeParseRoadmap` and `nativeParsePlanFile` from the `native-parser-bridge.js` import line (keep `nativeExtractSection`, `nativeParseSummaryFile`, `NATIVE_UNAVAILABLE` — used by `extractSection()` and `parseSummary()`).

4. **Update production consumers:**
   - `state.ts` line 15-16: change `import { parseRoadmap, parsePlan, ... } from './files.js'` → split into `import { parseRoadmap, parsePlan } from './parsers-legacy.js'` + keep remaining imports from `./files.js`
   - `md-importer.ts` line 32: change `import { parseRoadmap, parsePlan, parseContextDependsOn } from './files.js'` → `import { parseRoadmap, parsePlan } from './parsers-legacy.js'` + `import { parseContextDependsOn } from './files.js'`
   - `commands-maintenance.ts` line 47: change `await import("./files.js")` → `await import("./parsers-legacy.js")` for `parseRoadmap`; keep `loadFile` import from `./files.js`
   - `markdown-renderer.ts` ~line 782-788: change lazy `createRequire` import from `./files.ts`/`./files.js` to `./parsers-legacy.ts`/`./parsers-legacy.js`

5. **Update test file imports:** For each of these 8 test files, change `parseRoadmap`/`parsePlan` imports from `../files.ts` to `../parsers-legacy.ts`:
   - `tests/parsers.test.ts` — imports parseRoadmap, parsePlan from `../files.ts`
   - `tests/roadmap-slices.test.ts` — imports parseRoadmap from `../files.ts`
   - `tests/planning-crossval.test.ts` — imports parsePlan from `../files.ts`
   - `tests/auto-recovery.test.ts` — imports parseRoadmap, parsePlan from `../files.ts`
   - `tests/markdown-renderer.test.ts` — imports parseRoadmap, parsePlan from `../files.ts`
   - `tests/complete-milestone.test.ts` — dynamic `await import("../files.ts")` for parseRoadmap
   - `tests/migrate-writer.test.ts` — imports parseRoadmap, parsePlan from `../files.ts`
   - `tests/migrate-writer-integration.test.ts` — imports parseRoadmap, parsePlan from `../files.ts`

6. **Run parser and cross-validation tests** to verify nothing broke.

## Must-Haves

- [ ] `parsers-legacy.ts` exists and exports `parseRoadmap`, `parsePlan`, `parseRoadmapSlices`
- [ ] `files.ts` no longer exports `parseRoadmap` or `parsePlan`
- [ ] `files.ts` no longer imports from `roadmap-slices.js`
- [ ] `files.ts` native-parser-bridge import no longer includes `nativeParseRoadmap` or `nativeParsePlanFile`
- [ ] `state.ts` imports `parseRoadmap`/`parsePlan` from `parsers-legacy.js`
- [ ] `md-importer.ts` imports `parseRoadmap`/`parsePlan` from `parsers-legacy.js`
- [ ] `commands-maintenance.ts` dynamic import uses `parsers-legacy.js`
- [ ] `markdown-renderer.ts` detectStaleRenders lazy import uses `parsers-legacy`
- [ ] All 8 test files import from `parsers-legacy.ts` instead of `files.ts`
- [ ] All parser, crossval, and renderer tests pass

## Verification

- `grep -n 'export function parseRoadmap\|export function parsePlan' src/resources/extensions/gsd/files.ts` returns exit code 1 (no matches)
- `grep -n 'parseRoadmapSlices' src/resources/extensions/gsd/files.ts` returns exit code 1
- `grep -n 'export function parseRoadmap' src/resources/extensions/gsd/parsers-legacy.ts` returns match
- `grep -n 'export function parsePlan' src/resources/extensions/gsd/parsers-legacy.ts` returns match
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/parsers.test.ts src/resources/extensions/gsd/tests/roadmap-slices.test.ts src/resources/extensions/gsd/tests/planning-crossval.test.ts src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/migrate-writer.test.ts src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts src/resources/extensions/gsd/tests/complete-milestone.test.ts` — all pass

## Inputs

- `src/resources/extensions/gsd/files.ts` — contains `parseRoadmap()`, `_parseRoadmapImpl()`, `parsePlan()`, `_parsePlanImpl()`, `cachedParse()` to extract
- `src/resources/extensions/gsd/roadmap-slices.ts` — contains `parseRoadmapSlices()` to re-export
- `src/resources/extensions/gsd/state.ts` — module-level import of parseRoadmap/parsePlan from files.js at lines 15-16
- `src/resources/extensions/gsd/md-importer.ts` — imports parseRoadmap/parsePlan from files.js at line 32
- `src/resources/extensions/gsd/commands-maintenance.ts` — dynamic import of parseRoadmap from files.js at line 47
- `src/resources/extensions/gsd/markdown-renderer.ts` — lazy createRequire import of parseRoadmap/parsePlan from files at ~line 782
- `src/resources/extensions/gsd/tests/parsers.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/roadmap-slices.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/planning-crossval.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/markdown-renderer.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/complete-milestone.test.ts` — dynamic import from ../files.ts
- `src/resources/extensions/gsd/tests/migrate-writer.test.ts` — imports from ../files.ts
- `src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts` — imports from ../files.ts

## Expected Output

- `src/resources/extensions/gsd/parsers-legacy.ts` — new module exporting parseRoadmap, parsePlan, parseRoadmapSlices
- `src/resources/extensions/gsd/files.ts` — parser functions and roadmap-slices/native-parser-bridge parser imports removed
- `src/resources/extensions/gsd/state.ts` — import updated to parsers-legacy.js
- `src/resources/extensions/gsd/md-importer.ts` — import updated to parsers-legacy.js
- `src/resources/extensions/gsd/commands-maintenance.ts` — dynamic import updated to parsers-legacy.js
- `src/resources/extensions/gsd/markdown-renderer.ts` — lazy import updated to parsers-legacy
- `src/resources/extensions/gsd/tests/parsers.test.ts` — import updated
- `src/resources/extensions/gsd/tests/roadmap-slices.test.ts` — import updated
- `src/resources/extensions/gsd/tests/planning-crossval.test.ts` — import updated
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts` — import updated
- `src/resources/extensions/gsd/tests/markdown-renderer.test.ts` — import updated
- `src/resources/extensions/gsd/tests/complete-milestone.test.ts` — import updated
- `src/resources/extensions/gsd/tests/migrate-writer.test.ts` — import updated
- `src/resources/extensions/gsd/tests/migrate-writer-integration.test.ts` — import updated
