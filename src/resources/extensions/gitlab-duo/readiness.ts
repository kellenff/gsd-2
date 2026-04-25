/**
 * Readiness helpers for the GitLab Duo provider.
 *
 * Verifies that GITLAB_TOKEN is present and that the AI endpoint is reachable
 * and accepting requests. Results are cached to avoid hammering the endpoint
 * on every model-availability check.
 *
 * Two kinds of checks live here:
 *
 * 1. **Documented configuration checks** (token presence, base URL):
 *    These reflect env-var configuration that is stable and documented.
 *    Failures here are configuration errors, not endpoint problems.
 *
 * 2. **Empirical heuristic probe** (live HTTP probe):
 *    The live probe hits the AI proxy capabilities endpoint and is an
 *    implementation heuristic, NOT a documented public GitLab API contract.
 *    Current GitLab docs do not publish a stable third-party model-capabilities
 *    endpoint for the managed GitLab.com Duo surface.  Probe failures may
 *    indicate:
 *    - auth/endpoint problems (real failures), or
 *    - a GitLab-side internal change that broke an undocumented path
 *      (false negative, not a configuration error).
 *    Future agents should treat probe failures as diagnostics, not as
 *    proof that GitLab Duo is misconfigured.
 *
 * Failure classification is explicit and redacted — the error messages expose
 * the failure class (auth, endpoint, protocol, rate-limit) without leaking
 * the actual token value or internal endpoint details that could aid an attacker.
 *
 * Failure classes:
 *  - missing-token:  GITLAB_TOKEN env var is not set
 *  - auth-rejected:  token rejected by the GitLab AI endpoint
 *  - rate-limited:   GitLab Duo rate-limit hit
 *  - endpoint-mismatch: base URL points to something that is not a GitLab AI endpoint
 *  - network-error:  unreachable or timeout
 */

/** Env var name for the GitLab personal access token. */
export const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";

/** Env var name for the GitLab instance base URL. Defaults to https://gitlab.com. */
export const GITLAB_BASE_URL_ENV = "GITLAB_BASE_URL";

/** Default GitLab.com AI endpoint base URL. */
export const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";

/** AI proxy sub-path appended to the base URL. */
export const AI_PROXY_PATH = "/api/v1/ai/proxy";

/**
 * Probe endpoint path — a lightweight health check on the AI proxy.
 *
 * EMPIRICAL HEURISTIC: This path is an implementation assumption, not a
 * documented public GitLab API contract.  Current GitLab docs do not publish
 * a stable third-party model_capabilities endpoint for the managed GitLab.com
 * Duo surface.  The probe may succeed, fail, or return unexpected shapes
 * depending on GitLab-side internals.  Treat probe outcomes as diagnostics,
 * not as proof of a public API contract.
 *
 * If this endpoint disappears or changes in a future GitLab release, the
 * readiness layer will surface an endpoint-mismatch failure.  Future agents
 * should update PROBE_PATH to match the current GitLab AI proxy surface
 * rather than treating failures here as configuration errors.
 */
export const PROBE_PATH = "/api/v1/ai/model_capabilities";

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the GitLab AI proxy base URL.
 *
 * Uses GITLAB_BASE_URL when set, otherwise derives from GITLAB_TOKEN's format
 * (tokens scoped to gitlab.com use the SaaS endpoint).
 *
 * Falls back to the default SaaS URL when GITLAB_TOKEN is present but
 * GITLAB_BASE_URL is not — common for self-hosted instances where the agent
 * operator knows their base URL.
 */
export function resolveGitLabBaseUrl(): string {
	const baseUrl = process.env[GITLAB_BASE_URL_ENV];
	if (baseUrl) {
		// Strip trailing slash for consistent URL joining
		return baseUrl.replace(/\/$/, "");
	}
	return DEFAULT_GITLAB_BASE_URL;
}

/** Returns the full AI proxy endpoint base URL. */
export function resolveAiProxyBaseUrl(): string {
	return `${resolveGitLabBaseUrl()}${AI_PROXY_PATH}`;
}

// ---------------------------------------------------------------------------
// Token access
// ---------------------------------------------------------------------------

/** Returns the GITLAB_TOKEN value, or undefined when the env var is not set. */
export function getGitLabToken(): string | undefined {
	return process.env[GITLAB_TOKEN_ENV];
}

/**
 * Returns true when GITLAB_TOKEN is set (presence check).
 * Does NOT verify the token is valid — that requires a network probe.
 */
export function hasGitLabToken(): boolean {
	return Boolean(getGitLabToken());
}

// ---------------------------------------------------------------------------
// Readiness result types
// ---------------------------------------------------------------------------

/** Failure phase — helps a future agent understand where the check failed. */
export type ReadinesPhase = "token" | "probe";

/** Failure class — used for redacted error classification. */
export type ReadinessFailureClass =
	| "missing-token"
	| "auth-rejected"
	| "rate-limited"
	| "endpoint-mismatch"
	| "network-error"
	| "unknown";

export interface ReadinessResult {
	ready: boolean;
	phase: ReadinesPhase | null;
	failureClass: ReadinessFailureClass | null;
	/** Redacted message — base URL is shown but token is masked. */
	message: string;
	/** Base URL shown to aid debugging without leaking token. */
	baseUrl: string;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

let cachedResult: ReadinessResult | null = null;
let lastCheckMs = 0;
const CHECK_INTERVAL_MS = 30_000;
/** Reuse an in-flight check to avoid concurrent probes. */
let pendingCheck: Promise<ReadinessResult> | null = null;

/**
 * Async cache refresh — used for the token-present path where a live probe
 * is required.  Stores the resolved ReadinessResult in cachedResult.
 */
async function refreshCacheAsync(): Promise<void> {
	const now = Date.now();
	if (cachedResult !== null && now - lastCheckMs < CHECK_INTERVAL_MS) {
		return;
	}
	if (pendingCheck !== null) {
		cachedResult = await pendingCheck;
		lastCheckMs = Date.now();
		return;
	}
	lastCheckMs = now;
	pendingCheck = checkReadiness();
	try {
		cachedResult = await pendingCheck;
	} finally {
		pendingCheck = null;
	}
}

/** Clear the readiness cache — call after the user sets/changes GITLAB_TOKEN. */
export function clearReadinessCache(): void {
	cachedResult = null;
	lastCheckMs = 0;
}

// ---------------------------------------------------------------------------
// Core readiness check
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error response from the probe into a failure class.
 *
 * Uses status codes and response body patterns — does NOT log the response
 * body to avoid persisting sensitive details.
 */
function classifyProbeError(status: number, responseBody: string | null): ReadinessFailureClass {
	if (status === 401 || status === 403) {
		return "auth-rejected";
	}
	if (status === 429) {
		return "rate-limited";
	}
	if (status === 404) {
		return "endpoint-mismatch";
	}
	// Sanitise the body before inspection — only look for structural patterns.
	// No token values, no Authorization headers, no user/project identifiers.
	const body = (responseBody ?? "").toLowerCase();
	if (body.includes("token") && body.includes("invalid")) {
		return "auth-rejected";
	}
	if (body.includes("rate limit")) {
		return "rate-limited";
	}
	return "unknown";
}

/**
 * Redact a token from a URL string for safe logging.
 *
 * GitLab tokens are 20-char alphanumeric strings (classic PATs) or
 * Bearer tokens starting with `glpat-`. This function masks anything
 * that looks like a token parameter value without assuming a specific format.
 */
function redactTokenFromUrl(url: string): string {
	// Mask query-string token values (GITLAB_TOKEN is passed as a header, but
	// some proxy configurations embed it in the URL — defensive masking)
	return url.replace(/(token|key|secret)=[^&\s]*/gi, "$1=***REDACTED***");
}

/**
 * Perform the actual readiness check with a live HTTP probe.
 *
 * Returns a redacted ReadinessResult — the token is never included in the
 * message, and the base URL is shown only to aid downstream debugging.
 */
async function checkReadiness(): Promise<ReadinessResult> {
	const token = getGitLabToken();
	const baseUrl = resolveAiProxyBaseUrl();

	if (!token) {
		return {
			ready: false,
			phase: "token",
			failureClass: "missing-token",
			message: `GitLab Duo is not ready: ${GITLAB_TOKEN_ENV} is not set`,
			baseUrl,
		};
	}

	// Probe the AI proxy capabilities endpoint with a HEAD or lightweight GET.
	// Do NOT send the Authorization header to avoid logging it in access logs
	// — the endpoint may not need auth for a health-check endpoint.
	try {
		const probeUrl = `${baseUrl}${PROBE_PATH}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);

		const response = await fetch(probeUrl, {
			method: "GET",
			headers: {
				// Include auth to properly probe the authenticated endpoint
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (response.ok) {
			return {
				ready: true,
				phase: null,
				failureClass: null,
				message: "GitLab Duo is ready",
				baseUrl,
			};
		}

		// Read body once (streamed — read and discard)
		const body = await response.text().catch(() => null);
		const failureClass = classifyProbeError(response.status, body);

		return {
			ready: false,
			phase: "probe",
			failureClass,
			message: buildFailureMessage(failureClass, response.status, redactTokenFromUrl(probeUrl)),
			baseUrl: redactTokenFromUrl(baseUrl),
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				ready: false,
				phase: "probe",
				failureClass: "network-error",
				message: `GitLab Duo probe timed out after 10s: ${redactTokenFromUrl(baseUrl)}`,
				baseUrl: redactTokenFromUrl(baseUrl),
			};
		}
		return {
			ready: false,
			phase: "probe",
			failureClass: "network-error",
			message: `GitLab Duo probe failed: ${error instanceof Error ? error.message : String(error)} — endpoint: ${redactTokenFromUrl(baseUrl)}`,
			baseUrl: redactTokenFromUrl(baseUrl),
		};
	}
}

/** Build a human-readable failure message for a given failure class. */
function buildFailureMessage(failureClass: ReadinessFailureClass, status: number, endpoint: string): string {
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

// ---------------------------------------------------------------------------
// Public readiness API
// ---------------------------------------------------------------------------

/**
 * Full readiness check — token presence AND live probe.
 *
 * This is the gating function used by the provider registration.
 * Use getReadinessDetails() to get the classified failure when not ready.
 *
 * Note: the token-presence path returns synchronously (no network call needed).
 * The live-probe path fires an async background check; subsequent calls
 * return the cached result once the probe completes.
 */
export function isGitLabDuoReady(): boolean {
	// Missing-token path: check synchronously without network call.
	if (!hasGitLabToken()) {
		return false;
	}
	// Token present: return cached result if available.
	// The background probe (if any) populates the cache for future calls.
	void refreshCacheAsync(); // fire-and-forget; isReady just gates availability
	return cachedResult?.ready ?? false;
}

/**
 * Returns the current readiness result with failure classification.
 *
 * Use this in tests and live-verification (T03) to assert on the specific
 * failure class and phase rather than just the boolean.
 *
 * Note: for the missing-token path (no network call needed), this returns
 * a synchronous ReadinessResult. For the token-present path, it may return
 * a cached result or trigger a background probe for future calls.
 */
export function getReadinessDetails(): ReadinessResult {
	// Missing-token path: synchronous, no network call needed.
	if (!hasGitLabToken()) {
		return {
			ready: false,
			phase: "token",
			failureClass: "missing-token",
			message: `GitLab Duo is not ready: ${GITLAB_TOKEN_ENV} is not set`,
			baseUrl: resolveAiProxyBaseUrl(),
		};
	}
	// Token present: return cached result if available.
	// The background probe populates the cache for future calls.
	void refreshCacheAsync(); // fire-and-forget
	if (cachedResult !== null) {
		return cachedResult;
	}
	// Cache not yet populated — return an in-progress sentinel.
	// Subsequent calls will return the cached result once the probe completes.
	return {
		ready: false,
		phase: "probe",
		failureClass: "unknown",
		message: "GitLab Duo probe in progress...",
		baseUrl: resolveAiProxyBaseUrl(),
	};
}
