/**
 * Stream adapter for the GitLab Duo provider.
 *
 * Wraps the shared openai-responses transport seam so GitLab Duo's
 * OpenAI-compatible endpoint is used without duplicating the streaming logic.
 *
 * The adapter sets:
 *  - baseUrl: the resolved AI proxy URL
 *  - apiKey:  the GITLAB_TOKEN value (Bearer auth)
 *
 * If the live probe exposes wire-format differences from the
 * OpenAI Responses API, this file is the injection point for a task-local
 * adapter without redesigning the rest of the extension.
 */

import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import { streamSimpleOpenAIResponses } from "@gsd/pi-ai";
import { getGitLabToken, resolveAiProxyBaseUrl } from "./readiness.js";

/**
 * Thin adapter: delegates to streamSimpleOpenAIResponses with the
 * GitLab Duo base URL and token pre-set.
 *
 * This function satisfies the streamSimple contract expected by
 * pi.registerProvider() without introducing any additional HTTP logic.
 */
export function streamViaGitLabDuo(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const baseUrl = resolveAiProxyBaseUrl();
	const apiKey = getGitLabToken() ?? "";

	// Merge GitLab Duo defaults into options, letting call-site overrides win
	return streamSimpleOpenAIResponses(model, context, {
		...options,
		baseUrl,
		apiKey,
	});
}
