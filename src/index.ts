// The extension itself: what pi calls, and what this package registers with it.
//
// Everything below either subscribes to a pi event or registers something. The
// work each one triggers lives in its own module — provider.js for the queries,
// session-sync.js for Claude Code's session file, isolated-summary.js for the
// compact and branch-summary takeovers, askclaude.js for the tool.

import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, compact, generateBranchSummary, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskClaudeTool } from "./askclaude.js";
import { CC_CHILD_ENV, childEnv } from "./cc-child.js";
import { loadConfig } from "./config.js";
import { PROVIDER_ID } from "./convert.js";
import { debug, moduleInstanceId } from "./debug.js";
import { errorMessage, resultErrorText } from "./errors.js";
import { branchSummaryOutcome, isolatedStreamFn, reinjectPriorCompactionFileOps } from "./isolated-summary.js";
import { messageOrigins, observeBranchTail } from "./message-origin.js";
import { createModelCatalogRefresher, readDiscoveredModelIds } from "./model-discovery.js";
import { extractUserPromptBlocks } from "./pi-context.js";
import { createPromptRecorder, promptCaptures } from "./prompt-record.js";
import { buildMcpServers, reportLeaks, streamProviderEntry, streamSideRequest } from "./provider.js";
import { applyRuntimeConfig, getPiSessionId, setPiMode, setPiSessionId, setPiUI } from "./runtime-config.js";
import { clearSharedSession, getSharedSession, markNeedsRebuild, orphanedToolResultAction, setSharedSession, type SessionState } from "./session-store.js";
import { buildSideRequestSession, ownsSharedSession, syncSharedSession } from "./session-sync.js";
import { hasClaudeCodeSetupToken } from "./setup-token.js";
import { queueStartupNotice } from "./startup-notice.js";
import { consumeQuery, deliverToolResults, drainForAbort, finalizeCurrentStream } from "./stream-events.js";
import { bindUsageAdapter, claimUsageAdapter, refreshClaudeUsage, releaseUsageAdapter, setUsageControlQueryForTest } from "./usage.js";
import { beginStandaloneWarningSession, endStandaloneWarningSession } from "./usage-warning-state.js";

// --- Registration guards ---

// Which module instance serves a bridge query, in a Symbol.for() global so every
// instance in the process reads the same answer.
//
// Extensions like pi-subagents spawn a subagent and it activates this extension
// again. The instance that registered first is the one holding the in-flight
// QueryContexts, so a tool result has to come back to it; handing pi a later
// instance's `streamProviderEntry` would deliver into empty state.
//
// That is a question about the *function*, not about the registration. pi's
// ModelRegistry is per session — each ExtensionRunner holds its own — so an
// activation that skips registerProvider leaves that session with no
// claude-bridge models at all, which is what made them come and go. Every
// activation registers; what it registers is `activeStreamSimple`, a shell that
// reads this global per call. Re-registration is then idempotent.
//
// On session_shutdown (including /reload), clearSession() releases ownership if
// this instance held it, so the next activation can claim it.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

/** Registered as the provider's streamSimple: resolve the owning instance per call. */
const activeStreamSimple: typeof streamProviderEntry = (model, context, options) =>
	((globalThis as Record<symbol, any>)[ACTIVE_STREAM_SIMPLE_KEY] ?? streamProviderEntry)(model, context, options);

// Ours among pi-ai's api-provider registrations, so shutdown removes only the one
// this module instance made. Per instance, not per package: a subagent instance
// that skipped registration must not be able to unregister the parent's.
const API_PROVIDER_SOURCE_ID = `claude-bridge:${moduleInstanceId}`;
let registeredApiProvider = false;

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
	ownsSharedSession,
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

export default function (pi: ExtensionAPI) {
	// The Pi host probes get_commands before any turn in token mode. Old bridge
	// versions have no marker, so a mixed-version launch fails rather than using
	// the machine's Claude login. No token value is exposed by the marker.
	if (hasClaudeCodeSetupToken()) {
		pi.registerCommand("claude-bridge-token-ready-v1", {
			description: "Claude 独立令牌模式就绪",
			handler: async () => {},
		});
	}
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	// Cached discoveries seed the first registration too, so snapshot-only
	// consumers (and `pi --list-models`) see them before any refresh runs.
	const registeredModels = applyRuntimeConfig(config, readDiscoveredModelIds());

	// Null for an in-process child instance: the top-level session already owns
	// the adapter, and this instance must neither rebind nor unregister it.
	const usageAdapter = claimUsageAdapter();

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined) queueStartupNotice('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
		if (config.askClaude?.enabled === undefined) queueStartupNotice("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${getSharedSession()?.sessionId?.slice(0, 8) ?? "none"}`);
		clearSharedSession();

		// Release ownership if this instance held it. This allows /reload to work —
		// the old instance steps down so the next activation claims ownership
		// instead of forwarding into a shut-down instance.
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
		// Input still waiting at the end of a resumed branch fired its message_end in
		// an earlier process; see message-origin.ts.
		const branch = ctx.sessionManager?.getBranch?.();
		if (branch) observeBranchTail(messageOrigins, buildSessionContext(branch).messages);
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
	// Why all three events, and why the recorder is per activation: prompt-record.js.
	// Which user-role messages the user sent, for provider.ts to tell them from
	// extension messages; see message-origin.ts.
	pi.on("message_end", (event) => {
		messageOrigins.observe(event.message);
	});
	const promptRecorder = createPromptRecorder();
	let warnedUnforwarded = false;
	pi.on("before_agent_start", (event, ctx) => {
		const problem = promptRecorder.recordAssembled(event.systemPrompt, event.systemPromptOptions);
		if (problem && !warnedUnforwarded) {
			warnedUnforwarded = true;
			ctx?.ui?.notify?.(
				`claude-bridge: ${problem}; Claude Code will not see that part of the system prompt. Details in claude-bridge-diag.log.`,
				"warning",
			);
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		promptRecorder.recordWidened(ctx.getSystemPrompt());
	});
	// Returns void, so it never alters the tool call.
	pi.on("tool_call", (_event, ctx) => {
		promptRecorder.recordWidened(ctx.getSystemPrompt());
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
	// Every activation registers — the ModelRegistry it registers into belongs to
	// this session alone. Only the streamSimple is shared, and it is shared by
	// forwarding rather than by skipping registration.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamProviderEntry;
	} else {
		// Another instance owns the in-flight state (e.g. this is a subagent
		// session): its models are registered here all the same, and calls to them
		// reach the owner through activeStreamSimple via reentrant QueryContexts.
		debug(`provider: registering with forwarding streamSimple, another instance owns queries (module=${moduleInstanceId})`);
	}
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		// pi runs this on startup (cached ids only) and again when the model picker
		// opens (may probe the CLI for models this catalog predates).
		refreshModels: createModelCatalogRefresher({ cwd: process.cwd(), provider: config.provider }),
		// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
		streamSimple: activeStreamSimple as any,
	});

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

	registerAskClaudeTool(pi, config);
}
