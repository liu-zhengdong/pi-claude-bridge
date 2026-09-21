import { StringEnum, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, compact, generateBranchSummary, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { deleteSession } from "cc-session-io";
import { PROVIDER_ID } from "./convert.js";
import { claudeCodeModelId } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, renderSkillsBlock } from "./skills.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { claudeCodeSettings, loadConfig, markStartupNoticeShown } from "./config.js";
import {
	collectPromptSkills,
	projectPromptCapture,
	PromptCaptures,
} from "./prompt-capture.js";
import { createToolServer } from "./mcp-server.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { beginStandaloneWarningSession, endStandaloneWarningSession } from "./usage-warning-state.js";
import { debug, diagDump, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { errorMessage, resultErrorText } from "./errors.js";
import { mapToolName } from "./mapping.js";
import { adoptSession, clearSharedSession, getDeliveredToolResultCursor, getSharedSession, markNeedsRebuild, orphanedToolResultAction, recordToolResultDelivery, setCursor, setSharedSession, type SessionState } from "./session-store.js";
import { adaptContext, extractAllToolResults, extractUserPrompt, extractUserPromptBlocks, steerBlocks, turnStart } from "./pi-context.js";
import { CC_CHILD_ENV, CLAUDE_MD_EXCLUDES, REASONING_TO_EFFORT, childEnv } from "./cc-child.js";
import {
	bindUsageAdapter,
	claimUsageAdapter,
	refreshClaudeUsage,
	releaseUsageAdapter,
	setUsageControlQueryForTest,
} from "./usage.js";
import {
	applyRuntimeConfig,
	getAskClaudeToolName,
	getLongContextSettings,
	getPiMode,
	getPiSessionId,
	getPiUI,
	getProviderSettings,
	resolveModel,
	setAskClaudeToolName,
	setPiMode,
	setPiSessionId,
	setPiUI,
} from "./runtime-config.js";
import { buildSideRequestSession, syncSharedSession, type SyncResult } from "./session-sync.js";
import { branchSummaryOutcome, isolatedStreamFn, reinjectPriorCompactionFileOps } from "./isolated-summary.js";
import { newAssistantMessageEventStream } from "./pi-ai-compat.js";
import { claimCurrentPiStream, consumeQuery, deliverToolResults, drainForAbort, finalizeCurrentStream, markStreamComplete } from "./stream-events.js";

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Extensions like pi-subagents spawn a subagent and it loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// Ours among pi-ai's api-provider registrations, so shutdown removes only the one
// this module instance made. Per instance, not per package: a subagent instance
// that skipped registration must not be able to unregister the parent's.
const API_PROVIDER_SOURCE_ID = `claude-bridge:${moduleInstanceId}`;
let registeredApiProvider = false;

// --- Error handling ---

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no pi TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
	],
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// @internal
export const __test = {
	resetSharedSession() {
		clearSharedSession();
	},
	setSharedSession(state: SessionState | null) {
		setSharedSession(state);
	},
	getSharedSession() {
		return getSharedSession();
	},
	setPiUI,
	orphanedToolResultAction,
	syncSharedSession,
	buildSideRequestSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	refreshClaudeUsage,
	setUsageControlQuery: setUsageControlQueryForTest,
	beginStandaloneWarningSession,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	childEnv,
	piSessionId: getPiSessionId,
	buildMcpServers,
	branchSummaryOutcome,
	get promptCaptures() {
		return promptCaptures;
	},
};

// --- Provider helpers: tool name mapping ---

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
const activeQueryContexts = new Set<QueryContext>();

// Defaults that silently cost the user something (no Opus 1M on Max, no
// AskClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || getPiMode() !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	getPiUI()?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot.
const promptCaptures = new PromptCaptures(256, (diagnostic) => {
	const first = diagnostic.matches[0];
	// A prompt that shares a long prefix with a known key but still resolves against
	// nothing is a pi assembly that drifted after we recorded it — the subagent-
	// inheritance failure that ships pi's harness as a verbatim side request and trips
	// the server's third-party plan-eligibility check ("out of extra usage"). Persist
	// those unconditionally (diagDump ignores CLAUDE_BRIDGE_DEBUG) so a recurrence leaves
	// a trace to ground the next fix on. Foreign one-shot prompts — a judge or reviewer's
	// own rubric served as a side request — diverge near offset 0 and stay on the
	// debug-only path, so this file holds only the failures that matter.
	if (first !== undefined && first.firstDivergent >= 2000) {
		try {
			diagDump("prompt-capture-no-match", {
				unresolvedLen: diagnostic.systemPrompt.length,
				knownKeys: diagnostic.matches.length,
				closestKeyLen: first.key.length,
				firstDivergent: first.firstDivergent,
				unresolvedAtDivergence: diagnostic.systemPrompt.slice(first.firstDivergent - 60, first.firstDivergent + 160),
				closestAtDivergence: first.key.slice(first.firstDivergent - 60, first.firstDivergent + 160),
			});
		} catch {
			// Best-effort: a diagnostic write must never mask the resolver's own throw.
		}
	}
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
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
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
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

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
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
/**
 * Provider entry for callers that obtained our streamSimple handle from pi's
 * model runtime (ctx.modelRegistry.getRegisteredProviderConfig) — e.g. a
 * permission reviewer or judge extension. A single-user-message context whose
 * system prompt was never captured from pi's own assembly is not a
 * conversation turn; serve it as a side request instead of letting the main
 * lane fail on prompt-capture resolution.
 */
function streamProviderEntry(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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

function streamSideRequest(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (resultCtx === ctx()) setCursor(context.messages.length);
		// Same top-level-only reasoning as the cursor above: a subagent's message
		// count must not decide what the parent's next call means.
		if (resultCtx === ctx()) recordToolResultDelivery(context.messages.length);
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Tool result with no live query ---
	// Either pi aborted a tool call and delivered the result anyway (end the turn),
	// or pi is retrying a turn whose query we killed (resume it). See
	// orphanedToolResultAction.
	const lastMsg = context.messages[context.messages.length - 1];
	const orphanAction = lastMsg?.role === "toolResult"
		? orphanedToolResultAction(context.messages.length, getDeliveredToolResultCursor())
		: null;
	if (orphanAction === "resume") {
		debug(`provider: re-issued tool-result continuation (cursor=${getDeliveredToolResultCursor()}), resuming as fresh query`);
	}
	if (orphanAction === "end-turn") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (activeQueryContexts.size === 0) setCursor(context.messages.length);
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

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query. A side
	//    request is always its own: it runs alongside pi's conversation, so taking
	//    the shared context would strand whatever that context is mid-turn.
	const isReentrant = side || activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

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

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, getLongContextSettings());
	// A side request neither reads the shared session nor adopts one: its history is
	// not pi's, so resuming pi's session would prepend a conversation the caller
	// never sent. `preserveSharedSession` is what makes the completion handler treat
	// the session Claude Code creates for it as ephemeral and delete it.
	const sidePriorMessages = side ? context.messages.slice(0, turnStart(context.messages)) : [];
	const syncResult: SyncResult = side
		? {
			sessionId: sidePriorMessages.length > 0
				? buildSideRequestSession(sidePriorMessages, cwd, customToolNameToSdk, cliModel)
				: null,
			preserveSharedSession: true,
		}
		: syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		// A resumed continuation has no user turn by construction, so it takes the
		// same "[continue]" recovery below without being an anomaly worth dumping.
		if (orphanAction !== "resume") diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: (() => { const s = getSharedSession(); return s ? { sessionId: s.sessionId.slice(0, 8), cursor: s.cursor } : null; })(),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
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

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				// A side request runs in its own Claude Code session, so aborting it says
				// nothing about whether pi's session still matches pi's history.
				if (!side) markNeedsRebuild({ forceRotate: true });
				debug(`provider: abort detected, sharedSession needsRebuild + forceRotate=${!side}`);
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
				adoptSession(sessionId, cursor, cwd);
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			// Not for a side request: it owns no part of the shared session, and
			// discarding pi's on its behalf would cost the next real turn a full rebuild
			// over a failure that had nothing to do with it.
			if (!side) {
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
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
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
			// The session built for a side request is scoped to that request, however it
			// ended. When Claude Code kept the id we resumed, the completion handler above
			// has already deleted it and this is a no-op.
			if (side && syncResult.sessionId) deleteSession(syncResult.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, getLongContextSettings()) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		const shared = getSharedSession();
		if (shared) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = shared.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// AskClaude uses Claude Code's native Read tool rather than Pi's MCP bridge.
	// Same resolver as the provider path: a prompt neither recorded nor derivable
	// throws here too, rather than silently sending Claude Code no skills.
	//
	// Resolved only when the answer would be used. The throw is justified by what a
	// miss would cost, so where it costs nothing — skills switched off, or no reader
	// to open a skill file with — an unrelated miss must not fail the call.
	const skillReadTool = disallowedTools.includes("Read") ? "none" : "native";
	const skillCapture = options?.appendSkills !== false && skillReadTool !== "none"
		? promptCaptures.resolveOrDerive(options?.systemPrompt)
		: undefined;
	const skillsBlock = skillCapture
		? renderSkillsBlock(collectPromptSkills(skillCapture), skillReadTool)
		: undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const claudeExecutable = getProviderSettings().pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming every
	// skill under the ~/.claude estate. The provider path gets this for free — `tools: []`
	// removes the Skill tool and the listing with it — but AskClaude runs on CC's native
	// tools, so it has to be asked for. Pi-side skills still arrive via skillsBlock below,
	// which is meant to be the only channel.
	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: childEnv(process.env, getPiSessionId()),
			permissionMode: "bypassPermissions",
			settings: { ...claudeCodeSettings(getProviderSettings()), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
			skills: [],
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			// Preset unconditionally: omitting it leaves the child on the SDK's bare default,
			// without the tool and permission guidance the bridge relies on everywhere else.
			// Whether pi has skills to append is unrelated to whether the child needs that.
			systemPrompt: { type: "preset", preset: "claude_code", append: skillsBlock },
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
					}
					// Claude Code reports an API failure with `is_error` on a result whose
					// subtype is still "success", so without this the error text was returned
					// as Claude's answer and pi's model read a 429 as content. Throwing hands
					// it to the tool's own catch, which renders it as an error result.
					const failure = wasAborted ? undefined : resultErrorText(message);
					if (failure) throw new Error(failure);
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	const registeredModels = applyRuntimeConfig(config);

	// Null for an in-process child instance: the top-level session already owns
	// the adapter, and this instance must neither rebind nor unregister it.
	const usageAdapter = claimUsageAdapter();

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined) pendingNotices.push('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
		if (config.askClaude?.enabled === undefined) pendingNotices.push("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${getSharedSession()?.sessionId?.slice(0, 8) ?? "none"}`);
		clearSharedSession();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamProviderEntry) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	let ownsStandaloneWarningSession = false;
	pi.on("session_start", (event, ctx) => {
		setPiUI(ctx.ui);
		setPiMode(ctx.mode);
		// The factory that registered the singleton adapter owns its session state.
		// Later in-process child factories share this module but cannot rebind it.
		if (usageAdapter) {
			bindUsageAdapter(usageAdapter, ctx);
			beginStandaloneWarningSession(pi, ctx, event.reason === "fork");
			ownsStandaloneWarningSession = true;
		}
		// Capture the top-level session only (see runtime-config.js): "new",
		// "resume" and "fork" each mint a new top-level id, while "startup" is
		// captured only when nothing is held yet. This existing process-wide state
		// is separate from the adapter's owner-bound refresh dependencies above.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork" || getPiSessionId() === undefined) {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (sessionId) setPiSessionId(sessionId);
		}
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	let lastSystemPromptOptions: typeof undefined | NonNullable<Parameters<typeof recordSystemPrompt>[1]>;
	function recordSystemPrompt(systemPrompt: string | undefined, options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		contextFiles?: { path: string; content: string }[];
		skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
		selectedTools?: string[];
	} | undefined) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
		});
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt(event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt(ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	// agent_start records the widened prompt at the top of a turn, but pi keeps
	// rebuilding it mid-turn as MCP servers finish connecting — so the prompt
	// pi-subagents reads via ctx.getSystemPrompt() when it dispatches a subagent (at the
	// Agent tool_call) can be wider than what agent_start captured. When it is, the child
	// embeds a prompt that matches no capture key, resolves against nothing, and ships
	// pi's harness as a verbatim side request — the same "out of extra usage" 400.
	// Re-recording at every tool_call captures that later snapshot, so the bytes a
	// subagent embeds are always a key. Idempotent: record() dedupes by prompt, and the
	// handler returns void so it never alters the tool call.
	pi.on("tool_call", (_event, ctx) => {
		recordSystemPrompt(ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("session_shutdown", () => {
		reportLeaks("session_shutdown");
		clearSession("session_shutdown");
		if (ownsStandaloneWarningSession) {
			endStandaloneWarningSession();
			ownsStandaloneWarningSession = false;
		}
		if (usageAdapter) releaseUsageAdapter(usageAdapter);
		// Not in clearSession: that also runs on session_start, and a live session
		// still needs to be able to serve side requests.
		if (registeredApiProvider) {
			unregisterApiProviders(API_PROVIDER_SOURCE_ID);
			registeredApiProvider = false;
			debug("side request: unregistered api provider");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				isolatedStreamFn,
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		const shared = getSharedSession();
		if (shared) {
			debug(`${event}: marking needsRebuild on session ${shared.sessionId.slice(0, 8)}`);
			markNeedsRebuild();
		}
	};
	pi.on("session_compact", (event) => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => markRebuild("session_tree"));

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary, and unlike compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Take it over the way compaction is taken over: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: isolatedStreamFn,
			});
			return branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(
				`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamProviderEntry;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: registeredModels,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamProviderEntry as any,
		});
	} else {
		// Subsequent instance (subagent session): skip registration entirely.
		// The subagent already has access to claude-bridge models via the shared
		// ModelRegistry from the parent's registration. Calls to those models
		// route through the parent's streamSimple via reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// pi's model runtime is not the only route to a bridge model. An extension that
	// drives its own agentLoop is served by pi-ai's default stream function, which
	// resolves the api id against pi-ai's own registry and never sees what
	// pi.registerProvider registered. So register there too, or such a call throws
	// where nothing catches it.
	//
	// First instance wins, as above: an in-flight side request delivers its tool
	// results back through the module instance that started it. /reload needs no
	// coordination — pi calls resetApiProviders() between shutdown and reactivation.
	if (!getApiProvider(PROVIDER_ID)) {
		registerApiProvider({
			api: PROVIDER_ID,
			// Cast: both entry points take SimpleStreamOptions, and a side request has no
			// use for the rich `stream` contract — pi's own provider composer likewise
			// routes `stream` to an extension's streamSimple.
			stream: streamSideRequest as any,
			streamSimple: streamSideRequest as any,
		}, API_PROVIDER_SOURCE_ID);
		registeredApiProvider = true;
		debug(`side request: registered api provider (module=${moduleInstanceId})`);
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = askConf?.defaultMode ?? "read";
	const defaultIsolated = askConf?.defaultIsolated ?? false;
	setAskClaudeToolName(askConf?.name ?? "AskClaude");

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const isolated = params.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
