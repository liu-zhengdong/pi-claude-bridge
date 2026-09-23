// The pump: one Claude Code query's SDK messages turned into pi stream events.
//
// Everything here works on a QueryContext handed in by the caller, so several
// queries (a subagent alongside its parent, a side request alongside the
// conversation) run through the same functions without seeing each other's
// turn state. provider.js owns the contexts; this module only drives them.

import { query, type SDKMessage, type SDKModelRefusalFallbackMessage, type SDKModelRefusalNoFallbackMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { appendFileSync } from "fs";
import { RECORD_STREAM_PATH, debug } from "./debug.js";
import { describeRateLimitFailure, resultErrorText } from "./errors.js";
import type { McpResult } from "./extract-tool-results.js";
import { mapStopReason, mapToolArgs, parsePartialJson, piToolNameFor, servedModelId } from "./mapping.js";
import { userMessage, type PromptStream } from "./prompt-stream.js";
import { QueryContext } from "./query-state.js";
import { getPiUI } from "./runtime-config.js";
import { getSharedSession, markNeedsRebuild } from "./session-store.js";
import { logServedContextWindow, setInlineUsageSnapshot, updateUsage } from "./usage.js";
import { publishProviderUsage, snapshotFromClaudeRateLimitInfo, type ProviderUsageEventV1 } from "./usage-bus.js";
import { notifyIfStandalone } from "./usage-warning-state.js";

// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

export function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

export function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	if (c.turnOutput.stopReason === "error") {
		stream!.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream!.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Takes the current API message's blocks back out of the pi turn.
 *
 *  Claude Code retries a refused API message on its fallback model, and a failed
 *  one as is, and deletes the partial from its own transcript. Left in pi's turn,
 *  the partial sits ahead of the reply in pi's history, and the next rebuild sends
 *  Claude Code content it deleted. A refused tool call is the worst case: ending
 *  the turn on it would have pi run a call Claude Code withdrew. */
function dropLeg(c: QueryContext, reason: "refused" | "unfinished"): void {
	const dropped = c.turnBlocks.splice(c.legStart);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnToolCallIds = c.turnToolCallIds.filter((id) => c.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === id));
	c.legOpen = false;
	c.legRefused = false;
	debug(`processStreamEvent: dropped a ${reason} API message, ${dropped.length} block(s): ${dropped.map((b: any) => b.type).join(",") || "none"}`);
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		// A new API message while the last one never reached message_stop: Claude Code
		// gave up on that one and is retrying.
		if (c.legOpen) dropLeg(c, c.legRefused ? "refused" : "unfinished");
		c.legStart = c.turnBlocks.length;
		c.legOpen = true;
		c.turnToolCallIds = [];
		const served = event.message?.model;
		if (typeof served === "string") c.turnOutput.model = servedModelId(served, model.id);
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		if (event.delta?.stop_reason === "refusal") {
			c.legRefused = true;
		} else {
			c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		}
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") c.legOpen = false;

	// A refused message is not the reply. What follows is Claude Code's retry on its
	// fallback model, or the failure result when it has none.
	if (event?.type === "message_stop" && c.legRefused) {
		dropLeg(c, "refused");
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	// Same reasoning as dropLeg: a refused message is retried, not the reply.
	if (assistantMsg.stop_reason === "refusal") {
		debug(`processAssistantMessage: skipping a refused API message, ${assistantMsg.content.length} block(s)`);
		return;
	}
	c.turnToolCallIds = [];
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
export async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.promptStream?.end();
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			const snapshot = snapshotFromClaudeRateLimitInfo(info);
			if (snapshot?.complete) setInlineUsageSnapshot(snapshot);
			if (info?.status === "allowed") {
				if (snapshot) publishProviderUsage({ version: 1, type: "snapshot", snapshot });
				continue;
			}
			if (info?.status !== "allowed_warning" && info?.status !== "rejected") continue;

			if (info.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
			}
			const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization)
				? Math.round(info.utilization * 100)
				: undefined;
			// resetsAt is Unix seconds, not milliseconds.
			const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
			const rateLimitType = info.rateLimitType ?? "unknown";
			const event: Exclude<ProviderUsageEventV1, { type: "snapshot" }> = {
				version: 1,
				type: info.status === "rejected" ? "hard-limit" : "soft-warning",
				provider: "claude",
				message:
					info.status === "rejected"
						? `Claude rate limited (${rateLimitType}) — resets at ${resetsAt}`
						: utilization === undefined
							? `Claude rate limit warning (${rateLimitType})`
							: `Claude rate limit warning: ${utilization}% used (${rateLimitType})`,
				...(snapshot ? { snapshot } : {}),
			};
			const listeners = publishProviderUsage(event);
			if (listeners === 0) notifyIfStandalone(event);
			continue;
		}
		// Arrives at the end of the turn, after the retry's own blocks — usually after
		// a tool call has already ended the pi stream — so it cannot share the gate
		// below either.
		if (message.type === "system" && isRefusalNotice(message)) {
			reportRefusal(message);
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
					// The failure itself was recorded above the guard, along with the served
					// context window. What is left here is the success path: push the result
					// text when no assistant message already delivered it.
					if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

type RefusalNotice = SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage;

function isRefusalNotice(message: SDKMessage): message is RefusalNotice {
	const subtype = (message as { subtype?: string }).subtype;
	return subtype === "model_refusal_fallback" || subtype === "model_refusal_no_fallback";
}

// Claude Code session ids already told about their fallback model.
const reportedFallbacks = new Set<string>();

/** Claude Code refused the model's reply. With a fallback model it retries on
 *  that one, for the rest of its session when `scope` is "session", and reports it
 *  here. The refused partial is already out of the pi turn (dropLeg), and each
 *  message records the model that served it; what is left is telling the user,
 *  whose model picker still shows the model they chose. Once per session: every
 *  later turn runs on the fallback too, and repeating it would say nothing new. */
function reportRefusal(notice: RefusalNotice): void {
	const category = notice.api_refusal_category ?? "unknown";
	if (notice.subtype === "model_refusal_no_fallback") {
		debug(`consumeQuery: model_refusal_no_fallback original=${notice.original_model} category=${category}`);
		return;
	}
	const scope = notice.scope ?? "session";
	debug(`consumeQuery: model_refusal_fallback ${notice.original_model} -> ${notice.fallback_model} scope=${scope} category=${category} retracted=${notice.retracted_message_uuids?.length ?? 0}`);
	if (scope !== "session" || reportedFallbacks.has(notice.session_id)) return;
	reportedFallbacks.add(notice.session_id);
	const original = notice.original_model.replace(/\[1m\]$/, "");
	getPiUI()?.notify(
		`Claude Code 的 safeguards 拦下了 ${original} 的回复（${category}），本会话已换成 ${notice.fallback_model}。新开会话（/new）可回到 ${original}。`,
		"warning",
	);
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
function steerMissedSession(text: string): void {
	if (!getSharedSession()) return;
	markNeedsRebuild();
	debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
export async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
	/** Labelled messages the user did not send. They ride on the last tool result,
	 *  where CC shows them as part of it rather than as something the user said. */
	notes: string[] = [],
): Promise<void> {
	if (notes.length > 0) {
		const note = { type: "text" as const, text: notes.join("\n\n") };
		const last = results[results.length - 1];
		if (last) results = [...results.slice(0, -1), { ...last, content: [...last.content, note] }];
		else steer = [...(steer ?? []), note];
	}
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		getPiUI()?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
export function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}
