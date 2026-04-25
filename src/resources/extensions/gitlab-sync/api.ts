/**
 * GitLab REST API client.
 *
 * Uses native `fetch()` with:
 * - Bearer-token auth via `GITLAB_TOKEN` env var
 * - `AbortSignal.timeout()` for per-request timeouts
 * - Structured error surfaces (never throws uncaught)
 * - Typed responses for milestone/issue operations
 * - Redaction of auth-bearing URLs in error messages
 *
 * All entrypoints are synchronous helpers that return typed result objects.
 * No live GitLab instance is required for unit tests.
 */

import type {
  GitLabSyncConfig,
  MilestoneSyncRecord,
  SliceSyncRecord,
  TaskSyncRecord,
  SyncEntityRecord,
  CommitReferenceMap,
} from "./types.js";
import { formatMilestoneBody, formatIssueBody } from "./templates.js";

// ─── Token & Config Resolution ───────────────────────────────────────────────

const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";
const GITLAB_PROJECT_ENV = "GITLAB_PROJECT";

/**
 * Resolve the GitLab token from the environment.
 * Returns null if the token is missing or empty.
 */
export function resolveGitLabToken(): string | null {
  const token = process.env[GITLAB_TOKEN_ENV];
  if (!token || typeof token !== "string" || !token.trim()) return null;
  return token.trim();
}

/**
 * Resolve the project path from config or environment.
 */
export function resolveProject(config: Partial<GitLabSyncConfig>): string | null {
  if (config.project && typeof config.project === "string" && config.project.includes("/")) {
    return config.project.trim();
  }
  const env = process.env[GITLAB_PROJECT_ENV];
  if (env && typeof env === "string" && env.includes("/")) return env.trim();
  return null;
}

/**
 * Resolve the base URL from config or default to GitLab SaaS.
 */
export function resolveBaseUrl(config: Partial<GitLabSyncConfig>): string {
  if (config.base_url && typeof config.base_url === "string" && config.base_url.startsWith("http")) {
    return config.base_url.replace(/\/$/, "");
  }
  return "https://gitlab.com";
}

// ─── Error Taxonomy ─────────────────────────────────────────────────────────

/**
 * All GitLab API errors are surfaced as typed result objects.
 * The `phase` field lets callers log which sync phase failed.
 */
export interface GitLabApiError {
  kind:
    | "auth-missing"
    | "auth-rejected"
    | "rate-limited"
    | "not-found"
    | "timeout"
    | "network-error"
    | "malformed-response"
    | "unknown";
  phase: string;
  status?: number;
  /** Redacted: auth-bearing details are stripped from this field. */
  detail: string;
  retryable: boolean;
}

function redactUrl(url: string): string {
  // Strip token= query params and path segments that look like tokens
  return url
    .replace(/[?&]token=[^&\s]*/gi, "")
    .replace(/\/tokens\/[^/\s]+/gi, "/tokens/<redacted>")
    .replace(/\/api\/v4\/projects\/[^/]+\/[^/]+\/[^/]+/gi, (match) => match);
}

function buildApiError(
  phase: string,
  detail: string,
  kind: GitLabApiError["kind"],
  status?: number,
  retryable?: boolean,
): GitLabApiError {
  return {
    kind,
    phase,
    status,
    detail,
    retryable: retryable ?? (kind === "auth-rejected" || kind === "not-found" ? false : true),
  };
}

// ─── Fetch Override Seam (for testing) ───────────────────────────────────────

/**
 * Injectable fetch implementation for deterministic testing.
 * Tests can call `_setFetchImpl(mockFn)` to replace the global fetch used by
 * all GitLab API calls in this module. The override is scoped to the current
 * import of the api module — other modules retain the real fetch.
 *
 * This avoids the ES-module live-binding problem where Object.defineProperty
 * mocks on exported functions are unreliable.
 */
let _fetchImpl: typeof fetch | null = null;

export function _setFetchImpl(fn: typeof fetch | null): void {
  _fetchImpl = fn;
}

// ─── Fetch Wrapper ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Options for GitLab API calls.
 */
export interface ApiCallOptions {
  /** Per-call timeout in ms. Default: 15000. */
  timeout_ms?: number;
  /** Extra headers merged with defaults. */
  extra_headers?: Record<string, string>;
}

interface FetchResult<T> {
  ok: true;
  data: T;
}
interface FetchErr {
  ok: false;
  error: GitLabApiError;
}

/**
 * Perform a typed fetch against the GitLab REST API.
 * Returns a discriminated union so callers never get an uncaught throw.
 */
async function gitlabFetch<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit & { signal?: AbortSignal },
  phase: string,
  timeout_ms = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult<T> | FetchErr> {
  const url = `${baseUrl}/api/v4${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await (_fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: buildApiError(
          phase,
          `auth rejected (${response.status}) at ${redactUrl(url)}`,
          "auth-rejected",
          response.status,
        ),
      };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      return {
        ok: false,
        error: buildApiError(
          phase,
          `rate limited; retry-after: ${retryAfter ?? "unknown"}`,
          "rate-limited",
          response.status,
        ),
      };
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status} at ${redactUrl(url)}`;
      try {
        const body = await response.json() as { message?: string | Record<string, string[]> };
        if (typeof body.message === "string") {
          detail = body.message;
        } else if (body.message && typeof body.message === "object") {
          const msgs = Object.values(body.message).flat();
          if (msgs.length > 0) detail = msgs.join("; ");
        }
      } catch {
        // body is not JSON — use status line
      }
      return {
        ok: false,
        error: buildApiError(phase, detail, "not-found", response.status),
      };
    }

    // 204 No Content is valid for some DELETE/PUT calls
    if (response.status === 204) {
      return { ok: true, data: undefined as unknown as T };
    }

    let data: T;
    try {
      data = await response.json() as T;
    } catch {
      return {
        ok: false,
        error: buildApiError(
          phase,
          `non-JSON response from ${redactUrl(url)}`,
          "malformed-response",
          response.status,
        ),
      };
    }

    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: buildApiError(phase, `timeout after ${timeout_ms}ms at ${redactUrl(url)}`, "timeout"),
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: buildApiError(
        phase,
        `network error at ${redactUrl(url)}: ${msg}`,
        "network-error",
      ),
    };
  }
}

// ─── Project Validation ──────────────────────────────────────────────────────

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

/**
 * Validate that the project exists and the token has access.
 * Returns the project record on success, or an error on failure.
 */
export async function resolveProjectId(
  baseUrl: string,
  token: string,
  projectPath: string,
): Promise<{ ok: true; project: GitLabProject } | FetchErr> {
  const result = await gitlabFetch<GitLabProject>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}`,
    { method: "GET" },
    "resolve-project",
  );
  if (!result.ok) return result;
  return { ok: true, project: result.data };
}

// ─── Milestone Operations ────────────────────────────────────────────────────

interface GitLabMilestone {
  id: number;
  iid: number;
  title: string;
  state: string;
}

/**
 * Create a GitLab milestone and return its record.
 */
export async function createMilestone(
  baseUrl: string,
  token: string,
  projectPath: string,
  milestoneData: {
    gsdId: string;
    title: string;
    description: string;
    state?: "active" | "closed";
  },
): Promise<{ ok: true; record: MilestoneSyncRecord } | FetchErr> {
  const result = await gitlabFetch<GitLabMilestone>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/milestones`,
    {
      method: "POST",
      body: JSON.stringify({
        title: milestoneData.title,
        description: milestoneData.description,
        state_event: milestoneData.state === "closed" ? "close" : "activate",
      }),
    },
    "create-milestone",
  );

  if (!result.ok) return result;

  const { id, iid, state } = result.data;
  return {
    ok: true,
    record: {
      id,
      iid,
      milestoneId: id,
      lastSyncedAt: new Date().toISOString(),
      state: state === "active" ? "opened" : "closed",
    },
  };
}

// ─── Issue Operations ────────────────────────────────────────────────────────

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  state: string;
}

/**
 * Create a GitLab issue and return its record.
 */
export async function createIssue(
  baseUrl: string,
  token: string,
  projectPath: string,
  issueData: {
    title: string;
    description: string;
    labels?: string[];
    milestoneIid?: number;
  },
): Promise<{ ok: true; record: TaskSyncRecord } | FetchErr> {
  const result = await gitlabFetch<GitLabIssue>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: issueData.title,
        description: issueData.description,
        labels: issueData.labels?.join(","),
        ...(issueData.milestoneIid !== undefined
          ? { milestone_id: issueData.milestoneIid }
          : {}),
      }),
    },
    "create-issue",
  );

  if (!result.ok) return result;

  const { id, iid, state } = result.data;
  return {
    ok: true,
    record: {
      id,
      iid,
      lastSyncedAt: new Date().toISOString(),
      state: state === "opened" ? "opened" : "closed",
      milestoneIid: issueData.milestoneIid,
    },
  };
}

/**
 * Create a slice issue (wraps createIssue with slice metadata).
 */
export async function createSliceIssue(
  baseUrl: string,
  token: string,
  projectPath: string,
  issueData: {
    sliceId: string;
    title: string;
    description: string;
    labels?: string[];
    milestoneIid?: number;
    branch?: string;
  },
): Promise<{ ok: true; record: SliceSyncRecord } | FetchErr> {
  const result = await gitlabFetch<GitLabIssue>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: issueData.title,
        description: issueData.description,
        labels: issueData.labels?.join(","),
        ...(issueData.milestoneIid !== undefined
          ? { milestone_id: issueData.milestoneIid }
          : {}),
      }),
    },
    "create-slice-issue",
  );

  if (!result.ok) return result;

  const { id, iid, state } = result.data;
  return {
    ok: true,
    record: {
      id,
      iid,
      sliceIssueIid: iid,
      lastSyncedAt: new Date().toISOString(),
      state: state === "opened" ? "opened" : "closed",
      branch: issueData.branch,
    },
  };
}

// ─── Note (Comment) Operations ───────────────────────────────────────────────

interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
}

/**
 * Post a comment/note to a GitLab issue.
 */
export async function postIssueNote(
  baseUrl: string,
  token: string,
  projectPath: string,
  issueIid: number,
  noteBody: string,
): Promise<{ ok: true; noteId: number } | FetchErr> {
  const result = await gitlabFetch<GitLabNote>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}/notes`,
    {
      method: "POST",
      body: JSON.stringify({ body: noteBody }),
    },
    "post-issue-note",
  );

  if (!result.ok) return result;
  return { ok: true, noteId: result.data.id };
}

/**
 * Post a comment/note to a GitLab merge request.
 */
export async function postMergeRequestNote(
  baseUrl: string,
  token: string,
  projectPath: string,
  mrIid: number,
  noteBody: string,
): Promise<{ ok: true; noteId: number } | FetchErr> {
  const result = await gitlabFetch<GitLabNote>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/notes`,
    {
      method: "POST",
      body: JSON.stringify({ body: noteBody }),
    },
    "post-mr-note",
  );

  if (!result.ok) return result;
  return { ok: true, noteId: result.data.id };
}

// ─── Issue Close ─────────────────────────────────────────────────────────────

interface GitLabIssueUpdate {
  id: number;
  iid: number;
  state: string;
}

/**
 * Close a GitLab issue by its IID.
 */
export async function closeIssue(
  baseUrl: string,
  token: string,
  projectPath: string,
  issueIid: number,
): Promise<{ ok: true; record: SyncEntityRecord } | FetchErr> {
  const result = await gitlabFetch<GitLabIssueUpdate>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    {
      method: "PUT",
      body: JSON.stringify({ state_event: "close" }),
    },
    "close-issue",
  );

  if (!result.ok) return result;

  const { id, iid, state } = result.data;
  return {
    ok: true,
    record: {
      id,
      iid,
      lastSyncedAt: new Date().toISOString(),
      state: state === "closed" ? "closed" : "opened",
    },
  };
}

// ─── Branch Operations ────────────────────────────────────────────────────────

interface GitLabBranch {
  name: string;
  commit: { id: string };
}

/**
 * Create a new GitLab branch (does not push content — use for branch creation only).
 * The branch is created from `ref` (default: main).
 */
export async function createBranch(
  baseUrl: string,
  token: string,
  projectPath: string,
  branchName: string,
  ref = "main",
): Promise<{ ok: true; branchName: string; commitSha: string } | FetchErr> {
  const result = await gitlabFetch<GitLabBranch>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/repository/branches`,
    {
      method: "POST",
      body: JSON.stringify({ branch: branchName, ref }),
    },
    "create-branch",
  );

  if (!result.ok) return result;
  return {
    ok: true,
    branchName: result.data.name,
    commitSha: result.data.commit.id,
  };
}

// ─── Merge Request Operations ─────────────────────────────────────────────────

interface GitLabMR {
  id: number;
  iid: number;
  title: string;
  state: string;
  web_url: string;
  draft: boolean;
}

export interface CreateMergeRequestOptions {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch?: string;
  /** Set to true to create as WIP/draft. Default: true. */
  draft?: boolean;
  labels?: string[];
  milestoneIid?: number;
}

/**
 * Create a draft merge request.
 */
export async function createMergeRequest(
  baseUrl: string,
  token: string,
  projectPath: string,
  opts: CreateMergeRequestOptions,
): Promise<{ ok: true; mrIid: number; mrId: number; webUrl: string } | FetchErr> {
  const result = await gitlabFetch<GitLabMR>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests`,
    {
      method: "POST",
      body: JSON.stringify({
        title: opts.title,
        description: opts.description ?? "",
        source_branch: opts.sourceBranch,
        target_branch: opts.targetBranch ?? "main",
        draft: opts.draft ?? true,
        labels: opts.labels?.join(","),
        ...(opts.milestoneIid !== undefined
          ? { milestone_id: opts.milestoneIid }
          : {}),
      }),
    },
    "create-mr",
  );

  if (!result.ok) return result;

  const { id, iid, web_url } = result.data;
  return { ok: true, mrIid: iid, mrId: id, webUrl: web_url };
}

export interface UpdateMergeRequestOptions {
  title?: string;
  description?: string;
  /** Set to false to mark MR as ready (remove WIP prefix). */
  draft?: boolean;
  stateEvent?: "merge" | "close";
}

/**
 * Update a merge request (change title, description, ready state, or merge/close).
 */
export async function updateMergeRequest(
  baseUrl: string,
  token: string,
  projectPath: string,
  mrIid: number,
  opts: UpdateMergeRequestOptions,
): Promise<{ ok: true; mrIid: number; state: string; draft: boolean } | FetchErr> {
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.draft !== undefined) body.draft = opts.draft;
  if (opts.stateEvent !== undefined) body.state_event = opts.stateEvent;

  const result = await gitlabFetch<GitLabMR>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    "update-mr",
  );

  if (!result.ok) return result;

  const { iid, state, draft } = result.data;
  return { ok: true, mrIid: iid, state, draft };
}

/**
 * Mark a draft MR as ready (remove WIP/draft flag).
 * Convenience wrapper around updateMergeRequest.
 */
export async function markMergeRequestReady(
  baseUrl: string,
  token: string,
  projectPath: string,
  mrIid: number,
): Promise<{ ok: true; mrIid: number; draft: false } | FetchErr> {
  const result = await updateMergeRequest(baseUrl, token, projectPath, mrIid, { draft: false });
  if (!result.ok) return result;
  // The draft=false input guarantees draft is false in the response
  return { ok: true, mrIid: result.mrIid, draft: false as const };
}

/**
 * Merge an MR.
 */
export async function mergeMergeRequest(
  baseUrl: string,
  token: string,
  projectPath: string,
  mrIid: number,
  mergeCommitMessage?: string,
): Promise<{ ok: true; mergedBy: number; mergeCommitSha: string } | FetchErr> {
  const mergedResult = await gitlabFetch<{ merged_by: { id: number }; merge_commit_sha: string }>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/merge`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...(mergeCommitMessage ? { merge_commit_message: mergeCommitMessage } : {}),
      }),
    },
    "merge-mr",
  );

  if (!mergedResult.ok) return mergedResult;
  return {
    ok: true,
    mergedBy: mergedResult.data.merged_by.id,
    mergeCommitSha: mergedResult.data.merge_commit_sha,
  };
}

// ─── Commit Reference Lookup ─────────────────────────────────────────────────

interface GitLabCommit {
  id: string;
  message: string;
  committed_date: string;
}

/** Regex to extract "Closes gitlab!{iid}" references from commit messages. */
const CLOSE_REFERENCE_RE = /Closes\s+gitlab!(\d+)/gi;

/**
 * Look up commits on an MR that contain GitLab close references.
 * Populates a CommitReferenceMap for task keys whose GitLab issue IIDs appear
 * in the referenced close messages.
 *
 * The taskKeys argument is the list of "mid/sid/tid" keys whose task records
 * are currently synced; only those tasks whose mapped GitLab IID appears in
 * a commit message are included in the result.
 */
export async function lookupCommitReferences(
  baseUrl: string,
  token: string,
  projectPath: string,
  mrIid: number,
  taskIidMap: Record<string, number>,
): Promise<{ ok: true; references: CommitReferenceMap } | FetchErr> {
  const commitsResult = await gitlabFetch<GitLabCommit[]>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/commits`,
    { method: "GET" },
    "lookup-commit-refs",
  );

  if (!commitsResult.ok) return commitsResult;

  const references: CommitReferenceMap = {};
  for (const commit of commitsResult.data) {
    let match: RegExpExecArray | null;
    // Reset lastIndex before each iteration
    CLOSE_REFERENCE_RE.lastIndex = 0;
    while ((match = CLOSE_REFERENCE_RE.exec(commit.message)) !== null) {
      const closedIid = parseInt(match[1], 10);
      // Find which task key maps to this IID
      for (const [taskKey, taskIid] of Object.entries(taskIidMap)) {
        if (taskIid === closedIid) {
          references[taskKey] = {
            sha: commit.id,
            issueIid: closedIid,
            committedDate: commit.committed_date,
          };
        }
      }
    }
  }

  return { ok: true, references };
}

// ─── Close Reference ────────────────────────────────────────────────────────

/**
 * Build a GitLab close reference for use in commit messages.
 * @example "Closes gitlab!42"
 */
export function buildCloseReference(iid: number): string {
  return `Closes gitlab!${iid}`;
}
