/**
 * GitLab Sync extension for GSD.
 *
 * Opt-in extension that syncs GSD milestones to GitLab milestones + tracking issues.
 *
 * Integration happens via a single dynamic import in auto-post-unit.ts.
 * This index registers a `/gitlab-sync` command for manual bootstrap
 * and status display.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { bootstrapSync } from "./sync.js";
import { loadSyncMapping } from "./mapping.js";
import { resolveGitLabToken, resolveProject } from "./api.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("gitlab-sync", {
    description: "Bootstrap GitLab sync or show sync status",
    // @ts-expect-error ExtensionCommandContext from workspace @gsd/pi-coding-agent package
    handler: async (args: string, ctx) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "status") {
        await showStatus(ctx);
        return;
      }

      if (subcommand === "bootstrap" || subcommand === "") {
        await runBootstrap(ctx);
        return;
      }

      ctx.ui.notify(
        "Usage: /gitlab-sync [bootstrap|status]",
        "info",
      );
    },
  });
}

async function showStatus(ctx: ExtensionCommandContext) {
  const config = loadGitLabSyncConfig(ctx.cwd);
  if (!config?.enabled) {
    ctx.ui.notify(
      "GitLab sync: not configured. Set preferences.gitlab.enabled=true to enable.",
      "info",
    );
    return;
  }

  const project = resolveProject(config);
  if (!project) {
    ctx.ui.notify(
      "GitLab sync: no project configured. Set preferences.gitlab.project to 'group/project'.",
      "warning",
    );
    return;
  }

  const token = resolveGitLabToken();
  if (!token) {
    ctx.ui.notify(
      "GitLab sync: GITLAB_TOKEN env var is not set.",
      "warning",
    );
    return;
  }

  const mapping = loadSyncMapping(ctx.cwd);
  if (!mapping) {
    ctx.ui.notify(
      "GitLab sync: No sync mapping found. Run `/gitlab-sync bootstrap` to initialize.",
      "info",
    );
    return;
  }

  const milestoneCount = Object.keys(mapping.milestones).length;
  const sliceCount = Object.keys(mapping.slices).length;
  const taskCount = Object.keys(mapping.tasks).length;
  const openMilestones = Object.values(mapping.milestones).filter(m => m.state === "opened").length;
  const openSlices = Object.values(mapping.slices).filter(s => s.state === "opened").length;
  const openTasks = Object.values(mapping.tasks).filter(t => t.state === "opened").length;

  ctx.ui.notify(
    [
      `GitLab sync: project=${mapping.project}`,
      `  Milestones: ${milestoneCount} (${openMilestones} open)`,
      `  Slices: ${sliceCount} (${openSlices} open)`,
      `  Tasks: ${taskCount} (${openTasks} open)`,
    ].join("\n"),
    "info",
  );
}

async function runBootstrap(ctx: ExtensionCommandContext) {
  const config = loadGitLabSyncConfig(ctx.cwd);
  if (!config?.enabled) {
    ctx.ui.notify(
      "GitLab sync: not configured. Set preferences.gitlab.enabled=true to enable.",
      "info",
    );
    return;
  }

  const project = resolveProject(config);
  if (!project) {
    ctx.ui.notify(
      "GitLab sync: no project configured. Set preferences.gitlab.project to 'group/project'.",
      "warning",
    );
    return;
  }

  const token = resolveGitLabToken();
  if (!token) {
    ctx.ui.notify(
      "GitLab sync: GITLAB_TOKEN env var is not set.",
      "warning",
    );
    return;
  }

  ctx.ui.notify("GitLab sync: bootstrapping...", "info");

  try {
    const counts = await bootstrapSync(ctx.cwd);
    if (counts.milestones === 0 && counts.slices === 0 && counts.tasks === 0) {
      ctx.ui.notify(
        "GitLab sync: everything already synced (or no milestones found).",
        "info",
      );
    } else {
      ctx.ui.notify(
        `GitLab sync: created ${counts.milestones} milestone(s), ${counts.slices} slice(s), ${counts.tasks} task(s).`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`GitLab sync bootstrap failed: ${err}`, "error");
  }
}

// ─── Config Loading ─────────────────────────────────────────────────────────

let _cachedConfig: import("./types.js").GitLabSyncConfig | null | undefined;

function loadGitLabSyncConfig(basePath: string): import("./types.js").GitLabSyncConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig ?? null;
  try {
    const prefs = loadEffectiveGSDPreferences(basePath);
    const gitlab = (prefs?.preferences as Record<string, unknown>)?.gitlab;
    if (!gitlab || typeof gitlab !== "object") {
      _cachedConfig = null;
      return null;
    }
    _cachedConfig = gitlab as import("./types.js").GitLabSyncConfig;
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
