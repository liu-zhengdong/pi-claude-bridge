// Account usage: the adapter pi's meter polls, and the per-turn token accounting
// that fills in an assistant message's usage.
//
// Both sides are here because they feed the same meter from two directions — the
// adapter asks Claude Code over the control channel, while the inference stream
// hands us fresher numbers for free as it goes.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_MD_EXCLUDES, childEnv } from "./cc-child.js";
import { claudeCodeSettings, loadConfig, type Config } from "./config.js";
import { hasClaudeCodeSetupToken } from "./setup-token.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import {
	registerClaudeUsageAdapter,
	snapshotFromClaudeUsage,
	type ProviderUsageAdapterV1,
	type ProviderUsageSnapshotV1,
} from "./usage-bus.js";

// The most recent COMPLETE inline usage snapshot parsed from an SDK rate_limit_event's
// `unifiedWindows`. The registered usage adapter prefers this over polling so the meter
// reflects the freshest data the inference stream already delivered.
let lastInlineUsageSnapshot: ProviderUsageSnapshotV1 | undefined;

export function setInlineUsageSnapshot(snapshot: ProviderUsageSnapshotV1): void {
	lastInlineUsageSnapshot = snapshot;
}

// Module-global for the same reason as ACTIVE_STREAM_SIMPLE_KEY: in-process child
// extension instances share this module and must not replace or unregister the
// top-level session's account-usage adapter.
let unregisterClaudeUsageAdapter: (() => void) | undefined;

/** Proof that this extension instance is the one that registered the adapter.
 *  Held by the factory that claimed it, and the only way to bind or release it. */
export type UsageAdapterClaim = { readonly owner: ClaudeUsageAdapterOwner };

/** Register the account-usage adapter, unless a live instance already did.
 *
 *  Returns null for a child instance that shares this module: it must not
 *  replace the top-level session's adapter, and holding no claim is what stops
 *  its own shutdown from unregistering one it never registered. */
export function claimUsageAdapter(): UsageAdapterClaim | null {
	if (unregisterClaudeUsageAdapter) return null;
	const owner = createClaudeUsageAdapterOwner();
	unregisterClaudeUsageAdapter = registerClaudeUsageAdapter(
		(options) =>
			lastInlineUsageSnapshot !== undefined
				? Promise.resolve(lastInlineUsageSnapshot)
				: refreshClaudeUsage(options, undefined, owner),
	);
	return { owner };
}

/** Give the claimed adapter the session it should refresh against. */
export function bindUsageAdapter(claim: UsageAdapterClaim, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	bindClaudeUsageAdapterOwner(claim.owner, ctx);
}

/** Unregister and unbind. Idempotent: both halves ignore a claim that is no
 *  longer the live one, so a second shutdown is a no-op. */
export function releaseUsageAdapter(claim: UsageAdapterClaim): void {
	unregisterClaudeUsageAdapter?.();
	unregisterClaudeUsageAdapter = undefined;
	clearClaudeUsageAdapterOwner(claim.owner);
}

type UsageControlQuery = {
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<unknown>;
	close(): void;
};

type UsageRefreshDependencies = {
	query(input: Parameters<typeof query>[0]): UsageControlQuery;
	cwd: string;
	env: Record<string, string | undefined>;
	provider: NonNullable<Config["provider"]>;
};

type ClaudeUsageAdapterOwner = {
	dependencies?: UsageRefreshDependencies;
	ready: Promise<UsageRefreshDependencies>;
	resolveReady(dependencies: UsageRefreshDependencies): void;
};

let claudeUsageAdapterOwner: ClaudeUsageAdapterOwner | undefined;
let usageControlQuery: UsageRefreshDependencies["query"] = query;

function createClaudeUsageAdapterOwner(): ClaudeUsageAdapterOwner {
	let resolveReady!: (dependencies: UsageRefreshDependencies) => void;
	const owner: ClaudeUsageAdapterOwner = {
		ready: new Promise((resolve) => { resolveReady = resolve; }),
		resolveReady,
	};
	claudeUsageAdapterOwner = owner;
	return owner;
}

function bindClaudeUsageAdapterOwner(owner: ClaudeUsageAdapterOwner, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	if (claudeUsageAdapterOwner !== owner) return;
	const sessionId = ctx.sessionManager?.getSessionId?.();
	// ExtensionContext always supplies cwd; the fallback keeps legacy minimal
	// test doubles from failing before they reach the behavior they exercise.
	const cwd = ctx.cwd ?? process.cwd();
	const dependencies: UsageRefreshDependencies = {
		query: usageControlQuery,
		cwd,
		env: childEnv(process.env, sessionId),
		provider: { ...(loadConfig(cwd).provider ?? {}) },
	};
	owner.dependencies = dependencies;
	owner.resolveReady(dependencies);
}

function clearClaudeUsageAdapterOwner(owner: ClaudeUsageAdapterOwner): void {
	if (claudeUsageAdapterOwner !== owner) return;
	owner.dependencies = undefined;
	claudeUsageAdapterOwner = undefined;
}

export function setUsageControlQueryForTest(factory?: UsageRefreshDependencies["query"]): void {
	usageControlQuery = factory ?? query;
}

async function* emptyUsagePrompt(): AsyncGenerator<never, void, unknown> {
	// Account refresh uses the control protocol only. Yielding even one message
	// would turn this into a model request and consume completion tokens.
}

/** Fetch subscription windows over the SDK control channel without creating a
 * model turn. The injectable dependencies are only for contract tests. */
export async function refreshClaudeUsage(
	options: Parameters<ProviderUsageAdapterV1["refresh"]>[0],
	injected?: UsageRefreshDependencies,
	owner = claudeUsageAdapterOwner,
) {
	const abortController = new AbortController();
	const timeoutMs = Math.max(0, options.timeoutMs);
	let removeAbortRejection: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => {
			const reason = abortController.signal.reason;
			reject(reason instanceof Error ? reason : new Error("Claude usage refresh aborted."));
		};
		abortController.signal.addEventListener("abort", onAbort, { once: true });
		removeAbortRejection = () => abortController.signal.removeEventListener("abort", onAbort);
	});
	const timeout = setTimeout(() => {
		abortController.abort(new Error(`Claude usage refresh timeout after ${timeoutMs}ms.`));
	}, timeoutMs);
	const onCallerAbort = () => abortController.abort(options.signal?.reason);
	if (options.signal?.aborted) onCallerAbort();
	else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

	let sdkQuery: UsageControlQuery | undefined;
	try {
		if (abortController.signal.aborted) {
			throw abortController.signal.reason instanceof Error
				? abortController.signal.reason
				: new Error("Claude usage refresh aborted.");
		}
		if (!injected && !owner) throw new Error("Claude usage refresh is not bound to a session.");
		const dependencies = injected ?? owner?.dependencies ?? await Promise.race([owner!.ready, aborted]);
		if (abortController.signal.aborted) {
			throw abortController.signal.reason instanceof Error
				? abortController.signal.reason
				: new Error("Claude usage refresh aborted.");
		}
		const strictMcpConfig = hasClaudeCodeSetupToken() || dependencies.provider.strictMcpConfig !== false;
		const claudeExecutable = dependencies.provider.pathToClaudeCodeExecutable;
		sdkQuery = dependencies.query({
			prompt: emptyUsagePrompt(),
			options: {
				cwd: dependencies.cwd,
				env: dependencies.env,
				abortController,
				tools: [],
				...(hasClaudeCodeSetupToken() ? { settingSources: [] as const } : {}),
				strictMcpConfig,
				skills: [],
				persistSession: false,
				permissionMode: "bypassPermissions",
				settings: {
					...claudeCodeSettings(dependencies.provider),
					claudeMdExcludes: CLAUDE_MD_EXCLUDES,
					includeGitInstructions: false,
				},
				...(strictMcpConfig ? { extraArgs: { "strict-mcp-config": null } } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("usage-refresh"),
			},
		});

		const payload = await Promise.race([
			sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
			aborted,
		]);
		return snapshotFromClaudeUsage(payload);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onCallerAbort);
		removeAbortRejection?.();
		try { sdkQuery?.close(); } catch {}
	}
}

export function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
export function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}
