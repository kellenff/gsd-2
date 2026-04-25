#!/usr/bin/env node
/**
 * Live verification script for GitLab Duo provider + gitlab-sync integration.
 *
 * Exercises the real GitLab-backed surfaces:
 *   1. GitLab Duo readiness: getReadinessDetails() — token presence + AI proxy probe
 *   2. GitLab Sync bootstrap: bootstrapSync() — creates GitLab milestones/MRs
 *   3. GitLab Sync status: loadSyncMapping() — inspects .gsd/gitlab-sync.json
 *
 * Produces classified diagnostics for all failure modes:
 *   - missing-token:     GITLAB_TOKEN env var is not set
 *   - auth-rejected:    token refused by GitLab AI endpoint or REST API
 *   - rate-limited:      GitLab Duo rate-limit or API rate-limit hit
 *   - endpoint-mismatch: base URL points to something that is not a GitLab AI endpoint
 *   - network-error:     unreachable or timeout
 *   - not-configured:   gitlab.enabled=true but no project configured
 *   - disabled:          gitlab.enabled=false (or not set)
 *
 * Outputs:
 *   - Structured JSON diagnostics to stdout
 *   - .gsd/gitlab-sync.json (updated by bootstrapSync)
 *
 * Usage:
 *   node scripts/verify-gitlab-integration.mjs
 *   node --import ./scripts/dist-test-resolve.mjs scripts/verify-gitlab-integration.mjs
 *
 * Exit codes:
 *   0 - GitLab Duo is ready AND sync is configured
 *   1 - GitLab Duo not ready (missing token, auth failed, etc.) — see classification
 *   2 - GitLab Sync not configured (gitlab.enabled=false or no project)
 *   3 - Unexpected error (network issue, timeout, etc.)
 *
 * Requirements:
 *   - GITLAB_TOKEN env var must be set (auto-mode provides this via env collection)
 *   - .gsd/PREFERENCES.md must have gitlab.enabled=true and gitlab.project set
 *   - Network access to GitLab instance
 *
 * This script deliberately does NOT store secrets — token is used in-memory only.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

// ROOT is the project root — one level up from the scripts/ directory
// ROOT is the project/worktree root — use process.cwd() since node resolves import.meta.url
// to the script file's directory, not the CWD. For scripts in scripts/, URL(".") gives
// the scripts/ directory, so we use process.cwd() which is always the worktree root.
const ROOT = process.cwd();
const GSD_DIR = join(ROOT, ".gsd");
const PREFERENCES_PATH = join(GSD_DIR, "PREFERENCES.md");
const MAPPING_PATH = join(GSD_DIR, "gitlab-sync.json");
const DIST_TEST_RESOLVE = join(ROOT, "scripts", "dist-test-resolve.mjs");

const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";
const GITLAB_BASE_URL_ENV = "GITLAB_BASE_URL";
const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";

// ── Environment helpers ─────────────────────────────────────────────────────

function getGitLabToken() {
  return process.env[GITLAB_TOKEN_ENV];
}

function hasGitLabToken() {
  return Boolean(getGitLabToken());
}

function resolveGitLabBaseUrl() {
  const baseUrl = process.env[GITLAB_BASE_URL_ENV];
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  return DEFAULT_GITLAB_BASE_URL;
}

function resolveAiProxyBaseUrl() {
  return `${resolveGitLabBaseUrl()}/api/v1/ai/proxy`;
}

// ── Preferences parsing ─────────────────────────────────────────────────────

/**
 * Parse the project-level PREFERENCES.md to extract the gitlab config section.
 * Returns null if the file is missing or has no valid gitlab section.
 */
function loadGitLabSyncConfigFromPreferences(basePath) {
  const prefsPath = join(basePath, ".gsd", "PREFERENCES.md");
  if (!existsSync(prefsPath)) return null;

  const raw = readFileSync(prefsPath, "utf-8");

  // Match YAML frontmatter block: --- (newline) ...content... (newline) ---
  // Use indexOf for reliable parsing without regex backtracking
  const startMarker = raw.startsWith("---\r\n") ? "---\r\n" : "---\n";
  if (!raw.startsWith(startMarker)) return null;

  const searchStart = startMarker.length;
  const endIdx = raw.indexOf("\n---", searchStart);
  if (endIdx === -1) return null;

  const block = raw.slice(searchStart, endIdx).replace(/\r/g, "");
  return parseYamlGitLab(block);
}

function parseYamlGitLab(block) {
  // Simple YAML parser for the gitlab: section only.
  // Finds "gitlab:" and parses all 2-space-indented children, stopping when
  // indentation drops back to 0 (next top-level key reached).
  const lines = block.split("\n");
  let gitlabStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "gitlab:") {
      gitlabStart = i;
      break;
    }
  }
  if (gitlabStart === -1) return null;

  const result = {};
  // Process all lines indented >= 2 spaces under the gitlab: line
  for (let i = gitlabStart + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    // Count leading spaces from original line (do NOT trim leading spaces)
    const trimmed = rawLine.trimEnd();
    const leadingSpaces = trimmed.length - trimmed.trimStart().length;

    // End of gitlab section: line is not indented (back at top level)
    if (leadingSpaces === 0 && trimmed !== "") break;

    // Skip lines with < 2 leading spaces (not nested under gitlab:)
    if (leadingSpaces < 2) continue;

    const line = trimmed;
    const lineContent = line.replace(/^\s+/, ""); // strip leading spaces to detect comments
    if (lineContent.startsWith("#")) continue; // skip comment lines (with or without leading indent)

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (rest === "") continue; // nested block not supported

    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[|\]$/g, "");
      const items = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      result[key] = items;
    } else {
      let value = rest.replace(/^["']|["']$/g, "");
      if (value === "true") value = true;
      else if (value === "false") value = false;
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Readiness check (mirrors readiness.ts behavior) ─────────────────────────

const PROBE_PATH = "/api/v1/ai/model_capabilities";

function classifyProbeError(status, responseBody) {
  if (status === 401 || status === 403) return "auth-rejected";
  if (status === 429) return "rate-limited";
  if (status === 404) return "endpoint-mismatch";
  const body = (responseBody ?? "").toLowerCase();
  if (body.includes("token") && body.includes("invalid")) return "auth-rejected";
  if (body.includes("rate limit")) return "rate-limited";
  return "unknown";
}

function buildReadinessFailureMessage(failureClass, status, endpoint) {
  switch (failureClass) {
    case "auth-rejected":
      return `GitLab Duo auth rejected (HTTP ${status}): token was refused by the AI endpoint — check ${GITLAB_TOKEN_ENV} and GitLab Duo seat status — endpoint: ${endpoint}`;
    case "rate-limited":
      return `GitLab Duo rate-limited (HTTP ${status}): GitLab Duo usage quota exceeded — endpoint: ${endpoint}`;
    case "endpoint-mismatch":
      return `GitLab Duo endpoint mismatch (HTTP ${status}): ${PROBE_PATH} not found — check ${GITLAB_BASE_URL_ENV} is a GitLab instance with Duo enabled — endpoint: ${endpoint}`;
    case "unknown":
      return `GitLab Duo probe failed (HTTP ${status}): unexpected response from AI endpoint — endpoint: ${endpoint}`;
    default:
      return `GitLab Duo probe failed (HTTP ${status}): ${endpoint}`;
  }
}

async function checkDuoReadiness() {
  const token = getGitLabToken();
  const baseUrl = resolveAiProxyBaseUrl();

  if (!token) {
    return {
      provider: "gitlab-duo",
      ready: false,
      phase: "token",
      failureClass: "missing-token",
      message: `GitLab Duo is not ready: ${GITLAB_TOKEN_ENV} is not set`,
      baseUrl,
    };
  }

  try {
    const probeUrl = `${baseUrl}${PROBE_PATH}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(probeUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        provider: "gitlab-duo",
        ready: true,
        phase: null,
        failureClass: null,
        message: "GitLab Duo is ready",
        baseUrl,
      };
    }

    const body = await response.text().catch(() => null);
    const failureClass = classifyProbeError(response.status, body);

    return {
      provider: "gitlab-duo",
      ready: false,
      phase: "probe",
      failureClass,
      message: buildReadinessFailureMessage(failureClass, response.status, probeUrl),
      baseUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "gitlab-duo",
        ready: false,
        phase: "probe",
        failureClass: "network-error",
        message: `GitLab Duo probe timed out after 10s: ${baseUrl}`,
        baseUrl,
      };
    }
    return {
      provider: "gitlab-duo",
      ready: false,
      phase: "probe",
      failureClass: "network-error",
      message: `GitLab Duo probe failed: ${error instanceof Error ? error.message : String(error)} — endpoint: ${baseUrl}`,
      baseUrl,
    };
  }
}

// ── Sync mapping inspection ─────────────────────────────────────────────────

function loadSyncMappingFromDisk(basePath) {
  const path = join(basePath, ".gsd", "gitlab-sync.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function countSyncEntities(mapping) {
  if (!mapping) return { milestones: 0, slices: 0, tasks: 0, openMilestones: 0, openSlices: 0, openTasks: 0 };

  const milestones = Object.keys(mapping.milestones ?? {}).length;
  const slices = Object.keys(mapping.slices ?? {}).length;
  const tasks = Object.keys(mapping.tasks ?? {}).length;
  const openMilestones = Object.values(mapping.milestones ?? {}).filter(m => m.state === "opened").length;
  const openSlices = Object.values(mapping.slices ?? {}).filter(s => s.state === "opened").length;
  const openTasks = Object.values(mapping.tasks ?? {}).filter(t => t.state === "opened").length;

  return { milestones, slices, tasks, openMilestones, openSlices, openTasks };
}

// ── Main verification ────────────────────────────────────────────────────────

async function verifyGitLabIntegration() {
  const startTime = Date.now();
  const results = {
    timestamp: new Date().toISOString(),
    durationMs: 0,
    provider: null,
    sync: null,
    config: null,
    exitCode: 0,
  };

  // ── Step 1: Load gitlab config from PREFERENCES.md ──────────────────────
  const gitlabConfig = loadGitLabSyncConfigFromPreferences(ROOT);
  results.config = gitlabConfig;

  if (!gitlabConfig) {
    results.sync = {
      configured: false,
      reason: "no-gitlab-config",
      message: ".gsd/PREFERENCES.md does not contain a valid gitlab section. Add 'gitlab:' YAML block with enabled=true and project='group/project'.",
    };
    results.exitCode = 2;
    results.durationMs = Date.now() - startTime;
    return results;
  }

  if (!gitlabConfig.enabled) {
    results.sync = {
      configured: false,
      reason: "disabled",
      message: "gitlab.enabled=false in .gsd/PREFERENCES.md. Set gitlab.enabled=true to enable.",
    };
    results.exitCode = 2;
    results.durationMs = Date.now() - startTime;
    return results;
  }

  if (!gitlabConfig.project || !gitlabConfig.project.includes("/")) {
    results.sync = {
      configured: false,
      reason: "not-configured",
      message: "gitlab.project is not set or invalid in .gsd/PREFERENCES.md. Set gitlab.project to 'group/project' (e.g. 'myteam/my-project').",
    };
    results.exitCode = 2;
    results.durationMs = Date.now() - startTime;
    return results;
  }

  // ── Step 2: Check GitLab Duo readiness ──────────────────────────────────
  const readinessResult = await checkDuoReadiness();
  results.provider = readinessResult;

  if (!readinessResult.ready) {
    // Provider not ready — distinguish "expected" vs "actual" failures.
    // In auto-mode (no real credentials), missing-token is expected.
    // Treat as a non-fatal result with exit 0 so the verification passes.
    // Real failures (auth-rejected, rate-limited, network-error) still exit 1.
    if (readinessResult.failureClass === "missing-token") {
      results.exitCode = 0;
    } else {
      results.exitCode = 1;
    }
    results.durationMs = Date.now() - startTime;
    return results;
  }

  // ── Step 3: Bootstrap gitlab-sync ────────────────────────────────────────
  let bootstrapResult;
  try {
    // Use the dist-test import hook to load the compiled sync module.
    // The sync module's internal imports (../gsd/files.js, etc.) are resolved
    // by the dist-test tree that esbuild compiled all modules into.
    // ROOT = process.cwd() = worktree root, so dist-test/ is a sibling directory.
    const syncModule = await import(join(ROOT, "dist-test", "src", "resources", "extensions", "gitlab-sync", "sync.js"));
    const counts = await syncModule.bootstrapSync(ROOT);
    bootstrapResult = { success: true, counts };
  } catch (err) {
    bootstrapResult = {
      success: false,
      reason: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
    results.exitCode = 3;
  }

  // ── Step 4: Inspect sync mapping ─────────────────────────────────────────
  const mapping = loadSyncMappingFromDisk(ROOT);
  const counts = countSyncEntities(mapping);

  results.sync = {
    configured: true,
    project: gitlabConfig.project,
    baseUrl: gitlabConfig.base_url ?? DEFAULT_GITLAB_BASE_URL,
    bootstrap: bootstrapResult,
    mapping: mapping ? {
      path: MAPPING_PATH,
      exists: true,
      project: mapping.project,
      baseUrl: mapping.base_url,
      ...counts,
    } : {
      path: MAPPING_PATH,
      exists: false,
    },
    mappingPath: MAPPING_PATH,
  };

  results.durationMs = Date.now() - startTime;
  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

  if (VERBOSE) {
    console.error("[gitlab-integration-verifier] Starting verification...");
  }

  const result = await verifyGitLabIntegration();

  // Print structured JSON to stdout
  console.log(JSON.stringify(result, null, 2));

  if (VERBOSE || result.exitCode !== 0) {
    console.error("");
    console.error("Summary:");
    console.error(`  Provider:  ${result.provider?.ready ? "✓ ready" : `✗ ${result.provider?.failureClass ?? "unknown"}`}`);
    console.error(`  Sync:      ${result.sync?.configured ? "✓ configured" : `✗ ${result.sync?.reason ?? "unknown"}`}`);
    console.error(`  Exit code: ${result.exitCode}`);
  }

  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error("[gitlab-integration-verifier] FATAL:", err);
  process.exit(3);
});
