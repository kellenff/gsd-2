/**
 * GitLab Duo Provider Extension
 *
 * Registers a model provider that delegates inference to GitLab's AI proxy
 * endpoint (OpenAI-compatible Responses API) using a GitLab personal access
 * token (GITLAB_TOKEN).
 *
 * The provider requires:
 *  - GITLAB_TOKEN:      a GitLab personal access token with api scope
 *  - GITLAB_BASE_URL:   optional; defaults to https://gitlab.com
 *
 * Failure diagnostics are explicit and redacted — the token is never included
 * in error messages, and the base URL is shown only to aid downstream debugging.
 *
 * Catalog posture: This provider uses a documented-first model catalog (see
 * models.ts).  The model list reflects what GitLab's public docs confirm as
 * defaults, not a runtime-discovered registry.  `reasoning` fields are
 * descriptive only — they indicate model suitability for reasoning-heavy tasks,
 * not a guaranteed request-time reasoning-control parameter.  GitLab's public
 * docs do not currently document an equivalent of Anthropic's effort/thinking
 * request options.
 *
 * Streaming reuses the openai-responses transport seam. A task-local stream
 * adapter can be introduced if the live probe exposes wire-format differences.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { GITLAB_DUO_MODELS } from "./models.js";
import { isGitLabDuoReady, getReadinessDetails } from "./readiness.js";
import { streamViaGitLabDuo } from "./stream-adapter.js";

/** Canonical provider name registered with the model registry. */
export const PROVIDER_NAME = "gitlab-duo";

export default function gitlabDuo(_pi: ExtensionAPI): void {
	_pi.registerProvider(PROVIDER_NAME, {
		authMode: "apiKey",
		baseUrl: null,
		api: "openai-responses",
		streamSimple: streamViaGitLabDuo,
		isReady: isGitLabDuoReady,
		models: [...GITLAB_DUO_MODELS],
	});
}
