# S04 — Research

**Date:** 2026-04-25

## Summary

The existing `gitlab-sync` extension is only a tracer-bullet implementation. It wires into the post-unit hook correctly, loads config from `preferences.gitlab`, resolves `GITLAB_TOKEN`, creates GitLab milestones plus tracking issues during bootstrap/plan events, and persists `.gsd/gitlab-sync.json`. But it stops short of the S04 scope: slice planning creates a slice issue, not a draft/WIP merge request; task completion only logs `reason: "not-implemented"`; slice and milestone completion only flip local mapping state to `closed` without calling GitLab APIs to close issues, post summaries, mark MRs ready, or merge them.

The cleanest path is to deepen `gitlab-sync` by following the existing `github-sync` event model rather than inventing a GitLab-specific workflow. The GitHub implementation already maps the same lifecycle boundaries S04 needs: plan-slice creates task issues plus a draft PR and branch, execute-task comments and closes the task issue, complete-slice comments on the PR and merges it, complete-milestone closes the tracking issue and milestone. For GitLab, the equivalent should be: create per-task issues plus a draft MR on `plan-slice`, close task issues on `execute-task`, and mark-ready / merge the MR on `complete-slice`, all while keeping `.gsd/gitlab-sync.json` as the authoritative local mapping file.

## Recommendation

Use `src/resources/extensions/github-sync/` as the behavioral reference and keep the current GitLab extension shape (`index.ts` + `sync.ts` + `api.ts` + `mapping.ts` + `templates.ts` + `types.ts`). Extend the GitLab API layer with first-class merge-request, note/comment, issue-close, and branch operations; then rework `sync.ts` so its event routing mirrors GitHub sync semantics but emits GitLab-native entities and references.

Two design choices matter most:

1. **Promote slice records from “slice issue only” to “slice issue + MR + branch” records.** Right now `SliceSyncRecord` only stores `sliceIssueIid` and optional `branch`. S04 needs MR lifecycle state, so the mapping type should grow fields for MR ID/IID and probably keep both slice-issue IID and MR IID.
2. **Add GitLab-specific commit close-reference support through the existing git-service seam.** `git-service.ts` currently only knows `issueNumber` → `Resolves #N` for GitHub. GitLab already has `buildCloseReference(iid)` in `api.ts`, but nothing uses it. The least invasive implementation is to extend the commit context / builder so GitLab task commits can append the correct GitLab close trailer when `preferences.gitlab.auto_close_references !== false`.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gitlab-sync/sync.ts` — main orchestration seam. Currently routes `plan-milestone`, `plan-slice`, `execute-task`, `complete-slice`, `complete-milestone`, but only milestone + slice creation is real. `syncTaskComplete()` is a placeholder, and `syncSliceComplete()` / `syncMilestoneComplete()` only mutate local mapping state.
- `src/resources/extensions/gitlab-sync/api.ts` — current GitLab REST wrapper. Has config/token/project resolution and milestone/issue creation, but no branch creation, MR creation, MR update, note/comment creation, issue closing, or milestone closing APIs yet.
- `src/resources/extensions/gitlab-sync/types.ts` — mapping/config contract. This is where S04 needs to add MR-related slice fields and possibly task-parent linkage fields used by close/summary flows.
- `src/resources/extensions/gitlab-sync/mapping.ts` — persistence layer for `.gsd/gitlab-sync.json`. Any new MR identifiers or richer task records should be stored here, preserving the same versioned mapping pattern used now.
- `src/resources/extensions/gitlab-sync/templates.ts` — existing milestone/issue/summary markdown builders. S04 likely needs MR body formatting parallel to `github-sync/templates.ts`’s `formatSlicePRBody()`.
- `src/resources/extensions/github-sync/sync.ts` — the best behavioral reference. Its `syncSlicePlan()`, `syncTaskComplete()`, `syncSliceComplete()`, and `syncMilestoneComplete()` already implement the lifecycle S04 wants.
- `src/resources/extensions/github-sync/cli.ts` — useful reference for branch, PR, comment, merge, and issue-close wrappers. GitLab should get analogous API helpers, but via REST instead of `gh` shell calls.
- `src/resources/extensions/gsd/auto-post-unit.ts` — already imports `runGitLabSync()` in the post-unit hook. No new hook point appears necessary; S04 should fit inside the existing event dispatch.
- `src/resources/extensions/gsd/git-service.ts` — commit-message seam. Today `TaskCommitContext` only supports `issueNumber` and emits `Resolves #N`; GitLab close-reference support belongs here or in a nearby adapter seam.
- `src/resources/extensions/gsd/preferences-validation.ts` — already validates `gitlab.auto_close_references`; that preference is effectively unused today and should become live once commit-linking is wired.
- `src/resources/extensions/gitlab-sync/tests/*.test.ts` and `src/resources/extensions/gsd/tests/auto-post-unit-gitlab-sync.test.ts` — current coverage is mostly bootstrap/config/routing. S04 needs expanded tests for MR creation, task close behavior, and slice-completion merge behavior.

### Build Order

1. **Expand the GitLab API surface first.** Add typed REST wrappers for: create branch (if needed via repository branches API), create draft MR, mark MR ready/remove draft status, merge MR, add note/comment to issue/MR, close issue, and close milestone. This is the hard dependency for everything else.
2. **Update `types.ts` + `mapping.ts` next.** The sync engine needs a place to persist MR IDs/IIDs, branch names, task issue IIDs, and slice-issue relationships before orchestration can be reliable.
3. **Port the GitHub lifecycle flow into `gitlab-sync/sync.ts`.** Make `plan-slice` create task issues first, then branch + draft MR; make `execute-task` post summary note and close the task issue; make `complete-slice` post slice summary note, mark MR ready, and merge it; make `complete-milestone` close the tracking issue and milestone remotely.
4. **Wire commit close references through `git-service.ts`.** Without this, task completion can still close issues by API call, but the `auto_close_references` preference remains dead and GitLab commit history won’t mirror the GitHub integration’s behavior.
5. **Add/refresh tests last.** Lock down API request formatting, mapping mutations, and event routing once the shape is stable.

### Verification Approach

- Run focused GitLab sync tests under `src/resources/extensions/gitlab-sync/tests/` and the post-unit wiring tests under `src/resources/extensions/gsd/tests/auto-post-unit-gitlab-sync.test.ts`.
- Add observable tests for:
  - `plan-slice` creating task records plus MR metadata in `.gsd/gitlab-sync.json`
  - `execute-task` transitioning a mapped task issue from `opened` to `closed`
  - `complete-slice` transitioning a mapped slice MR/record to merged/closed state
  - commit-message generation including the GitLab close trailer when GitLab sync is enabled for the task
- If live verification is attempted later in S05, confirm these behaviors against a real GitLab project: new draft MR appears on slice plan, task issue closes after task completion, MR merges on slice completion, and `.gsd/gitlab-sync.json` stays consistent.

## Constraints

- `auto-post-unit.ts` already invokes `runGitLabSync()` non-blockingly via `runSafely(...)`; sync failures must continue to be logged and isolated rather than block unit completion.
- GitLab sync is token/env based (`GITLAB_TOKEN`, optional `GITLAB_PROJECT`) and should stay that way; no plain-text secret persistence.
- The current GitLab extension uses REST + `fetch()`, not a CLI shim. S04 should keep that transport model instead of introducing a `glab` dependency.
- The mapping file is explicitly `.gsd/gitlab-sync.json` and already versioned. Deepening should extend that contract rather than replace it.

## Common Pitfalls

- **Assuming slice issues are enough** — S04’s success criterion is WIP/draft MR creation plus merge on slice completion. Reusing the current slice-issue-only path will miss the core behavior.
- **Copying GitHub commit trailers directly** — GitHub uses `Resolves #N`; GitLab support in this repo currently points toward `buildCloseReference(iid)` and needs a GitLab-specific trailer path.
- **Only mutating local mapping on completion** — current `syncSliceComplete()` / `syncMilestoneComplete()` set local state to `closed` without calling GitLab. S04 needs remote state transitions, not just local bookkeeping.
- **Forgetting summary comments/notes** — the GitHub flow posts task/slice summaries before closing/merging. If GitLab skips notes entirely, the remote artifacts will be materially thinner than GitHub parity.
- **Branch creation assumptions in worktrees** — GitHub sync shells out to `git branch` / `git push`. GitLab sync should be careful about whether branch creation happens via local git, GitLab API, or both, and keep that aligned with the milestone/slice branch naming convention already used by GitHub sync (`milestone/${mid}/${sid}`).

## Open Risks

- GitLab draft/WIP MR semantics may vary slightly between SaaS/self-managed versions; the API wrapper should treat “draft” as a first-class field and avoid brittle title-prefix hacks unless required.
- Closing issues via commit references alone may not be enough if the commit lands on a branch GitLab does not consider merge-targeting yet; API close on `execute-task` is the safer parity path.
- The current tests intentionally avoid live API dependence. S04 may need more HTTP-level mocking around MR endpoints to keep coverage deterministic.

## Sources

- Existing GitHub sync lifecycle implementation in `src/resources/extensions/github-sync/sync.ts`, `cli.ts`, `mapping.ts`, and `templates.ts` (repo source)
- Existing GitLab sync tracer-bullet implementation in `src/resources/extensions/gitlab-sync/sync.ts`, `api.ts`, `types.ts`, `mapping.ts`, and `templates.ts` (repo source)
- Post-unit hook integration in `src/resources/extensions/gsd/auto-post-unit.ts` (repo source)
- GitLab preference validation in `src/resources/extensions/gsd/preferences-validation.ts` and current commit trailer builder in `src/resources/extensions/gsd/git-service.ts` (repo source)
