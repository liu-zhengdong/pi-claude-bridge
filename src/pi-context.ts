// 从 pi 的 Context 里取东西：当前用户轮次、工具结果、提示块。
//
// 全是对入参的纯读取，没有模块状态，只写调试日志。
//
// turnStart 是历史与提示的唯一切分点：它之前的消息作为会话历史重放，
// 从它开始的成为提示。两半由同一个下标推出，所以一条消息不会同时落在两边。

import * as piAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { messageContentToText } from "./convert.js";
import { extractAllToolResults as extractAllToolResultsRaw, type McpResult } from "./extract-tool-results.js";
import { debug } from "./debug.js";

export function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = extractAllToolResultsRaw(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
export function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Stable, ordered message identities. No body hashing: trimming a tool output or
 *  removing thinking doesn't change the conversation's identity. Tool-call IDs
 *  are included so removing a call from an otherwise unchanged assistant is visible.
 *  The current user turn is excluded by the caller until it has been delivered. */
export function historyIdentities(messages: Context["messages"]): string[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			return `assistant:${message.timestamp}:${message.content.filter((b) => b.type === "toolCall").map((b) => b.id).join(",")}`;
		}
		if (message.role === "toolResult") return `result:${message.toolCallId}:${message.timestamp}`;
		return `${message.role}:${message.timestamp}`;
	});
}

/** A Claude Code session can be reused only if everything already handed to it
 *  is still an ordered prefix of pi's history. Additions at the end are allowed. */
export function historyMatches(seen: readonly string[], current: readonly string[]): boolean {
	return seen.length <= current.length && seen.every((key, i) => key === current[i]);
}

export function historyRewritten(seen: readonly string[], messages: Context["messages"]): boolean {
	return !historyMatches(seen, historyIdentities(messages));
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
export function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
export function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

export function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

export function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

// pi 0.86.0 changed provider stream inputs from `Context` (carrying `systemPrompt`
// and `tools` fields) to a normalized `TranscriptContext` whose prompt and tool
// declarations are folded into a leading system message inside `messages`. This
// bridge reads `context.systemPrompt` / `context.tools` and treats `messages` as
// pure conversation, so reconstruct the old shape once at each provider entry.
// It prefers explicit fields when present (a no-op on pre-0.86 inputs) and is
// idempotent, so re-adapting an already-adapted context is harmless.
export function adaptContext(context: Context): Context {
	const messages = context.messages ?? [];
	const derivedSystemPrompt = typeof piAi.getCurrentSystemPrompt === "function" ? piAi.getCurrentSystemPrompt(messages) : undefined;
	const derivedTools = typeof piAi.getCurrentTools === "function" ? piAi.getCurrentTools(messages) : undefined;
	return {
		systemPrompt: context.systemPrompt ?? (derivedSystemPrompt || undefined),
		tools: context.tools ?? derivedTools,
		messages: messages.filter((message) => message.role !== "system"),
	};
}
