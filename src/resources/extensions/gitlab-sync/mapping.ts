/**
 * Persistence layer for the GitLab sync mapping.
 *
 * The mapping lives at `.gsd/gitlab-sync.json` and tracks which GSD
 * entities have been synced to which GitLab entities (milestones, issues)
 * along with their IDs/IIDs and sync timestamps.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "../gsd/atomic-write.js";
import type {
  SyncMapping,
  MilestoneSyncRecord,
  SliceSyncRecord,
  TaskSyncRecord,
} from "./types.js";

const MAPPING_FILENAME = "gitlab-sync.json";

function mappingPath(basePath: string): string {
  return join(basePath, ".gsd", MAPPING_FILENAME);
}

// ─── Load / Save ────────────────────────────────────────────────────────────

/**
 * Load the persisted sync mapping, or null if the file does not exist
 * or has an incompatible version.
 */
export function loadSyncMapping(basePath: string): SyncMapping | null {
  const path = mappingPath(basePath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as SyncMapping;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the sync mapping atomically.
 * On failure, the original file is untouched (atomic write semantics).
 */
export function saveSyncMapping(basePath: string, mapping: SyncMapping): void {
  const path = mappingPath(basePath);
  atomicWriteSync(path, JSON.stringify(mapping, null, 2) + "\n");
}

/**
 * Create a fresh empty mapping for a project.
 */
export function createEmptyMapping(project: string, base_url = "https://gitlab.com"): SyncMapping {
  return {
    version: 1,
    project,
    base_url,
    milestones: {},
    slices: {},
    tasks: {},
  };
}

// ─── Accessors ──────────────────────────────────────────────────────────────

/**
 * Get the milestone record for a GSD milestone ID.
 * Returns null if not yet synced.
 */
export function getMilestoneRecord(
  mapping: SyncMapping,
  mid: string,
): MilestoneSyncRecord | null {
  return mapping.milestones[mid] ?? null;
}

/**
 * Get the slice record for a GSD slice key "mid/sid".
 * Returns null if not yet synced.
 */
export function getSliceRecord(
  mapping: SyncMapping,
  mid: string,
  sid: string,
): SliceSyncRecord | null {
  return mapping.slices[`${mid}/${sid}`] ?? null;
}

/**
 * Get the task record for a GSD task key "mid/sid/tid".
 * Returns null if not yet synced.
 */
export function getTaskRecord(
  mapping: SyncMapping,
  mid: string,
  sid: string,
  tid: string,
): TaskSyncRecord | null {
  return mapping.tasks[`${mid}/${sid}/${tid}`] ?? null;
}

/**
 * Get the IID for a task, or null if not yet synced.
 * Convenience helper used by commit-reference generation.
 */
export function getTaskIid(
  mapping: SyncMapping,
  mid: string,
  sid: string,
  tid: string,
): number | null {
  const record = getTaskRecord(mapping, mid, sid, tid);
  return record?.iid ?? null;
}

// ─── Mutators ───────────────────────────────────────────────────────────────

/** Set or update a milestone sync record. */
export function setMilestoneRecord(
  mapping: SyncMapping,
  mid: string,
  record: MilestoneSyncRecord,
): void {
  mapping.milestones[mid] = record;
}

/** Set or update a slice sync record. */
export function setSliceRecord(
  mapping: SyncMapping,
  mid: string,
  sid: string,
  record: SliceSyncRecord,
): void {
  mapping.slices[`${mid}/${sid}`] = record;
}

/** Set or update a task sync record. */
export function setTaskRecord(
  mapping: SyncMapping,
  mid: string,
  sid: string,
  tid: string,
  record: TaskSyncRecord,
): void {
  mapping.tasks[`${mid}/${sid}/${tid}`] = record;
}

// ─── MR IID Accessors ───────────────────────────────────────────────────────

/**
 * Get the MR IID for a slice, or null if no MR has been created yet.
 */
export function getSliceMrIid(
  mapping: SyncMapping,
  mid: string,
  sid: string,
): number | null {
  const record = getSliceRecord(mapping, mid, sid);
  return record?.mrIid ?? null;
}

// ─── Commit Reference Resolution ─────────────────────────────────────────────

/**
 * Build a task-to-IID map from the sync mapping for use with
 * `lookupCommitReferences`. Returns entries only for tasks that have
 * a synced GitLab issue IID.
 *
 * Respects `preferences.gitlab.auto_close_references !== false`.
 * Callers should guard with that preference before invoking.
 *
 * @param mapping  The loaded sync mapping
 * @param sliceMid Only include tasks belonging to this milestone (e.g. "M001")
 * @param sliceSid Only include tasks belonging to this slice (e.g. "S01")
 */
export function buildTaskIidMap(
  mapping: SyncMapping,
  sliceMid: string,
  sliceSid: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  const prefix = `${sliceMid}/${sliceSid}/`;
  for (const [key, task] of Object.entries(mapping.tasks)) {
    if (key.startsWith(prefix) && task.iid > 0) {
      result[key] = task.iid;
    }
  }
  return result;
}
