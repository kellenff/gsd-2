#!/usr/bin/env node
/**
 * Live verifier for the GitLab Duo provider.
 *
 * Exercises the real GitLab-backed streaming path with the tracer-bullet provider.
 * Produces high-signal diagnostics for auth, scope, rate-limit, base-URL, and
 * protocol-shape failures.
 *
 * Usage:
 *   node scripts/verify-gitlab-duo-provider.ts
 *
 * Exit codes:
 *   0 - GitLab Duo is ready and streaming works
 *   1 - GitLab Duo is not ready (missing token, auth failed, etc.)
 *   2 - Unexpected error (network issue, timeout, etc.)
 *   3 - Protocol/wire-format incompatibility detected
 *
 * Requirements:
 *   - GITLAB_TOKEN must be set
 *   - Network access to GitLab instance (default: https://gitlab.com)
 *
 * This script deliberately does NOT store secrets — token is used in-memory only.
 */

// ============================================================================
// Inline dependencies (self-contained for direct node execution)
// ============================================================================

const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";
const GITLAB_BASE_URL_ENV = "GITLAB_BASE_URL";
const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";
const AI_PROXY_PATH = "/api/v1/ai/proxy";
const PROBE_PATH = "/api/v1/ai/model_capabilities";

function getGitLabToken() {
	return process.env[GITLAB_TOKEN_ENV];
}

function hasGitLabToken() {
	return Boolean(getGitLabToken());
}

function resolveGitLabBaseUrl() {
	const baseUrl = process.env[GITLAB_BASE_URL_ENV];
	if (baseUrl) {
		return baseUrl.replace(/\/$/, "");
	}
	return DEFAULT_GITLAB_BASE_URL;
}

function resolveAiProxyBaseUrl() {
	return `${resolveGitLabBaseUrl()}${AI_PROXY_PATH}`;
}

function redactToken(s) {
	return s.replace(/(token|key|secret)=[^&\s]*/gi, "$1=***REDACTED***");
}

function classifyProbeError(status, responseBody) {
	if (status === 401 || status === 403) return "auth-rejected";
	if (status === 429) return "rate-limited";
	if (status === 404) return "endpoint-mismatch";
	const body = (responseBody ?? "").toLowerCase();
	if (body.includes("token") && body.includes("invalid")) return "auth-rejected";
	if (body.includes("rate limit")) return "rate-limited";
	return "unknown";
}

function buildFailureMessage(failureClass, status, endpoint) {
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

// ============================================================================
// Cached readiness check (mirrors readiness.ts behavior)
// ============================================================================

let cachedResult = null;
let lastCheckMs = 0;
const CHECK_INTERVAL_MS = 30_000;

async function checkReadiness() {
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
			ready: false,
			phase: "probe",
			failureClass,
			message: buildFailureMessage(failureClass, response.status, redactToken(probeUrl)),
			baseUrl: redactToken(baseUrl),
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				ready: false,
				phase: "probe",
				failureClass: "network-error",
				message: `GitLab Duo probe timed out after 10s: ${redactToken(baseUrl)}`,
				baseUrl: redactToken(baseUrl),
			};
		}
		return {
			ready: false,
			phase: "probe",
			failureClass: "network-error",
			message: `GitLab Duo probe failed: ${error instanceof Error ? error.message : String(error)} — endpoint: ${redactToken(baseUrl)}`,
			baseUrl: redactToken(baseUrl),
		};
	}
}

async function getReadinessDetails() {
	const now = Date.now();
	if (cachedResult !== null && now - lastCheckMs < CHECK_INTERVAL_MS) {
		return cachedResult;
	}
	lastCheckMs = now;
	cachedResult = await checkReadiness();
	return cachedResult;
}

function clearReadinessCache() {
	cachedResult = null;
	lastCheckMs = 0;
}

// ============================================================================
// Stream probe
// ============================================================================

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const PROBE_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 30_000;
const MIN_STREAM_CHUNKS = 1;

function log(...args) {
	if (VERBOSE) {
		console.error("[gitlab-duo-verifier]", ...args);
	}
}

function formatDuration(ms) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

async function probeStream() {
	const token = getGitLabToken();
	const baseUrl = resolveAiProxyBaseUrl();
	const startTime = Date.now();

	clearReadinessCache();

	const url = `${baseUrl}`;
	log(`Probing streaming endpoint: ${redactToken(url)}`);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

	try {
		let chunks = 0;
		const response = await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5-20250514",
				max_tokens: 10,
				stream: true,
				input: [{ role: "user", content: "say 'ok' if you can read this" }],
			}),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const body = await response.text().catch(() => "no body");
			let failureClass;
			if (response.status === 401 || response.status === 403) failureClass = "auth-rejected";
			else if (response.status === 429) failureClass = "rate-limited";
			else if (response.status === 404) failureClass = "endpoint-mismatch";
			else if (response.status >= 500) failureClass = "server-error";
			else failureClass = "unknown";

			return {
				chunks: 0,
				latencyMs: Date.now() - startTime,
				error: `${failureClass} (HTTP ${response.status}): ${redactToken(body.slice(0, 200))}`,
			};
		}

		if (!response.body) {
			return {
				chunks: 0,
				latencyMs: Date.now() - startTime,
				error: "Response body is null — streaming not supported",
			};
		}

		const reader = response.body.getReader();
		const streamController = new AbortController();
		const streamTimeoutId = setTimeout(() => streamController.abort(), STREAM_TIMEOUT_MS);

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = new TextDecoder().decode(value);
				const lines = text.split("\n").filter((l) => l.startsWith("data: "));
				chunks += lines.length;
				log(`Received ${lines.length} SSE data lines (total: ${chunks})`);
			}
		} finally {
			clearTimeout(streamTimeoutId);
		}

		return { chunks, latencyMs: Date.now() - startTime };
	} catch (err) {
		clearTimeout(timeoutId);
		const latencyMs = Date.now() - startTime;

		if (err instanceof Error) {
			if (err.name === "AbortError") {
				return {
					chunks: 0,
					latencyMs,
					error: `Request timed out after ${formatDuration(PROBE_TIMEOUT_MS)}`,
				};
			}
			return { chunks: 0, latencyMs, error: err.message };
		}
		return { chunks: 0, latencyMs, error: String(err) };
	}
}

// ============================================================================
// Main verification
// ============================================================================

async function verify() {
	const baseUrl = resolveAiProxyBaseUrl();

	// Phase 1: Token presence check
	if (!hasGitLabToken()) {
		return {
			success: false,
			exitCode: 1,
			phase: "token",
			classification: "missing-token",
			message: `${GITLAB_TOKEN_ENV} is not set. Set it with: export ${GITLAB_TOKEN_ENV}=your_personal_access_token`,
			baseUrl: redactToken(baseUrl),
		};
	}

	// Phase 2: Readiness check
	log("Phase 2: Checking readiness...");
	const readiness = await getReadinessDetails();

	if (!readiness.ready) {
		const classification = readiness.failureClass ?? "unknown";
		const phase = readiness.phase ?? "probe";

		return {
			success: false,
			exitCode: 1,
			phase,
			classification,
			message: readiness.message,
			baseUrl: readiness.baseUrl,
		};
	}

	// Phase 3: Live streaming probe
	log("Phase 3: Probing live streaming...");
	const streamResult = await probeStream();

	if (streamResult.error) {
		let exitCode = 2;
		let classification = "network-error";

		if (streamResult.error.includes("timed out")) {
			classification = "timeout";
		} else if (streamResult.error.includes("auth-rejected")) {
			classification = "auth-rejected";
			exitCode = 1;
		} else if (streamResult.error.includes("rate-limited")) {
			classification = "rate-limited";
			exitCode = 1;
		} else if (
			streamResult.error.includes("streaming not supported") ||
			streamResult.error.includes("text/event-stream")
		) {
			classification = "protocol-incompatible";
			exitCode = 3;
		}

		return {
			success: false,
			exitCode,
			phase: "stream",
			classification,
			message: streamResult.error,
			baseUrl: redactToken(baseUrl),
			latencyMs: streamResult.latencyMs,
		};
	}

	if (streamResult.chunks < MIN_STREAM_CHUNKS) {
		return {
			success: false,
			exitCode: 3,
			phase: "stream",
			classification: "protocol-incompatible",
			message: `Stream returned ${streamResult.chunks} chunks (expected >= ${MIN_STREAM_CHUNKS}). The endpoint may not be using the expected SSE format.`,
			baseUrl: redactToken(baseUrl),
			streamChunks: streamResult.chunks,
			latencyMs: streamResult.latencyMs,
		};
	}

	return {
		success: true,
		exitCode: 0,
		phase: "stream",
		classification: "ready",
		message: `GitLab Duo streaming verified successfully. Received ${streamResult.chunks} chunks in ${formatDuration(streamResult.latencyMs)}.`,
		baseUrl: redactToken(baseUrl),
		streamChunks: streamResult.chunks,
		latencyMs: streamResult.latencyMs,
	};
}

async function main() {
	console.log("GitLab Duo Provider Verifier");
	console.log("=".repeat(50));
	console.log(`Endpoint: ${redactToken(resolveAiProxyBaseUrl())}`);
	console.log(`Timeout: ${formatDuration(PROBE_TIMEOUT_MS)} probe / ${formatDuration(STREAM_TIMEOUT_MS)} stream`);
	console.log("");

	const result = await verify();

	console.log("\nResult:");
	console.log(`  Phase:         ${result.phase}`);
	console.log(`  Status:        ${result.success ? "✓ SUCCESS" : "✗ FAILED"}`);
	console.log(`  Classification: ${result.classification}`);
	console.log(`  Message:       ${result.message}`);

	if (result.latencyMs !== undefined) {
		console.log(`  Latency:       ${formatDuration(result.latencyMs)}`);
	}

	if (result.streamChunks !== undefined) {
		console.log(`  Stream chunks: ${result.streamChunks}`);
	}

	console.log("");

	process.exit(result.exitCode);
}

main().catch((err) => {
	console.error("[gitlab-duo-verifier] ERROR:", err);
	process.exit(2);
});
