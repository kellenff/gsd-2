import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAgentEvent } from "../modes/interactive/controllers/chat-controller.js";

function makeUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistant(content: any[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "claude-code",
		model: "claude-sonnet-4",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createHost() {
	const chatContainer = {
		children: [] as any[],
		addChild(component: any) {
			this.children.push(component);
		},
		removeChild(component: any) {
			const idx = this.children.indexOf(component);
			if (idx !== -1) this.children.splice(idx, 1);
		},
		clear() {
			this.children = [];
		},
	};

	const host: any = {
		isInitialized: true,
		init: async () => {},
		defaultEditor: { onEscape: undefined },
		editor: {},
		session: { retryAttempt: 0, abortCompaction: () => {}, abortRetry: () => {} },
		ui: { requestRender: () => {} },
		footer: { invalidate: () => {} },
		keybindings: {},
		statusContainer: { clear: () => {}, addChild: () => {} },
		chatContainer,
		settingsManager: { getTimestampFormat: () => "date-time-iso", getShowImages: () => false },
		pendingTools: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		isBashMode: false,
		defaultWorkingMessage: "Working...",
		compactionQueuedMessages: [],
		editorContainer: {},
		pendingMessagesContainer: { clear: () => {} },
		addMessageToChat: () => {},
		getMarkdownThemeWithSettings: () => ({}),
		formatWebSearchResult: () => "",
		getRegisteredToolDefinition: () => undefined,
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages: () => {},
		flushCompactionQueue: async () => {},
		showStatus: () => {},
		showError: () => {},
		updatePendingMessagesDisplay: () => {},
		updateTerminalTitle: () => {},
		updateEditorBorderColor: () => {},
	};

	return host;
}

test("chat-controller keeps tool output ahead of delayed assistant text for external tool streams", async () => {
	// ToolExecutionComponent uses the global theme singleton.
	// Install a minimal no-op theme implementation for this unit test.
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolId = "mcp-tool-1";
	const toolCall = {
		type: "toolCall",
		id: toolId,
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	assert.equal(host.streamingComponent, undefined, "assistant component should be deferred at message_start");
	assert.equal(host.chatContainer.children.length, 0, "nothing should render before content arrives");

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([toolCall]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "tool output" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([toolCall]),
			},
		} as any,
	);

	assert.equal(host.streamingComponent, undefined, "assistant text container should remain deferred for tool-only updates");
	assert.equal(host.chatContainer.children.length, 1, "tool execution block should render immediately");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");

	// Re-assert required host method before the text-bearing update path.
	host.getMarkdownThemeWithSettings = () => ({});

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([toolCall, { type: "text", text: "done" }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "done",
				partial: makeAssistant([toolCall, { type: "text", text: "done" }]),
			},
		} as any,
	);

	assert.equal(host.chatContainer.children.length, 2, "assistant content should render after existing tool output");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
});
