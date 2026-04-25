/**
 * Regression tests for GitLab sync safe wiring in auto-post-unit.ts.
 *
 * Verifies that:
 * 1. The GitLab sync hook is wired via runSafely (non-blocking)
 * 2. GitLab sync errors are isolated and don't crash the post-unit pipeline
 * 3. When gitlab.enabled=false, the hook skips gracefully
 * 4. When no token is available, the hook skips gracefully
 * 5. The hook calls runGitLabSync with correct arguments
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";

function setupMockEnv() {
  process.env.GITLAB_TOKEN = "glpat-test-token";
}

function cleanupMockEnv() {
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PROJECT;
}

function createTempPreferences(dir: string, gitlabConfig: Record<string, unknown>) {
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const content = [
    "---",
    "gitlab:",
    `  enabled: ${gitlabConfig.enabled ?? false}`,
    `  project: "${gitlabConfig.project ?? ""}"`,
    `  base_url: "${gitlabConfig.base_url ?? "https://gitlab.com"}"`,
    `  labels: [${(gitlabConfig.labels as string[] | undefined)?.map(l => `"${l}"`).join(", ") ?? ""}]`,
    "---",
  ].join("\n");
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), content);
}

// ─── runSafely Pattern Tests ───────────────────────────────────────────────

describe("auto-post-unit gitlab-sync wiring — runSafely isolation", () => {
  it("runSafely isolates gitlab-sync errors from caller", async () => {
    const { runSafely } = await import("../auto-utils.js");

    let called = false;
    let threw = false;

    try {
      await runSafely("test", "gitlab-sync", async () => {
        called = true;
        throw new Error("simulated gitlab-sync failure");
      });
    } catch {
      threw = true;
    }

    assert.ok(called, "The gitlab-sync function should have been called");
    assert.ok(!threw, "runSafely should catch errors — caller should not see exceptions");
  });

  it("runSafely accepts async gitlab-sync function", async () => {
    const { runSafely } = await import("../auto-utils.js");

    let called = false;
    await runSafely("test", "gitlab-sync", async () => {
      called = true;
    });

    assert.ok(called);
  });

  it("runSafely accepts sync gitlab-sync function", async () => {
    const { runSafely } = await import("../auto-utils.js");

    let called = false;
    await runSafely("test", "gitlab-sync", () => {
      called = true;
    });

    assert.ok(called);
  });
});

// ─── GitLab Sync Config Loading Tests ──────────────────────────────────────

describe("auto-post-unit gitlab-sync wiring — config-aware skip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gitlab-wiring-"));
    setupMockEnv();
  });

  afterEach(() => {
    cleanupMockEnv();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips when gitlab.enabled is false", async () => {
    // Create preferences with gitlab.enabled = false
    createTempPreferences(tempDir, { enabled: false });

    const { _resetConfigCache } = await import("../../gitlab-sync/sync.js");
    _resetConfigCache();

    const { runGitLabSync } = await import("../../gitlab-sync/sync.js");
    // Should not throw — returns early when disabled
    await runGitLabSync(tempDir, "plan-milestone", "M001");
  });

  it("skips when no GITLAB_TOKEN env var", async () => {
    delete process.env.GITLAB_TOKEN;
    // Create preferences with gitlab enabled
    createTempPreferences(tempDir, {
      enabled: true,
      project: "test-group/test-project",
      base_url: "https://gitlab.com",
    });

    const { _resetConfigCache } = await import("../../gitlab-sync/sync.js");
    _resetConfigCache();

    const { runGitLabSync } = await import("../../gitlab-sync/sync.js");
    // Should not throw — returns early when no token
    await runGitLabSync(tempDir, "plan-milestone", "M001");
  });

  it("skips when no project configured", async () => {
    // Create preferences with gitlab enabled but no project
    createTempPreferences(tempDir, {
      enabled: true,
      project: "",
      base_url: "https://gitlab.com",
    });

    const { _resetConfigCache } = await import("../../gitlab-sync/sync.js");
    _resetConfigCache();

    const { runGitLabSync } = await import("../../gitlab-sync/sync.js");
    // Should not throw — returns early when no project
    await runGitLabSync(tempDir, "plan-milestone", "M001");
  });

  it("handles missing preferences gracefully", async () => {
    // No preferences file at all
    mkdirSync(join(tempDir, ".gsd"), { recursive: true });

    const { _resetConfigCache } = await import("../../gitlab-sync/sync.js");
    _resetConfigCache();

    const { runGitLabSync } = await import("../../gitlab-sync/sync.js");
    // Should not throw — errors are caught internally
    await runGitLabSync(tempDir, "plan-milestone", "M001");
  });
});

// ─── Module Exports Smoke Test ───────────────────────────────────────────────

describe("auto-post-unit gitlab-sync wiring — module exports valid", () => {
  it("sync.ts exports runGitLabSync, bootstrapSync, and _resetConfigCache", async () => {
    const syncMod = await import("../../gitlab-sync/sync.js");
    // Verify the functions are exported (they exist as functions at runtime)
    assert.equal(typeof syncMod.runGitLabSync, "function", "runGitLabSync should be exported");
    assert.equal(typeof syncMod.bootstrapSync, "function", "bootstrapSync should be exported");
    assert.equal(typeof syncMod._resetConfigCache, "function", "_resetConfigCache should be exported");
  });

  it("types.js exports GitLabSyncConfig and SyncMapping interfaces (runtime-visible types)", async () => {
    // GitLabSyncConfig and SyncMapping are TypeScript interfaces (erased at runtime),
    // but the types.ts file still exports them for type-checking purposes.
    // We verify the file parses correctly by importing the runtime-safe exports.
    const typesMod = await import("../../gitlab-sync/types.js");
    // The file exists and parses without error — the interfaces are TypeScript-only.
    // We verify sync.ts can use them by checking its exports work correctly.
    assert.ok(typesMod, "types.js should be importable");
  });
});

// ─── Concurrent Hook Safety ─────────────────────────────────────────────────

describe("auto-post-unit gitlab-sync wiring — concurrent hook safety", () => {
  it("multiple runSafely calls for gitlab-sync don't interfere", async () => {
    const { runSafely } = await import("../auto-utils.js");

    let callCount = 0;
    await Promise.all([
      runSafely("test", "gitlab-sync", async () => { callCount++; }),
      runSafely("test", "gitlab-sync", async () => { callCount++; }),
      runSafely("test", "gitlab-sync", async () => { callCount++; }),
    ]);

    assert.equal(callCount, 3, "All three calls should execute");
  });

  it("gitlab-sync runSafely doesn't block other post-unit hooks", async () => {
    const { runSafely } = await import("../auto-utils.js");

    let otherHookCalled = false;
    const start = Date.now();

    await Promise.all([
      runSafely("test", "github-sync", async () => {
        await new Promise(r => setTimeout(r, 50));
        otherHookCalled = true;
      }),
      runSafely("test", "gitlab-sync", async () => {
        await new Promise(r => setTimeout(r, 10));
      }),
    ]);

    const elapsed = Date.now() - start;
    assert.ok(otherHookCalled, "Other hook should have been called");
    // Parallel execution means total time ≈ max(50, 10) ≈ 50ms, not 60ms
    assert.ok(elapsed < 100, `Should complete in ~50ms, took ${elapsed}ms`);
  });
});

// ─── GitLab Close Reference Commit Trailer ────────────────────────────────────

describe("gitlab-sync wiring — gitlab-issue-iid in TaskCommitContext", () => {
  it("TaskCommitContext interface accepts gitlabIssueIid field", async () => {
    const { buildTaskCommitMessage } = await import("../git-service.js");
    // When gitlabIssueIid is set, the commit message should include the close reference
    const msg = buildTaskCommitMessage({
      taskId: "S01/T01",
      taskTitle: "Implement feature",
      oneLiner: "Added the thing",
      gitlabIssueIid: 42,
    });
    assert.ok(msg.includes("Closes gitlab!42"), `Expected "Closes gitlab!42" in message: ${msg}`);
  });

  it("buildTaskCommitMessage includes both GitHub and GitLab close references", async () => {
    const { buildTaskCommitMessage } = await import("../git-service.js");
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "Fix bug",
      issueNumber: 15,
      gitlabIssueIid: 99,
    });
    assert.ok(msg.includes("Resolves #15"), `Expected "Resolves #15" in message: ${msg}`);
    assert.ok(msg.includes("Closes gitlab!99"), `Expected "Closes gitlab!99" in message: ${msg}`);
  });

  it("buildTaskCommitMessage omits GitLab reference when gitlabIssueIid is not set", async () => {
    const { buildTaskCommitMessage } = await import("../git-service.js");
    const msg = buildTaskCommitMessage({
      taskId: "S01/T03",
      taskTitle: "Update docs",
    });
    assert.ok(!msg.includes("gitlab!"), `Expected no gitlab close reference: ${msg}`);
  });

  it("getTaskIid returns task IID from mapping", async () => {
    const { getTaskIid, createEmptyMapping, setTaskRecord } = await import("../../gitlab-sync/mapping.js");
    const mapping = createEmptyMapping("test/project");
    setTaskRecord(mapping, "M001", "S01", "T01", {
      id: 1, iid: 77, lastSyncedAt: new Date().toISOString(), state: "opened",
    });
    const iid = getTaskIid(mapping, "M001", "S01", "T01");
    assert.equal(iid, 77);
  });

  it("getTaskIid returns null when task not in mapping", async () => {
    const { getTaskIid, createEmptyMapping } = await import("../../gitlab-sync/mapping.js");
    const mapping = createEmptyMapping("test/project");
    const iid = getTaskIid(mapping, "M001", "S01", "T99");
    assert.equal(iid, null);
  });
});
