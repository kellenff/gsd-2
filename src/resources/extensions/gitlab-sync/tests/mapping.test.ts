import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSyncMapping,
  saveSyncMapping,
  createEmptyMapping,
  getMilestoneRecord,
  getSliceRecord,
  getTaskRecord,
  getTaskIid,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord,
  getSliceMrIid,
  buildTaskIidMap,
} from "../mapping.ts";
import type {
  SyncMapping,
  MilestoneSyncRecord,
  SliceSyncRecord,
  TaskSyncRecord,
} from "../types.ts";

describe("gitlab-sync mapping", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-gitlab-sync-test-"));
    mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadSyncMapping returns null when no file exists", () => {
    const result = loadSyncMapping(tmpDir);
    assert.equal(result, null);
  });

  it("round-trips save/load unchanged", () => {
    const mapping = createEmptyMapping("group/project", "https://gitlab.com");
    saveSyncMapping(tmpDir, mapping);
    const loaded = loadSyncMapping(tmpDir);
    assert.deepEqual(loaded, mapping);
  });

  it("createEmptyMapping has correct structure", () => {
    const mapping = createEmptyMapping("group/myproject", "https://gitlab.mycompany.com");
    assert.equal(mapping.version, 1);
    assert.equal(mapping.project, "group/myproject");
    assert.equal(mapping.base_url, "https://gitlab.mycompany.com");
    assert.deepEqual(mapping.milestones, {});
    assert.deepEqual(mapping.slices, {});
    assert.deepEqual(mapping.tasks, {});
  });

  it("createEmptyMapping uses default SaaS base_url", () => {
    const mapping = createEmptyMapping("group/project");
    assert.equal(mapping.base_url, "https://gitlab.com");
  });

  it("milestone record accessors work", () => {
    const mapping = createEmptyMapping("group/project");
    assert.equal(getMilestoneRecord(mapping, "M001"), null);

    const record: MilestoneSyncRecord = {
      id: 100,
      iid: 10,
      milestoneId: 100,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setMilestoneRecord(mapping, "M001", record);
    assert.deepEqual(getMilestoneRecord(mapping, "M001"), record);
  });

  it("slice record accessors work", () => {
    const mapping = createEmptyMapping("group/project");
    assert.equal(getSliceRecord(mapping, "M001", "S01"), null);

    const record: SliceSyncRecord = {
      id: 200,
      iid: 20,
      sliceIssueIid: 20,
      branch: "milestone/M001/S01",
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setSliceRecord(mapping, "M001", "S01", record);
    assert.deepEqual(getSliceRecord(mapping, "M001", "S01"), record);
  });

  it("task record accessors work", () => {
    const mapping = createEmptyMapping("group/project");
    assert.equal(getTaskRecord(mapping, "M001", "S01", "T01"), null);
    assert.equal(getTaskIid(mapping, "M001", "S01", "T01"), null);

    const record: TaskSyncRecord = {
      id: 300,
      iid: 30,
      milestoneIid: 10,
      sliceIid: 20,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setTaskRecord(mapping, "M001", "S01", "T01", record);
    assert.deepEqual(getTaskRecord(mapping, "M001", "S01", "T01"), record);
    assert.equal(getTaskIid(mapping, "M001", "S01", "T01"), 30);
  });

  it("getTaskIid returns null when record exists but has no iid", () => {
    const mapping = createEmptyMapping("group/project");
    // TaskSyncRecord always has iid, but this guards against accidental type widening
    const record: TaskSyncRecord = {
      id: 0,
      iid: 0,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setTaskRecord(mapping, "M001", "S01", "T01", record);
    assert.equal(getTaskIid(mapping, "M001", "S01", "T01"), 0);
  });

  it("rejects mapping with wrong version", () => {
    const mapping = createEmptyMapping("group/project");
    (mapping as unknown as Record<string, unknown>).version = 2;
    saveSyncMapping(tmpDir, mapping);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded, null);
  });

  it("rejects corrupt JSON", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmpDir, ".gsd", "gitlab-sync.json"), "not valid json {{{", "utf-8");
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded, null);
  });

  // ─── MR IID ────────────────────────────────────────────────────────────────

  it("getSliceMrIid returns null when slice has no MR", () => {
    const mapping = createEmptyMapping("group/project");
    const record: SliceSyncRecord = {
      id: 200,
      iid: 20,
      sliceIssueIid: 20,
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setSliceRecord(mapping, "M001", "S01", record);
    assert.equal(getSliceMrIid(mapping, "M001", "S01"), null);
  });

  it("getSliceMrIid returns mrIid when slice has an MR", () => {
    const mapping = createEmptyMapping("group/project");
    const record: SliceSyncRecord = {
      id: 200,
      iid: 20,
      sliceIssueIid: 20,
      mrIid: 42,
      mrTitle: "WIP: Slice S01",
      branch: "feat/slice-s01",
      lastSyncedAt: "2025-01-01T00:00:00Z",
      state: "opened",
    };
    setSliceRecord(mapping, "M001", "S01", record);
    assert.equal(getSliceMrIid(mapping, "M001", "S01"), 42);
  });

  it("getSliceMrIid returns null for non-existent slice", () => {
    const mapping = createEmptyMapping("group/project");
    assert.equal(getSliceMrIid(mapping, "M999", "S99"), null);
  });

  // ─── Commit Reference Map ────────────────────────────────────────────────────

  it("buildTaskIidMap returns only tasks for the given slice", () => {
    const mapping = createEmptyMapping("group/project");

    setTaskRecord(mapping, "M001", "S01", "T01", {
      id: 1, iid: 101, lastSyncedAt: "2025-01-01T00:00:00Z", state: "opened",
    });
    setTaskRecord(mapping, "M001", "S01", "T02", {
      id: 2, iid: 102, lastSyncedAt: "2025-01-01T00:00:00Z", state: "opened",
    });
    setTaskRecord(mapping, "M001", "S02", "T01", {
      id: 3, iid: 103, lastSyncedAt: "2025-01-01T00:00:00Z", state: "opened",
    });

    const result = buildTaskIidMap(mapping, "M001", "S01");
    assert.equal(Object.keys(result).length, 2);
    assert.equal(result["M001/S01/T01"], 101);
    assert.equal(result["M001/S01/T02"], 102);
    assert.equal(result["M001/S02/T01"], undefined);
  });

  it("buildTaskIidMap excludes tasks with iid 0", () => {
    const mapping = createEmptyMapping("group/project");
    setTaskRecord(mapping, "M001", "S01", "T01", {
      id: 0, iid: 0, lastSyncedAt: "2025-01-01T00:00:00Z", state: "opened",
    });
    setTaskRecord(mapping, "M001", "S01", "T02", {
      id: 2, iid: 102, lastSyncedAt: "2025-01-01T00:00:00Z", state: "opened",
    });

    const result = buildTaskIidMap(mapping, "M001", "S01");
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result["M001/S01/T01"], undefined);
    assert.equal(result["M001/S01/T02"], 102);
  });

  it("buildTaskIidMap returns empty object when no tasks exist", () => {
    const mapping = createEmptyMapping("group/project");
    const result = buildTaskIidMap(mapping, "M001", "S01");
    assert.deepEqual(result, {});
  });
});
