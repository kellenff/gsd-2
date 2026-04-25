/**
 * GitLab Sync orchestration.
 *
 * Core sync engine that scans GSD milestone files, creates GitLab milestones
 * and tracking issues, and persists the mapping to `.gsd/gitlab-sync.json`.
 *
 * All errors are caught internally — sync failures never block execution.
 * Failure modes are surfaced via debugLog("gitlab-sync", { phase, error, skip }).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFile, parseSummary } from "../gsd/files.js";
import { parseRoadmap, parsePlan } from "../gsd/parsers-legacy.js";
import { resolveMilestoneFile, resolveSliceFile, resolveSlicePath, resolveTaskFile } from "../gsd/paths.js";
import { debugLog } from "../gsd/debug-logger.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";

import type { GitLabSyncConfig } from "./types.js";
import {
  loadSyncMapping,
  saveSyncMapping,
  createEmptyMapping,
  getMilestoneRecord,
  getSliceRecord,
  getTaskRecord,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord,
} from "./mapping.js";
import {
  resolveGitLabToken,
  resolveProject,
  resolveBaseUrl,
  createMilestone,
  createIssue,
  createSliceIssue,
  resolveProjectId,
  createBranch,
  createMergeRequest,
  postIssueNote,
  postMergeRequestNote,
  closeIssue,
  updateMergeRequest,
  mergeMergeRequest,
  lookupCommitReferences,
  buildCloseReference,
} from "./api.js";
import {
  formatMilestoneBody,
  formatIssueBody,
  formatMRBody,
  formatSummaryComment,
  type MilestoneData,
  type IssueData,
} from "./templates.js";

// ─── Entry Point ────────────────────────────────────────────────────────────

/**
 * Main sync entry point — called from GSD post-unit pipeline.
 * Routes to the appropriate sync function based on unit type.
 */
export async function runGitLabSync(
  basePath: string,
  unitType: string,
  unitId: string,
): Promise<void> {
  try {
    const config = loadGitLabSyncConfig(basePath);
    if (!config?.enabled) {
      debugLog("gitlab-sync", { skip: "not enabled" });
      return;
    }

    const token = resolveGitLabToken();
    if (!token) {
      debugLog("gitlab-sync", { skip: "no token" });
      return;
    }

    const project = resolveProject(config);
    if (!project) {
      debugLog("gitlab-sync", { skip: "no project configured" });
      return;
    }

    const baseUrl = resolveBaseUrl(config);

    // Load or init mapping — done before project validation so we can persist
    // closed state even if API calls fail (e.g. no network access at completion time)
    let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(project, baseUrl);
    mapping.project = project;
    mapping.base_url = baseUrl;

    // Validate project exists (only needed for operations that create GitLab entities)
    // Skip for completion events that only update local state
    const needsProjectValidation = unitType !== "complete-slice" && unitType !== "complete-milestone";
    if (needsProjectValidation) {
      const projectResult = await resolveProjectId(baseUrl, token, project);
      if (!projectResult.ok) {
        debugLog("gitlab-sync", { phase: "resolve-project", error: projectResult.error.detail, kind: projectResult.error.kind });
        return;
      }
    }

    // Parse unit ID parts
    const parts = unitId.split("/");
    const [mid, sid, tid] = parts;

    // Route by unit type — for local-state updates (complete-slice/milestone),
    // persist the closed state even if API calls fail
    switch (unitType) {
      case "plan-milestone":
        if (mid) await syncMilestonePlan(basePath, mapping, config, baseUrl, token, project, mid);
        break;
      case "plan-slice":
      case "research-slice":
        if (mid && sid) await syncSlicePlan(basePath, mapping, config, baseUrl, token, project, mid, sid);
        break;
      case "execute-task":
      case "reactive-execute":
        if (mid && sid && tid) await syncTaskComplete(basePath, mapping, config, baseUrl, token, project, mid, sid, tid);
        break;
      case "complete-slice":
        if (mid && sid) await syncSliceComplete(basePath, mapping, config, baseUrl, token, project, mid, sid);
        break;
      case "complete-milestone":
        if (mid) await syncMilestoneComplete(basePath, mapping, config, baseUrl, token, project, mid);
        break;
    }

    saveSyncMapping(basePath, mapping);
  } catch (err) {
    debugLog("gitlab-sync", { error: String(err) });
  }
}

// ─── Per-Event Sync Functions ───────────────────────────────────────────────

async function syncMilestonePlan(
  basePath: string,
  mapping: import("./types.js").SyncMapping,
  config: GitLabSyncConfig,
  baseUrl: string,
  token: string,
  project: string,
  mid: string,
): Promise<void> {
  // Skip if already synced
  if (getMilestoneRecord(mapping, mid)) return;

  // Load roadmap data
  const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
  if (!roadmapPath) return;
  const content = await loadFile(roadmapPath);
  if (!content) return;

  const roadmap = parseRoadmap(content);
  const title = `${mid}: ${roadmap.title || "Milestone"}`;

  // Create GitLab Milestone
  const milestoneResult = await createMilestone(baseUrl, token, project, {
    gsdId: mid,
    title,
    description: formatMilestoneBody({
      id: mid,
      title: roadmap.title || "Milestone",
      vision: roadmap.vision,
      successCriteria: roadmap.successCriteria,
    }),
    state: config.default_milestone_state ?? "active",
  });

  if (!milestoneResult.ok) {
    debugLog("gitlab-sync", { phase: "create-milestone", error: milestoneResult.error.detail, kind: milestoneResult.error.kind });
    return;
  }

  // Create tracking issue for the milestone
  const issueTitle = `${mid}: ${roadmap.title || "Milestone"} — Tracking`;
  const issueBody = formatIssueBody({
    id: mid,
    title: roadmap.title || "Milestone",
    description: `Milestone tracking issue for [${mid}](${roadmapPath}).`,
    labels: config.labels,
  });

  const issueResult = await createIssue(baseUrl, token, project, {
    title: issueTitle,
    description: issueBody,
    labels: config.labels,
    milestoneIid: milestoneResult.record.iid,
  });

  if (!issueResult.ok) {
    debugLog("gitlab-sync", { phase: "create-tracking-issue", error: issueResult.error.detail, kind: issueResult.error.kind });
    return;
  }

  setMilestoneRecord(mapping, mid, {
    id: milestoneResult.record.id,
    iid: milestoneResult.record.iid,
    milestoneId: milestoneResult.record.id,
    lastSyncedAt: new Date().toISOString(),
    state: milestoneResult.record.state,
  });

  debugLog("gitlab-sync", {
    phase: "milestone-synced",
    mid,
    milestone_iid: milestoneResult.record.iid,
    issue_iid: issueResult.record.iid,
  });
}

async function syncSlicePlan(
  basePath: string,
  mapping: import("./types.js").SyncMapping,
  config: GitLabSyncConfig,
  baseUrl: string,
  token: string,
  project: string,
  mid: string,
  sid: string,
): Promise<void> {
  // Skip if already synced
  if (getSliceRecord(mapping, mid, sid)) return;

  // Ensure milestone is synced first
  const milestoneRecord = getMilestoneRecord(mapping, mid);
  if (!milestoneRecord) {
    await syncMilestonePlan(basePath, mapping, config, baseUrl, token, project, mid);
  }
  const updatedMilestoneRecord = getMilestoneRecord(mapping, mid);
  if (!updatedMilestoneRecord) return;

  // Load slice plan
  const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (!planPath) return;
  const content = await loadFile(planPath);
  if (!content) return;

  const plan = parsePlan(content);
  const sliceBranch = `milestone/${mid}/${sid}`;
  const milestoneBranch = `milestone/${mid}`;

  // Load roadmap for milestone title (needed for MR body)
  const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
  let milestoneTitle = `${mid}: Milestone`;
  if (roadmapPath) {
    const roadmapContent = await loadFile(roadmapPath);
    if (roadmapContent) {
      const roadmap = parseRoadmap(roadmapContent);
      milestoneTitle = `${mid}: ${roadmap.title || "Milestone"}`;
    }
  }

  // Track task issues created for this slice
  const taskIssues: Array<{ id: string; title: string; iid?: number }> = [];

  // Create per-task GitLab issues
  if (plan.tasks && plan.tasks.length > 0) {
    for (const task of plan.tasks) {
      // Skip if already synced
      if (getTaskRecord(mapping, mid, sid, task.id)) {
        const existing = getTaskRecord(mapping, mid, sid, task.id)!;
        taskIssues.push({ id: task.id, title: task.title, iid: existing.iid });
        continue;
      }

      const taskTitle = `${mid}/${sid}/${task.id}: ${task.title}`;
      const taskBody = formatIssueBody({
        id: task.id,
        title: task.title,
        description: task.description || undefined,
        labels: config.labels,
        sliceId: sid,
        sliceTitle: plan.title,
        files: task.files,
        verifyCriteria: task.verify ? [task.verify] : undefined,
      });

      const taskResult = await createIssue(baseUrl, token, project, {
        title: taskTitle,
        description: taskBody,
        labels: config.labels,
        milestoneIid: updatedMilestoneRecord.iid,
      });

      if (taskResult.ok) {
        setTaskRecord(mapping, mid, sid, task.id, {
          id: taskResult.record.id,
          iid: taskResult.record.iid,
          milestoneIid: updatedMilestoneRecord.iid,
          sliceIid: undefined,
          lastSyncedAt: new Date().toISOString(),
          state: taskResult.record.state,
        });
        taskIssues.push({ id: task.id, title: task.title, iid: taskResult.record.iid });
      } else {
        taskIssues.push({ id: task.id, title: task.title });
        debugLog("gitlab-sync", {
          phase: "create-task-issue",
          mid,
          sid,
          tid: task.id,
          error: taskResult.error.detail,
          kind: taskResult.error.kind,
        });
      }
    }
  }

  // Create slice branch from milestone branch
  const branchResult = await createBranch(baseUrl, token, project, sliceBranch, milestoneBranch);
  if (!branchResult.ok) {
    debugLog("gitlab-sync", {
      phase: "create-slice-branch",
      mid,
      sid,
      branch: sliceBranch,
      error: branchResult.error.detail,
      kind: branchResult.error.kind,
    });
    // Branch might already exist — continue anyway
  }

  // Build MR body with task issue references
  const mrDescription = formatMRBody({
    id: sid,
    sliceId: sid,
    sliceTitle: plan.title || sid,
    milestoneId: mid,
    milestoneTitle,
    vision: plan.goal || undefined,
    taskCount: taskIssues.filter(t => t.iid).length,
    verifyCriteria: plan.mustHaves,
  });

  // Create draft MR for the slice
  const mrResult = await createMergeRequest(baseUrl, token, project, {
    title: `${sid}: ${plan.title || sid}`,
    description: mrDescription,
    sourceBranch: sliceBranch,
    targetBranch: milestoneBranch,
    draft: true,
    labels: config.labels,
    milestoneIid: updatedMilestoneRecord.iid,
  });

  // Set slice record with MR identity
  setSliceRecord(mapping, mid, sid, {
    id: 0,
    iid: 0,
    sliceIssueIid: 0,
    branch: sliceBranch,
    mrIid: mrResult.ok ? mrResult.mrIid : undefined,
    mrTitle: mrResult.ok ? `${sid}: ${plan.title || sid}` : undefined,
    lastSyncedAt: new Date().toISOString(),
    state: "opened",
  });

  debugLog("gitlab-sync", {
    phase: "slice-synced",
    mid,
    sid,
    branch: sliceBranch,
    mr_iid: mrResult.ok ? mrResult.mrIid : undefined,
    task_issues_created: taskIssues.filter(t => t.iid).length,
    kind: mrResult.ok ? "mr-created" : "mr-failed",
  });
}

async function syncTaskComplete(
  basePath: string,
  mapping: import("./types.js").SyncMapping,
  config: GitLabSyncConfig,
  baseUrl: string,
  token: string,
  project: string,
  mid: string,
  sid: string,
  tid: string,
): Promise<void> {
  const taskRecord = getTaskRecord(mapping, mid, sid, tid);
  if (!taskRecord || taskRecord.state === "closed") return;

  // Load task summary for the comment
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath) {
    const content = await loadFile(summaryPath);
    if (content) {
      const summary = parseSummary(content);
      const comment = formatSummaryComment({
        oneLiner: summary.oneLiner,
        body: summary.whatHappened,
        frontmatter: summary.frontmatter as unknown as Record<string, unknown>,
      });
      await postIssueNote(baseUrl, token, project, taskRecord.iid, comment);
    }
  }

  // Close the task issue
  const closeResult = await closeIssue(baseUrl, token, project, taskRecord.iid);
  if (!closeResult.ok) {
    debugLog("gitlab-sync", {
      phase: "close-task-issue",
      mid,
      sid,
      tid,
      issue_iid: taskRecord.iid,
      error: closeResult.error.detail,
      kind: closeResult.error.kind,
    });
    return;
  }

  taskRecord.state = "closed";
  taskRecord.lastSyncedAt = new Date().toISOString();
  setTaskRecord(mapping, mid, sid, tid, taskRecord);

  debugLog("gitlab-sync", {
    phase: "task-closed",
    mid,
    sid,
    tid,
    issue_iid: taskRecord.iid,
  });
}

async function syncSliceComplete(
  basePath: string,
  mapping: import("./types.js").SyncMapping,
  config: GitLabSyncConfig,
  baseUrl: string,
  token: string,
  project: string,
  mid: string,
  sid: string,
): Promise<void> {
  const sliceRecord = getSliceRecord(mapping, mid, sid);
  if (!sliceRecord || sliceRecord.state === "closed") return;

  // Load slice summary for the MR comment
  if (sliceRecord.mrIid) {
    const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
    if (summaryPath) {
      const content = await loadFile(summaryPath);
      if (content) {
        const summary = parseSummary(content);
        const comment = formatSummaryComment({
          oneLiner: summary.oneLiner,
          body: summary.whatHappened,
          frontmatter: summary.frontmatter as unknown as Record<string, unknown>,
        });
        await postMergeRequestNote(baseUrl, token, project, sliceRecord.mrIid, comment);
      }
    }
  }

  // Mark MR as ready (remove draft flag) if we have an MR IID
  if (sliceRecord.mrIid) {
    const readyResult = await updateMergeRequest(baseUrl, token, project, sliceRecord.mrIid, { draft: false });
    if (!readyResult.ok) {
      debugLog("gitlab-sync", {
        phase: "mr-mark-ready",
        mid,
        sid,
        mr_iid: sliceRecord.mrIid,
        error: readyResult.error.detail,
        kind: readyResult.error.kind,
      });
      // Continue to try merge anyway — MR might already be ready
    } else {
      debugLog("gitlab-sync", { phase: "mr-marked-ready", mid, sid, mr_iid: sliceRecord.mrIid });
    }

    // Merge the MR
    const mergeResult = await mergeMergeRequest(baseUrl, token, project, sliceRecord.mrIid);
    if (!mergeResult.ok) {
      debugLog("gitlab-sync", {
        phase: "merge-mr",
        mid,
        sid,
        mr_iid: sliceRecord.mrIid,
        error: mergeResult.error.detail,
        kind: mergeResult.error.kind,
      });
    } else {
      debugLog("gitlab-sync", {
        phase: "mr-merged",
        mid,
        sid,
        mr_iid: sliceRecord.mrIid,
        merge_commit_sha: mergeResult.mergeCommitSha.substring(0, 8),
      });
    }
  }

  sliceRecord.state = "closed";
  sliceRecord.lastSyncedAt = new Date().toISOString();
  setSliceRecord(mapping, mid, sid, sliceRecord);

  debugLog("gitlab-sync", { phase: "slice-completed", mid, sid, mr_iid: sliceRecord.mrIid });
}

async function syncMilestoneComplete(
  basePath: string,
  mapping: import("./types.js").SyncMapping,
  _config: GitLabSyncConfig,
  _baseUrl: string,
  _token: string,
  _project: string,
  mid: string,
): Promise<void> {
  const record = getMilestoneRecord(mapping, mid);
  if (!record) return;

  record.state = "closed";
  record.lastSyncedAt = new Date().toISOString();
  setMilestoneRecord(mapping, mid, record);

  debugLog("gitlab-sync", { phase: "milestone-completed", mid, milestone_iid: record.iid });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Walk the `.gsd/milestones/` tree and create GitLab entities for any
 * milestones and slices that are missing from the sync mapping.
 * Safe to run multiple times — skips already-synced entities.
 */
export async function bootstrapSync(basePath: string): Promise<{
  milestones: number;
  slices: number;
  tasks: number;
}> {
  const config = loadGitLabSyncConfig(basePath);
  if (!config?.enabled) return { milestones: 0, slices: 0, tasks: 0 };

  const token = resolveGitLabToken();
  if (!token) return { milestones: 0, slices: 0, tasks: 0 };

  const project = resolveProject(config);
  if (!project) return { milestones: 0, slices: 0, tasks: 0 };

  const baseUrl = resolveBaseUrl(config);

  // Validate project access
  const projectResult = await resolveProjectId(baseUrl, token, project);
  if (!projectResult.ok) {
    debugLog("gitlab-sync", { phase: "bootstrap-resolve-project", error: projectResult.error.detail, kind: projectResult.error.kind });
    return { milestones: 0, slices: 0, tasks: 0 };
  }

  let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(project, baseUrl);
  mapping.project = project;
  mapping.base_url = baseUrl;

  const counts = { milestones: 0, slices: 0, tasks: 0 };
  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) return counts;

  const milestoneIds = readdirSync(milestonesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const mid of milestoneIds) {
    if (!getMilestoneRecord(mapping, mid)) {
      await syncMilestonePlan(basePath, mapping, config, baseUrl, token, project, mid);
      counts.milestones++;
      // Persist after each milestone so partial progress is saved
      saveSyncMapping(basePath, mapping);
    }

    // Find slices
    const slicesDir = join(milestonesDir, mid, "slices");
    if (!existsSync(slicesDir)) continue;

    const sliceIds = readdirSync(slicesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

    for (const sid of sliceIds) {
      if (!getSliceRecord(mapping, mid, sid)) {
        await syncSlicePlan(basePath, mapping, config, baseUrl, token, project, mid, sid);
        counts.slices++;
        // Persist after each slice so partial progress is saved
        saveSyncMapping(basePath, mapping);
      }
    }
  }

  // No per-task sync in tracer-bullet bootstrap
  counts.tasks = 0;

  debugLog("gitlab-sync", {
    phase: "bootstrap-complete",
    created: {
      milestones: counts.milestones,
      slices: counts.slices,
      tasks: counts.tasks,
    },
  });

  return counts;
}

// ─── Config Loading ─────────────────────────────────────────────────────────

let _cachedConfig: GitLabSyncConfig | null | undefined;

function loadGitLabSyncConfig(basePath: string): GitLabSyncConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig ?? null;
  try {
    const prefs = loadEffectiveGSDPreferences(basePath);
    const gitlab = (prefs?.preferences as Record<string, unknown>)?.gitlab;
    if (!gitlab || typeof gitlab !== "object") {
      _cachedConfig = null;
      return null;
    }
    _cachedConfig = gitlab as GitLabSyncConfig;
    return _cachedConfig;
  } catch {
    _cachedConfig = null;
    return null;
  }
}

/** Reset config cache (for testing). */
export function _resetConfigCache(): void {
  _cachedConfig = undefined;
}

/** Reset config cache and mapping (for testing). */
export function _resetAll(): void {
  _cachedConfig = undefined;
}
