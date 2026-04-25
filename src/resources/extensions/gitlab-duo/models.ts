/**
 * Documented-first model catalog for the GitLab Duo provider.
 *
 * This catalog reflects what GitLab's public documentation confirms:
 * - GitLab Duo Agent Platform defaults to the Claude Sonnet 4 family.
 * - GitLab-managed Duo uses GitLab's AI Gateway, which proxies to
 *   OpenAI-compatible endpoints internally.
 * - Self-hosted GitLab Duo can expose OpenAI-compatible /v1 endpoints
 *   for compatible models.
 *
 * This catalog is NOT sourced from a documented public model-registry
 * endpoint.  The first-party docs at docs.gitlab.com/administration/gitlab_duo
 * describe a feature-level default model, not a stable external ID catalog.
 * Richer model facts (exact IDs, context windows, per-model reasoning
 * controls) are either deployment-dependent or runtime-validated rather
 * than guaranteed by public docs.
 *
 * The `reasoning` field here is descriptive only — it marks models that
 * GitLab Duo generally routes for reasoning-heavy tasks.  It does NOT
 * imply a request-time reasoning-control parameter is available via the
 * provider; GitLab's public docs do not currently document an equivalent
 * of Anthropic's effort/thinking request options.
 *
 * For model discovery beyond this catalog, see the live-probe path in
 * readiness.ts.  Runtime-discovered model facts should be treated as
 * empirical rather than documented.
 */

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Documented-first catalog.
 *
 * Sources:
 * - GitLab Duo Agent Platform page (docs.gitlab.com/user/duo_agent_platform/):
 *   lists Claude Sonnet 4 as the default LLM for the Agent Platform.
 * - GitLab Duo model selection page (docs.gitlab.com/administration/gitlab_duo/model_selection/):
 *   describes feature-level defaults chosen by GitLab, subject to change.
 * - GitLab self-hosted supported models page lists compatible families
 *   (Claude 4/4.5, GPT, Mistral, Llama) for self-hosted deployments.
 *
 * All other model entries are marked as "deployment-dependent" and are
 * included as conservative placeholders for common GitLab Duo topologies,
 * not as guaranteed public defaults.
 *
 * contextWindow and maxTokens are omitted for all entries because no
 * public GitLab doc currently provides stable, third-party-usable values
 * for the managed GitLab.com Duo endpoint.  Runtime probing or
 * documentation-driven updates are needed to populate those fields.
 */
export const GITLAB_DUO_MODELS = [
	{
		// Documented GitLab-managed default (per duo_agent_platform docs)
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4 (GitLab-managed default)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		// contextWindow / maxTokens omitted — not publicly documented for
		// the managed endpoint; must be runtime-validated or updated when
		// GitLab publishes a stable third-party model contract.
		contextWindow: undefined,
		maxTokens: undefined,
	},
	{
		// Deployment-dependent: self-hosted GitLab Duo can expose Claude Opus
		// via OpenAI-compatible endpoints (per self-hosted supported-models page).
		// Not a documented GitLab-managed default; included as a reasonable
		// self-hosted-compatible fallback.
		id: "claude-opus-4",
		name: "Claude Opus 4 (self-hosted / deployment-dependent)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: undefined,
		maxTokens: undefined,
	},
] as const;
