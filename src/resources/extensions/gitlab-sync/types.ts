/**
 * Type definitions for the GitLab Sync extension.
 *
 * Config shape (stored in GSD preferences under `gitlab` key) and
 * sync mapping records (stored in `.gsd/gitlab-sync.json`).
 */

// ─── Configuration ──────────────────────────────────────────────────────────

export interface GitLabSyncConfig {
  /** Master switch. Default: false (opt-in). */
  enabled?: boolean;
  /**
   * GitLab project path: "group/project" or "namespace/project".
   * Auto-detected from `GITLAB_PROJECT` env var if omitted.
   */
  project?: string;
  /**
   * Base URL for self-managed GitLab instances.
   * Defaults to "https://gitlab.com" for SaaS.
   */
  base_url?: string;
  /**
   * Labels applied to all created issues.
   * @example ["gsd", "milestone-tracker"]
   */
  labels?: string[];
  /**
   * Milestone title template. Supports {{id}} and {{title}} substitution.
   * @default "{{id}}: {{title}}"
   */
  milestone_title_template?: string;
  /**
   * Issue title template. Supports {{id}}, {{title}}, and {{slice_id}} substitution.
   * @default "{{id}}: {{title}}"
   */
  issue_title_template?: string;
  /**
   * Default milestone state. GitLab milestones support "active" and "closed".
   * @default "active"
   */
  default_milestone_state?: "active" | "closed";
  /**
   * Append "Closesgitlab<iid>" to task commits. Default: true.
   */
  auto_close_references?: boolean;
  /**
   * Create per-slice issues as child items (requires GitLab Epics).
   * Default: false.
   */
  slice_issues_as_children?: boolean;
}

// ─── Sync Mapping ───────────────────────────────────────────────────────────

/** Base sync state shared by all entity types. */
export interface SyncEntityRecord {
  /** GitLab internal ID (stable across renames). */
  id: number;
  /** GitLab issue/MR IID (shown in URLs). Used in close references. */
  iid: number;
  /** ISO-8601 timestamp of last sync. */
  lastSyncedAt: string;
  /** Current GitLab state. */
  state: "opened" | "closed";
}

export interface MilestoneSyncRecord extends SyncEntityRecord {
  /** Parent milestone ID in GitLab. */
  milestoneId: number;
}

export interface SliceSyncRecord extends SyncEntityRecord {
  /** GitLab issue IID for the slice. */
  sliceIssueIid: number;
  /** GitLab MR IID for the slice (created as WIP draft on slice plan). */
  mrIid?: number;
  /** Branch name associated with this slice's feature branch. */
  branch?: string;
  /** Title of the MR (for tracking across renames). */
  mrTitle?: string;
}

export interface TaskSyncRecord extends SyncEntityRecord {
  /** Parent milestone IID this task belongs to. */
  milestoneIid?: number;
  /** Parent slice IID this task belongs to. */
  sliceIid?: number;
  /** Optional: commit SHA that closes this task (from MR merge). */
  closingCommitSha?: string;
}

// ─── Commit Reference Lookup ─────────────────────────────────────────────────

export interface CommitReference {
  /** Full SHA of the commit that contains the close reference. */
  sha: string;
  /** The referenced GitLab issue IID in the commit message. */
  issueIid: number;
  /** Timestamp of the commit. */
  committedDate: string;
}

/**
 * Result of looking up close references in an MR.
 * Maps task keys ("mid/sid/tid") to the commits that close them.
 */
export interface CommitReferenceMap {
  [taskKey: string]: CommitReference;
}

export interface SyncMapping {
  version: 1;
  /** Resolved project path (e.g. "group/project"). */
  project: string;
  /** Resolved base URL. */
  base_url: string;
  /** Milestone records keyed by GSD milestone ID (e.g. "M001"). */
  milestones: Record<string, MilestoneSyncRecord>;
  /** Slice records keyed by "mid/sid" (e.g. "M001/S01"). */
  slices: Record<string, SliceSyncRecord>;
  /** Task records keyed by "mid/sid/tid" (e.g. "M001/S01/T01"). */
  tasks: Record<string, TaskSyncRecord>;
}
