// The provider: pi's streamSimple, served by a Claude Code subprocess.
//
// Push-based streaming with an MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Steps 2 and 3 are stream-events.js. This module owns the queries: which
// QueryContext a call belongs to, what session it resumes, and what happens when
// one ends.

import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { deleteSession } from "cc-session-io";
import { CLAUDE_MD_EXCLUDES, REASONING_TO_EFFORT, childEnv } from "./cc-child.js";
import { claudeCodeSettings } from "./config.js";
import { debug, diagDump, makeCliDebugOptions } from "./debug.js";
import { errorMessage } from "./errors.js";
import type { McpResult } from "./extract-tool-results.js";
import { createToolServer } from "./mcp-server.js";
import { claudeCodeModelId } from "./models.js";
import { newAssistantMessageEventStream } from "./pi-ai-compat.js";
import { extensionNote, labelUserTurn, messageOrigins, splitUserTurn } from "./message-origin.js";
import { adaptContext, extractAllToolResults, extractUserPrompt, extractUserPromptBlocks, historyIdentities, historyRewritten, steerBlocks, turnStart } from "./pi-context.js";
import { projectPromptCapture } from "./prompt-capture.js";
import { promptCaptures } from "./prompt-record.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { QueryContext, ctx } from "./query-state.js";
import { getAskClaudeToolName, getLongContextSettings, getPiSessionId, getProviderSettings } from "./runtime-config.js";
import { adoptSession, clearSharedSession, getDeliveredToolResultCursor, getSharedSession, markNeedsRebuild, orphanedToolResultAction, recordToolResultDelivery, setCursor } from "./session-store.js";
import { buildSideRequestSession, ownsSharedSession, syncSharedSession, type SyncResult } from "./session-sync.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { showStartupNoticeOnce } from "./startup-notice.js";
import { claimCurrentPiStream, consumeQuery, deliverToolResults, drainForAbort, finalizeCurrentStream, markStreamComplete } from "./stream-events.js";

// Global (not query state):
const activeQueryContexts = new Set<QueryContext>();

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
export function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}


/** Opens a query that resumes a session ending at a tool result (a handover or an
 *  orphan resume). Sent through the prompt stream like any turn's prompt, and
 *  labelled so the model does not read it as the user's (issue #23). */
const CONTINUATION_PROMPT = extensionNote(
	"The previous query stopped after a tool result. Continue the current task from the tool results above.",
);

/** Ends `c`'s live query when pi's history lost messages that query had already
 *  been handed, so the turn goes on in a fresh query resumed from a session rebuilt
 *  out of pi's history (issue #21). Returns whether it did.
 *
 *  An extension compacting through the `context` hook (ACP) shortens pi's history
 *  between two tool calls. Delivering the results into the live query would keep
 *  Claude Code on the old, longer history until the turn ends — for a long agentic
 *  turn, every later request of it. */
function retireIfHistoryRewritten(c: QueryContext, messages: Context["messages"]): boolean {
	if (!c.retire || !historyRewritten(c.seenHistory, messages)) return false;
	debug(`provider: pi's history lost messages the live query had been handed, handing the turn to a rebuilt session, ctx.msgs=${messages.length}`);
	c.retire();
	// As good as delivered: a retry of this same context must resume the turn, not end it.
	recordToolResultDelivery(messages.length);
	return true;
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
export function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

/**
 * Provider entry for callers that obtained our streamSimple handle from pi's
 * model runtime (ctx.modelRegistry.getRegisteredProviderConfig) — e.g. a
 * permission reviewer or judge extension. A single-user-message context whose
 * system prompt was never captured from pi's own assembly is not a
 * conversation turn; serve it as a side request instead of letting the main
 * lane fail on prompt-capture resolution.
 */
export function streamProviderEntry(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	context = adaptContext(context);
	const lastRole = context.messages[context.messages.length - 1]?.role;
	if (!!context.systemPrompt && context.messages.length === 1 && lastRole === "user") {
		// Use the same discriminator the main lane lives by: a conversation turn's
		// prompt resolves (or derives) against pi's captured assembly; a foreign
		// one-shot prompt — a judge or summarizer's own rubric — does not.
		try {
			promptCaptures.resolveOrDerive(context.systemPrompt);
		} catch {
			debug(`provider: single-message context with unresolvable ${context.systemPrompt.length}-char system prompt -> side request`);
			return streamSideRequest(model, context, options);
		}
	}
	return streamClaudeAgentSdk(model, context, options);
}

/**
 * A request that is not part of pi's conversation.
 *
 * Extensions that drive their own `agentLoop` get pi-ai's default stream
 * function, which resolves the api id in pi-ai's own registry rather than in
 * pi's model runtime — so such a call never reaches the provider registered
 * with `pi.registerProvider`. An unresolved api id there does not merely fail
 * the call: `agentLoop` starts the run with `void runAgentLoop(...).then(...)`
 * and no `catch`, so the rejection escapes as an unhandled one and takes pi's
 * process down.
 *
 * Such a request carries its own system prompt, its own tools and a
 * conversation of its own that pi never recorded, so it is served as a
 * self-contained Claude Code session: no prompt capture, no shared session, and
 * the session it captures is deleted when it ends.
 */
export function streamSideRequest(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	try {
		return streamClaudeAgentSdk(model, context, options, true);
	} catch (err) {
		// Setup failures are reported on the stream rather than thrown, because a throw
		// reaches a caller that cannot handle one: `agentLoop` awaits the stream inside
		// a promise it never catches. An `error` event resolves `result()` with a failed
		// message instead, which the loop ends the turn on.
		debug("side request: setup failed", err);
		const stream = newAssistantMessageEventStream();
		const failed = new QueryContext();
		failed.resetTurnState(model);
		failed.turnOutput!.stopReason = "error";
		failed.turnOutput!.errorMessage = errorMessage(err);
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error: failed.turnOutput! });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}
}

/** The one place a Claude Code query is started. Pi calls in for each new prompt
 *  and each tool result; three cases follow: tool result delivery into a live
 *  query, an orphaned tool result with no query to take it, or a fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions, side = false): AssistantMessageEventStream {
	context = adaptContext(context);
	if (!side) showStartupNoticeOnce();
	const stream = newAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, side=${side}, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// Only pi's own conversation mirrors pi's history; a reentrant query's is its caller's.
	const handover = resultCtx === ctx() && retireIfHistoryRewritten(resultCtx, context.messages);

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx && !handover) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result. Only what the
		// user sent goes in as a steer, which CC presents as the user's words; an
		// extension's message rides on the tool result instead, labelled (see
		// message-origin.ts). A side request's messages never passed through pi's
		// message events, so they keep the plain steer.
		const turn = lastMsgRole !== "user" ? undefined
			: side ? { fromUser: context.messages, notes: [] }
			: splitUserTurn(context.messages, messageOrigins);
		const steer = turn && turn.fromUser.length > 0 ? steerBlocks(turn.fromUser) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length, turn?.notes ?? []);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (resultCtx === ctx()) setCursor(context.messages.length, historyIdentities(context.messages));
		// Same top-level-only reasoning as the cursor above: a subagent's message
		// count must not decide what the parent's next call means.
		if (resultCtx === ctx()) recordToolResultDelivery(context.messages.length);
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		resultCtx.seenHistory = historyIdentities(context.messages);
		return stream;
	}

	// --- Tool result with no live query ---
	// Either pi aborted a tool call and delivered the result anyway (end the turn),
	// or pi is retrying a turn whose query we killed (resume it). See
	// orphanedToolResultAction.
	const lastMsg = context.messages[context.messages.length - 1];
	const orphanAction = !handover && lastMsg?.role === "toolResult"
		? orphanedToolResultAction(context.messages.length, getDeliveredToolResultCursor())
		: null;
	if (orphanAction === "resume") {
		debug(`provider: re-issued tool-result continuation (cursor=${getDeliveredToolResultCursor()}), resuming as fresh query`);
	}
	if (orphanAction === "end-turn") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (activeQueryContexts.size === 0) setCursor(context.messages.length, historyIdentities(context.messages));
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Only pi's own conversation takes the top-level
	//    QueryContext and the shared session (ownsSharedSession). Everything else is
	//    reentrant: it gets a QueryContext of its own, so background subagents run
	//    concurrently with the parent query, and a throwaway session holding its own
	//    history. A side request is always its own: it runs alongside pi's
	//    conversation, so taking the shared context would strand whatever that
	//    context is mid-turn.
	const callSessionId = options?.sessionId;
	// Read again rather than reusing `activeQuery`: a handover has retired the query
	// that was live on entry, and pi's turn is what takes the shared context next.
	const liveQuery = ctx().activeQuery !== null;
	const isReentrant = !ownsSharedSession({ side, activeQuery: liveQuery, sessionId: callSessionId }, getPiSessionId());
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeQuery=${liveQuery}, handover=${handover}, callSession=${callSessionId?.slice(0, 8) ?? "none"}, piSession=${getPiSessionId()?.slice(0, 8) ?? "none"}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt throws, and doing that before
	// anything is claimed or reset leaves no half-built query behind — in particular
	// no stream claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, getAskClaudeToolName());
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	//
	// A side request is exempt: its prompt is its own, assembled by whichever
	// extension is calling and never seen by `before_agent_start`, so there is
	// nothing to resolve it to and nothing of pi's to forward. It is sent to Claude
	// Code verbatim instead.
	const promptCapture = side ? undefined : promptCaptures.resolveOrDerive(context.systemPrompt);
	const systemPromptAppend = promptCapture
		? projectPromptCapture(promptCapture, {
			skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
		})
		: undefined;

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;
	queryCtx.seenHistory = historyIdentities(context.messages);

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, getLongContextSettings());
	// A reentrant query neither reads the shared session nor adopts one: its history
	// is not pi's, so resuming pi's session would prepend a conversation the caller
	// never sent, and rewriting it would take the parent's session away mid-turn.
	// `preserveSharedSession` is what makes the completion handler treat the session
	// Claude Code creates for it as ephemeral and delete it.
	const ownPriorMessages = isReentrant ? context.messages.slice(0, turnStart(context.messages)) : [];
	const syncResult: SyncResult = isReentrant
		? {
			sessionId: ownPriorMessages.length > 0
				? buildSideRequestSession(ownPriorMessages, cwd, customToolNameToSdk, cliModel)
				: null,
			preserveSharedSession: true,
		}
		: syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel);
	const { sessionId: resumeSessionId } = syncResult;
	// Labels what the user did not send (message-origin.ts). History above went to
	// syncSharedSession unchanged; a side request's prompt is its caller's own.
	const promptMessages = side ? context.messages : labelUserTurn(context.messages, messageOrigins);
	const promptBlocks = extractUserPromptBlocks(promptMessages);
	let promptText = extractUserPrompt(promptMessages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		// A resumed continuation or a handover has no user turn by construction, so it
		// opens with a continuation prompt below without being an anomaly worth dumping.
		if (orphanAction !== "resume" && !handover) diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: (() => { const s = getSharedSession(); return s ? { sessionId: s.sessionId.slice(0, 8), cursor: s.cursor } : null; })(),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Resuming a tool result opens with CONTINUATION_PROMPT below; only a genuine
		// orphan with no prior delivery needs the fallback.
		if (orphanAction !== "resume" && !handover) promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	//
	// A resumed tool result opens the same way, with CONTINUATION_PROMPT. Not with
	// CLAUDE_CODE_RESUME_INTERRUPTED_TURN: Claude Code re-runs the interrupted turn
	// during startup, before the SDK has registered our in-process MCP server, so
	// that request carries no tools and the model can only end the turn (issue #23).
	const resumeToolResult = handover || orphanAction === "resume";
	const openingBlocks = resumeToolResult
		? [{ type: "text" as const, text: CONTINUATION_PROMPT }]
		: promptBlocks ?? [{ type: "text" as const, text: promptText }];
	void promptStream.push(userMessage(openingBlocks))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = getProviderSettings().strictMcpConfig !== false;
	const claudeExecutable = getProviderSettings().pathToClaudeCodeExecutable;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv(process.env, getPiSessionId()),
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		// AskClaude keeps CC's native tools and its guidance — unaffected.
		settings: {
			...claudeCodeSettings(getProviderSettings()),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
		},
		// A side request's prompt replaces Claude Code's preset rather than appending to
		// it: the caller wrote a complete prompt for a single narrow job, and the coding
		// agent preset would talk it into being a coding agent.
		systemPrompt: side
			? context.systemPrompt
			: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
			},
		extraArgs,
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions(side ? "side-request" : "provider"),
	};

	debug(side ? "provider: fresh side request" : "provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// A handover (retireIfHistoryRewritten) ends this query while pi's turn goes on in
	// a fresh one on the same context. From then on nothing below may touch that
	// context, its stream or the shared session: they belong to the fresh query.
	let superseded = false;
	const retire = () => {
		superseded = true;
		options?.signal?.removeEventListener("abort", onAbort);
		drainForAbort(queryCtx, promptStream);
		requestAbort();
		queryCtx.retire = null;
		if (queryCtx.activeQuery === sdkQuery) queryCtx.activeQuery = null;
		if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
		activeQueryContexts.delete(queryCtx);
		// As after an abort, the killed subprocess may still flush records into the
		// session it resumed, so the rebuild takes a fresh id rather than that file.
		markNeedsRebuild({ forceRotate: true });
	};
	if (!isReentrant) queryCtx.retire = retire;

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted || superseded, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}, superseded=${superseded}`);
			if (superseded) return;

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				// A reentrant query runs in its own Claude Code session, so aborting it says
				// nothing about whether pi's session still matches pi's history.
				if (!isReentrant) markNeedsRebuild({ forceRotate: true });
				debug(`provider: abort detected, sharedSession needsRebuild + forceRotate=${!isReentrant}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? getSharedSession()?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== getSharedSession()?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, getSharedSession()?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				adoptSession(sessionId, cursor, cwd, queryCtx.seenHistory);
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, superseded=${superseded}, error=`, error);
			if (superseded) return;
			// Not for a reentrant query: it owns no part of the shared session, and
			// discarding pi's on its behalf would cost the next real turn a full rebuild
			// over a failure that had nothing to do with it.
			if (!isReentrant) {
				if ((wasAborted || options?.signal?.aborted) && getSharedSession()) {
					markNeedsRebuild({ forceRotate: true });
				} else {
					clearSharedSession();
				}
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= errorMessage(error);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			// The session built for a reentrant query is scoped to that query, however it
			// ended. When Claude Code kept the id we resumed, the completion handler above
			// has already deleted it and this is a no-op.
			if (isReentrant && syncResult.sessionId) deleteSession(syncResult.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			if (queryCtx.retire === retire) queryCtx.retire = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			// A retired query let go of all of this in retire(), and the context now
			// belongs to the query that replaced it.
			if (!superseded && (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null)) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}
