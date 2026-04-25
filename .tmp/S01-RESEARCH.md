---
title: "S01 Research — GitLab Duo Provider"
status: complete
milestone: "M001-g2fmhu"
slice: "S01"
updated: "2026-04-25"
---

# S01 Research — GitLab Duo Provider

## Goal

Establish the minimum viable path for a tracer-bullet GitLab Duo provider that appears as a selectable provider in GSD and can stream real completions from GitLab-backed infrastructure, while identifying what must be deferred to S03.

## Executive Summary

The cleanest S01 path is to implement `src/resources/extensions/gitlab-duo/` as a first-class extension that calls `pi.registerProvider("gitlab-duo", ...)` and initially targets the existing `openai-responses` integration seam **if and only if** the live GitLab endpoint proves compatible enough in a runtime probe. The repo already supports this provider-registration pattern cleanly, and local docs explicitly reference a `custom-provider-gitlab-duo/` example as “GitLab Duo via proxy”.

The main research conclusion is that GitLab’s public documentation is clearer about **OAuth**, **AI Gateway architecture**, **self-hosted model routing**, and **model selection policy** than it is about a stable, public, end-user **agentic chat API contract** for direct third-party use on gitlab.com. That means S01 should be framed as a tracer bullet around a real authenticated streaming path, with a narrow starter model catalog and explicit fallback to a custom `streamSimple` adapter if OpenAI compatibility is incomplete. Full catalog depth and capability completeness belong in S03.

## Repo Findings

### Provider registration seam already exists and is the right fit

Relevant repo evidence:

- `docs/dev/extending-pi/17-model-provider-management.md`
- `src/resources/extensions/ollama/index.ts`
- `src/resources/extensions/claude-code-cli/index.ts`
- `packages/pi-ai/src/providers/register-builtins.ts`
- `packages/pi-ai/src/providers/provider-capabilities.ts`

What this means:

- GSD/Pi supports runtime provider registration through `pi.registerProvider(name, config)`.
- A provider can either:
  - reuse an existing transport family by setting `api: "openai-responses"`, `api: "anthropic-messages"`, etc., or
  - supply its own `streamSimple` / `stream` implementation.
- For a tracer bullet, the lowest-risk route is to reuse an existing API family if GitLab’s wire format is close enough.

Concrete examples in-repo:

- `src/resources/extensions/ollama/index.ts` registers a provider dynamically and supplies `streamSimple`.
- `src/resources/extensions/claude-code-cli/index.ts` registers a provider backed by an external runtime.
- `packages/pi-ai/src/providers/register-builtins.ts` shows that `openai-responses` is already a first-class streaming transport with tool support.

### The codebase already hints at a GitLab Duo provider example

Relevant repo evidence:

- `docs/dev/extending-pi/24-file-reference-example-extensions.md`

The doc lists:

- `custom-provider-gitlab-duo/` — “GitLab Duo via proxy”

Implication:

- The intended architectural shape is already validated in the Pi docs ecosystem.
- Even though the example source is not in this repo, it is strong evidence that “GitLab Duo provider as extension” is the correct seam.
- “Via proxy” is a warning sign: the stable/public API shape may not be identical to GitLab’s internal product-facing routes.

### Capability handling does not block a thin S01 implementation

Relevant repo evidence:

- `packages/pi-ai/src/providers/provider-capabilities.ts`

Important observations:

- Capabilities are keyed by **API family** (`openai-responses`, `anthropic-messages`, etc.), not by provider ID.
- If `gitlab-duo` uses `api: "openai-responses"`, it inherits the existing `openai-responses` capabilities automatically.
- If S01 must use a custom transport, it can still work without adding a new capability profile immediately because unknown APIs fall back to a permissive default profile.

Recommendation:

- Prefer `api: "openai-responses"` in S01 if runtime verification confirms compatibility.
- Only introduce a new API family if the GitLab stream/event shape materially diverges.

### Onboarding/key-management changes are straightforward

Relevant repo evidence:

- `src/resources/extensions/gsd/key-manager.ts`
- `src/web/onboarding-service.ts`

Implication:

- Adding GitLab Duo as a visible provider in onboarding and `/gsd keys` is mechanically straightforward.
- S01 can likely add a `gitlab-duo` provider entry with env-var-based credentials (`GITLAB_TOKEN`) even before richer OAuth login UX exists.

## GitLab Documentation Findings

## 1) OAuth support is solid and standards-based

Source:

- https://docs.gitlab.com/api/oauth2/

Confirmed from docs:

- GitLab supports:
  - Authorization Code + PKCE
  - Authorization Code
  - Device Authorization Grant (GitLab 17.1+)
- OAuth token endpoint is `/oauth/token`
- Authorization endpoint is `/oauth/authorize`
- Refresh tokens are supported

Planner implication:

- A proper OAuth-backed provider is feasible.
- For S01, env-var token auth is enough for the tracer bullet, but the longer-term auth path can align with GitLab OAuth device flow or auth-code-with-PKCE.
- Self-hosted GitLab support is feasible because the OAuth surface is documented for both GitLab.com and Self-Managed.

## 2) GitLab Duo architecture is AI Gateway–centric

Sources:

- https://docs.gitlab.com/administration/gitlab_duo_self_hosted/
- Google-grounded search results pointing to GitLab AI Gateway and `/v1/chat/agent`

Confirmed / strongly indicated:

- GitLab Duo routes AI features through an AI Gateway.
- Self-hosted deployments can point GitLab at a self-hosted AI Gateway.
- GitLab-managed models and self-hosted models are both supported, depending on deployment mode.
- GitLab documentation and search-grounded summaries indicate an AI Gateway endpoint shape involving `/v1/chat/agent` for agentic chat/self-managed flows.

Planner implication:

- The actual inference surface may be AI Gateway-oriented rather than a clean public “OpenAI-compatible public API” product surface.
- S01 should be treated as a live-API probe slice, not as a guaranteed drop-in OpenAI endpoint integration.

## 3) Public docs do NOT clearly expose a stable public “GitLab Duo chat completions API” for gitlab.com third-party clients

Sources:

- Google-grounded search on GitLab Duo agentic endpoint compatibility
- Fetch attempts on GitLab Duo user docs were partially blocked by Cloudflare/CAPTCHA

What appears true:

- There is documentation for GitLab Duo Chat completions / agentic flows in product context.
- For gitlab.com, publicly consumable third-party API contract details are not clearly documented in the same way OpenAI/Anthropic APIs are.
- Search-grounded results suggest some endpoints are internal-use or self-managed-feature-flagged rather than a clearly published public contract.

Planner implication:

- S01 must verify the live path empirically before committing to `api: "openai-responses"`.
- The planner should expect one of these outcomes:
  1. GitLab endpoint is OpenAI-compatible enough → reuse `openai-responses`
  2. GitLab endpoint is close but not identical → custom adapter over existing request/stream helpers
  3. GitLab endpoint is not suitable for direct third-party client use → tracer bullet may need a proxy pattern like the Pi example mentions

## 4) Model selection is documented, but model catalog details are not presented as a clean API contract

Source:

- https://docs.gitlab.com/administration/gitlab_duo/model_selection/

Confirmed:

- Every GitLab Duo feature has a default LLM chosen by GitLab.
- GitLab can change default models over time.
- Administrators can choose from supported models for specific features.

Search-grounded summaries additionally indicate:

- Agent Platform defaults may include Claude Sonnet 4.6 Vertex for agentic chat / code review flow and Claude Sonnet 4.5 Vertex for other agents.
- GPT-family models are supported in some GitLab-managed or self-hosted contexts.

What is **not** cleanly documented in fetched docs:

- A machine-readable public model list for direct client integration
- Stable model IDs for a third-party provider implementation
- Context windows, max output tokens, or cost metadata suitable for GSD model catalog entries

Planner implication:

- S01 should use a **small hardcoded starter model catalog** sufficient to prove the provider path.
- S03 should expand to a richer catalog once real model IDs and metadata are confirmed by live probing or better source docs.

## 5) Scope story is split between general OAuth, AI features, and Duo workflows

Sources:

- https://docs.gitlab.com/api/oauth2/
- Google-grounded search results on `ai_features` and `ai_workflows`

Strong indications from current docs/search:

- `ai_features` exists as a GitLab scope associated with Duo-related endpoints.
- `ai_workflows` exists as an OAuth scope intended for Duo/Software Development Flow style workflows.
- PAT-based external agent setups may additionally require broader scopes like `api` and `write_repository` for repo-modifying workflows.

Important distinction:

- Those broader scopes are relevant for sync/external-agent automation workstreams.
- They may be **more than S01 needs** if S01 is only doing inference.

Planner implication:

- For the provider tracer bullet, research supports a **minimal-scope bias**, but exact minimum inference-only scopes remain unconfirmed from first-party docs fetched in this session.
- The planner should record this explicitly as an unresolved validation item:
  - verify the minimum scope needed for live Duo inference on gitlab.com
  - avoid assuming `api` is required unless runtime auth proves it

## 6) Self-hosted base URL configurability is required

Sources:

- https://docs.gitlab.com/api/oauth2/
- https://docs.gitlab.com/administration/gitlab_duo_self_hosted/

Confirmed:

- GitLab OAuth and Duo surfaces exist for GitLab.com, Self-Managed, and Dedicated.
- Self-hosted AI Gateway is a first-class deployment mode.

Planner implication:

- Do **not** hardcode gitlab.com in provider design.
- Provider config should allow a base GitLab URL / base API URL override, likely defaulting to `https://gitlab.com` or its GitLab-managed AI surface, with explicit support for self-hosted instances in S03 if not fully proven in S01.

## 7) Rate limiting requires backoff discipline, but exact GitLab.com limits vary by endpoint

Sources:

- https://docs.gitlab.com/security/rate_limits/
- Google-grounded search on GitLab.com API rate limits

Confirmed:

- GitLab has broad rate limiting across APIs.
- `429` is expected when limits are exceeded.
- Exponential backoff is the documented mitigation pattern.
- Many limits differ by endpoint and deployment type.

Planner implication:

- S01 should include at least basic handling for `429` and surfaced error messages.
- S04/S05 can reuse the same backoff posture for gitlab-sync.
- There is no evidence that provider work needs a custom rate-limit subsystem beyond existing resilient streaming error handling plus minimal retry/backoff.

## Recommended S01 Scope

The tracer bullet should prove these things only:

1. `gitlab-duo` is registered as a provider via extension startup.
2. A user can select a GitLab Duo model in GSD.
3. Authentication is sourced from `${GITLAB_TOKEN}` (env only; no plaintext secret persistence).
4. A real streaming completion succeeds against GitLab-backed infrastructure.
5. Failure surfaces are explicit enough to debug auth/base-URL/protocol mismatches.

Everything else should be deferred unless it is mechanically cheap:

- Large/full model catalog → defer to S03
- Rich OAuth login UX → defer
- Full provider capability tuning → defer unless transport family is custom
- Self-hosted AI Gateway matrix completeness → defer
- Cost accuracy / context-window accuracy → defer unless source becomes authoritative

## Recommended Implementation Shape

### Extension location

- `src/resources/extensions/gitlab-duo/`

### Files likely needed

- `index.ts` — register provider on session start / extension load
- `models.ts` — thin starter catalog
- `readiness.ts` or equivalent — validate env/base URL/token presence
- `stream-adapter.ts` — either:
  - trivial provider wrapper using `api: "openai-responses"`, or
  - custom `streamSimple` implementation if GitLab stream shape diverges

### Initial provider registration shape

Preferred if live endpoint is compatible:

```ts
pi.registerProvider("gitlab-duo", {
  authMode: "apiKey",
  apiKey: process.env.GITLAB_TOKEN ?? "",
  baseUrl: resolvedBaseUrl,
  api: "openai-responses",
  models: GITLAB_DUO_STARTER_MODELS,
});
```

Fallback if not compatible enough:

```ts
pi.registerProvider("gitlab-duo", {
  authMode: "apiKey",
  apiKey: process.env.GITLAB_TOKEN ?? "",
  baseUrl: resolvedBaseUrl,
  api: "openai-responses", // only if request/response shape is still close enough
  streamSimple: streamViaGitLabDuo,
  isReady: isGitLabDuoReady,
  models: GITLAB_DUO_STARTER_MODELS,
});
```

If the API family truly differs, introduce a custom API name only after confirming reuse is not practical.

## Suggested Starter Model Catalog for S01

Because current fetched docs do not provide a stable public catalog contract, S01 should use a deliberately thin hardcoded list, for example:

- one default agentic chat model entry
- optionally one secondary Claude-family entry if runtime testing confirms it

Catalog requirements for S01:

- IDs must match what the live endpoint actually accepts
- `reasoning` should be conservative (false unless proven)
- `input` should likely start with `["text"]`
- costs can be zero/unknown for tracer bullet if the codebase tolerates it
- context windows should be conservative placeholders only if required structurally

Avoid inventing a large catalog from admin UI docs.

## Unknowns Still Requiring Runtime Validation

These are the planner’s real retirement targets for S01:

1. **Exact endpoint and base URL for gitlab.com inference**
   - Public docs did not yield a clean end-user API endpoint contract.
   - Need live validation.

2. **Auth header format**
   - Likely Bearer token, but this should be verified against the actual endpoint/proxy path.

3. **Protocol compatibility with `openai-responses`**
   - Need to confirm request shape, stream event format, and error envelope.

4. **Minimum inference-only scope**
   - `ai_features` / `ai_workflows` are documented or search-grounded, but exact minimum for this direct provider path remains unclear.

5. **Stable model IDs**
   - Admin docs describe model selection conceptually, not as a client model registry.

## Risks

### High risk: GitLab public API shape may not be directly consumable

Why it matters:

- The provider may need a proxy or custom adapter, not just a thin registration.

Mitigation:

- Keep S01 tracer-bullet sized.
- Test compatibility before writing lots of integration code.
- Use the “via proxy” example path as a design clue if direct compatibility fails.

### Medium risk: scope confusion between inference and workflow automation

Why it matters:

- Over-requesting scopes violates the project goal of minimal privilege.
- Under-requesting scopes causes opaque failures.

Mitigation:

- Separate S01 inference scopes from S02/S04 sync scopes in docs and code.
- Surface auth errors with enough detail to distinguish invalid scope from invalid token.

### Medium risk: model catalog drift

Why it matters:

- GitLab explicitly states default models can change.

Mitigation:

- Hardcode only a minimal starter catalog in S01.
- Treat S03 as the model-catalog hardening slice.

## Planner Guidance

Use S01 to answer one binary question quickly:

**Can GSD stream a real completion through a GitLab Duo-backed provider without introducing a new transport family?**

Recommended execution order:

1. Find or infer the live GitLab-backed endpoint/base URL from current product docs/examples/runtime clues.
2. Probe compatibility with an `openai-responses`-style request.
3. If the probe succeeds, implement the provider as a thin extension with starter models.
4. If the probe partially succeeds, add a custom stream adapter but keep the rest thin.
5. If the probe fails because the API is not publicly consumable, pivot early to the documented “via proxy” pattern instead of forcing direct integration.

## Concrete File/Code Touch Recommendations for S01 Planning

Likely touched:

- `src/resources/extensions/gitlab-duo/index.ts`
- `src/resources/extensions/gitlab-duo/models.ts`
- `src/resources/extensions/gitlab-duo/stream-adapter.ts` (if needed)
- `src/resources/extensions/gsd/key-manager.ts`
- `src/web/onboarding-service.ts`
- extension registration surface wherever built-in extensions are loaded

Likely verification:

- provider visible in model selection / onboarding
- env var detection for `GITLAB_TOKEN`
- one live streaming completion against real GitLab-backed infra
- explicit failure test for missing token / invalid token

## Sources

### Repo sources

- `docs/dev/extending-pi/17-model-provider-management.md`
- `docs/dev/extending-pi/24-file-reference-example-extensions.md`
- `src/resources/extensions/ollama/index.ts`
- `src/resources/extensions/claude-code-cli/index.ts`
- `src/resources/extensions/gsd/key-manager.ts`
- `src/web/onboarding-service.ts`
- `packages/pi-ai/src/providers/provider-capabilities.ts`
- `packages/pi-ai/src/providers/register-builtins.ts`
- `packages/pi-ai/src/providers/openai-responses.ts`
- `packages/pi-ai/src/providers/openai-responses-shared.ts`
- `src/resources/extensions/github-sync/index.ts`
- `src/resources/extensions/github-sync/mapping.ts`
- `src/resources/extensions/github-sync/sync.ts`

### External sources

- GitLab OAuth 2.0 identity provider API: https://docs.gitlab.com/api/oauth2/
- GitLab Duo Self-Hosted / AI Gateway architecture: https://docs.gitlab.com/administration/gitlab_duo_self_hosted/
- GitLab Duo model selection: https://docs.gitlab.com/administration/gitlab_duo/model_selection/
- GitLab rate limits: https://docs.gitlab.com/security/rate_limits/

### Search-grounded supporting sources

Used where direct docs were ambiguous or Cloudflare-blocked:

- Google search summaries on GitLab Duo agentic endpoint, `ai_features`, `ai_workflows`, and GitLab.com rate limiting.

## Bottom Line

S01 is viable, but only if planned as a **real compatibility probe plus minimal provider registration**, not as a complete GitLab provider productization. The repo is ready for this extension shape. The main uncertainty is GitLab’s public inference contract, not GSD’s provider architecture.
