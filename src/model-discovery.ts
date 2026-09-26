// Runtime model discovery: find the model ids the installed Claude Code CLI
// serves but this bridge's catalog predates, and fold them into the registered
// model list.
//
// Why: pi-ai's catalog and this repo's MODEL_IDS_IN_ORDER are release-time
// snapshots — a model Anthropic ships afterwards (Fable 5.1, then Opus 5.5) is
// invisible until both catch up. Claude Code itself knows what it serves: its
// control channel answers `supportedModels()` over the same SDK query that
// usage.ts uses. So the provider registers a `refreshModels` hook, which pi
// calls during startup (network disabled) and again when the model picker opens:
//
// - Restore phase (`allowNetwork: false`): cached ids only. Never spawns the CLI.
// - Network phase: re-probe only when the cached snapshot is stale — no cache,
//   older than the TTL, a different CLI binary, or pi asked with `force`. On
//   failure (CLI missing, timeout, abort) the cached list is served unchanged:
//   discovery may add models, never remove them.
//
// The cache lives beside claude-bridge.json in the agent dir. Probed ids are
// merged with earlier discoveries, newest first, so a CLI that stops advertising
// a model does not make it vanish while it may still serve.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLAUDE_MD_EXCLUDES, childEnv } from "./cc-child.js";
import { claudeCodeSettings, type Config } from "./config.js";
import { hasClaudeCodeSetupToken } from "./setup-token.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { buildModelCatalog } from "./runtime-config.js";

export type CatalogModel = ReturnType<typeof buildModelCatalog>[number];
export type ProviderSettings = NonNullable<Config["provider"]>;

export const MODEL_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

// --- Cache file ---

export type ModelDiscoveryCache = {
	/** Epoch ms of the last successful probe. */
	checkedAt: number;
	/** Resolved CLI path the ids came from, for diagnostics. */
	cliPath?: string;
	/** Identity of the CLI binary that produced the ids (size+mtime, or SDK version). */
	cliStamp?: string;
	/** Discovered ids, newest first. */
	models: string[];
};

export function modelDiscoveryCachePath(): string {
	// The unit-suite preload (tests/lib/setup.mjs) redirects this so activation
	// never reads a developer's real discoveries.
	const override = process.env.CLAUDE_BRIDGE_MODELS_CACHE?.trim();
	return override || join(getAgentDir(), "claude-bridge-models.json");
}

export function readModelDiscoveryCache(file: string = modelDiscoveryCachePath()): ModelDiscoveryCache | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<ModelDiscoveryCache> | null;
		if (parsed == null || !Array.isArray(parsed.models)) return undefined;
		const models = parsed.models.filter((id): id is string => typeof id === "string" && id.startsWith("claude-"));
		return {
			checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : 0,
			cliPath: typeof parsed.cliPath === "string" ? parsed.cliPath : undefined,
			cliStamp: typeof parsed.cliStamp === "string" ? parsed.cliStamp : undefined,
			models,
		};
	} catch (error) {
		debug(`model-discovery: unreadable cache ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** Cached ids for the activation-time registration (`pi --list-models`, snapshot-only consumers). */
export function readDiscoveredModelIds(file: string = modelDiscoveryCachePath()): string[] {
	return readModelDiscoveryCache(file)?.models ?? [];
}

function writeModelDiscoveryCache(cache: ModelDiscoveryCache, file: string): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
	} catch (error) {
		debug(`model-discovery: failed to write cache ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// --- Advertised ids ---

/** The slice of the CLI's ModelInfo that matters here; tolerant of SDK drift. */
export type AdvertisedModel = { value?: string | null; resolvedModel?: string | null };

// "claude-opus-5-5[1m]" → "claude-opus-5-5"; "claude-haiku-4-5-20251001" → "claude-haiku-4-5".
// The suffix is an entitlement/alias marker and a dated snapshot name, not part
// of the model id the bridge requests or the strategy table keys on.
const BRACKET_SUFFIX = /\[[^\]]*\]$/;
const DATE_SUFFIX = /-\d{8}$/;

export function extractModelIds(models: readonly AdvertisedModel[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		const advertised = model?.resolvedModel || model?.value;
		if (typeof advertised !== "string") continue;
		const id = advertised.replace(BRACKET_SUFFIX, "").replace(DATE_SUFFIX, "");
		if (!id.startsWith("claude-") || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

// --- CLI identity ---

/** What counts as "the same CLI" for cache freshness: the configured binary's
 *  content stamp, or the SDK package version that bundles the default one. */
export function cliIdentity(provider: ProviderSettings = {}): { cliPath?: string; cliStamp?: string } {
	const configured = provider.pathToClaudeCodeExecutable;
	if (configured) {
		try {
			const real = realpathSync(configured);
			const stat = statSync(real);
			return { cliPath: real, cliStamp: `${stat.size}:${Math.floor(stat.mtimeMs)}` };
		} catch (error) {
			debug(`model-discovery: cannot stat configured CLI ${configured}: ${error instanceof Error ? error.message : String(error)}`);
			return { cliPath: configured };
		}
	}
	try {
		const require = createRequire(import.meta.url);
		const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
		const pkg = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf-8")) as { version?: string };
		return typeof pkg.version === "string" ? { cliStamp: `sdk:${pkg.version}` } : {};
	} catch (error) {
		debug(`model-discovery: cannot identify SDK CLI: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

// --- Probe ---

type DiscoveryQuery = {
	supportedModels(): Promise<unknown>;
	close(): void;
};

export type ModelProbeDependencies = {
	query(input: Parameters<typeof query>[0]): DiscoveryQuery;
};

export type ModelProbeOptions = {
	cwd: string;
	provider?: ProviderSettings;
	signal?: AbortSignal;
	timeoutMs?: number;
	dependencies?: Partial<ModelProbeDependencies>;
};

async function* emptyDiscoveryPrompt(): AsyncGenerator<never, void, unknown> {
	// Control protocol only. Yielding a message would turn this into a model
	// request and consume completion tokens.
}

/** Ask the CLI which models it serves, over the completion-free control channel. */
export async function probeModelIds(options: ModelProbeOptions): Promise<string[]> {
	const provider = options.provider ?? {};
	const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
	const sdkQueryImpl = options.dependencies?.query ?? query;

	const abortController = new AbortController();
	let removeAbortRejection: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => {
			const reason = abortController.signal.reason;
			reject(reason instanceof Error ? reason : new Error("Claude model probe aborted."));
		};
		abortController.signal.addEventListener("abort", onAbort, { once: true });
		removeAbortRejection = () => abortController.signal.removeEventListener("abort", onAbort);
	});
	const timeout = setTimeout(() => {
		abortController.abort(new Error(`Claude model probe timeout after ${timeoutMs}ms.`));
	}, timeoutMs);
	const onCallerAbort = () => abortController.abort(options.signal?.reason);
	if (options.signal?.aborted) {
		onCallerAbort();
		// We rethrow the same failure below; observe this rejection here so it
		// cannot surface as an unhandled rejection before the throw is awaited.
		aborted.catch(() => {});
	} else {
		options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	}

	let sdkQuery: DiscoveryQuery | undefined;
	try {
		if (abortController.signal.aborted) {
			throw abortController.signal.reason instanceof Error
				? abortController.signal.reason
				: new Error("Claude model probe aborted.");
		}
		const strictMcpConfig = hasClaudeCodeSetupToken() || provider.strictMcpConfig !== false;
		sdkQuery = sdkQueryImpl({
			prompt: emptyDiscoveryPrompt(),
			options: {
				cwd: options.cwd,
				env: childEnv(process.env, undefined),
				abortController,
				tools: [],
				...(hasClaudeCodeSetupToken() ? { settingSources: [] as const } : {}),
				strictMcpConfig,
				skills: [],
				persistSession: false,
				permissionMode: "bypassPermissions",
				settings: {
					...claudeCodeSettings(provider),
					claudeMdExcludes: CLAUDE_MD_EXCLUDES,
					includeGitInstructions: false,
				},
				...(strictMcpConfig ? { extraArgs: { "strict-mcp-config": null } } : {}),
				...(provider.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: provider.pathToClaudeCodeExecutable } : {}),
				...makeCliDebugOptions("model-discovery"),
			},
		});
		const advertised = await Promise.race([sdkQuery.supportedModels(), aborted]);
		return extractModelIds(advertised as readonly AdvertisedModel[]);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onCallerAbort);
		removeAbortRejection?.();
		try { sdkQuery?.close(); } catch { /* already closed */ }
	}
}

// --- Refresh hook ---

export type ModelCatalogRefreshContext = {
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
};

export type ModelCatalogRefresherDependencies = {
	cacheFile: string;
	buildCatalog: (discoveredIds: readonly string[]) => CatalogModel[];
	identity: (provider: ProviderSettings) => { cliPath?: string; cliStamp?: string };
	now: () => number;
	probe: (options: { cwd: string; provider: ProviderSettings; signal?: AbortSignal }) => Promise<string[]>;
	log: (...args: unknown[]) => void;
};

/** Merge a fresh probe result with earlier discoveries, newest first, dropping
 *  blanks and duplicates. */
export function mergeDiscoveredIds(newer: readonly string[], older: readonly string[]): string[] {
	const merged: string[] = [];
	for (const id of [...newer, ...older]) {
		if (id.startsWith("claude-") && !merged.includes(id)) merged.push(id);
	}
	return merged;
}

/** Build the `refreshModels` handler pi calls for this provider. */
export function createModelCatalogRefresher(options: {
	cwd: string;
	provider?: Config["provider"];
	dependencies?: Partial<ModelCatalogRefresherDependencies>;
}) {
	const { cwd } = options;
	const provider: ProviderSettings = options.provider ?? {};
	const dependencies: ModelCatalogRefresherDependencies = {
		cacheFile: modelDiscoveryCachePath(),
		buildCatalog: buildModelCatalog,
		identity: cliIdentity,
		now: Date.now,
		probe: (probeOptions) => probeModelIds(probeOptions),
		log: debug,
		...options.dependencies,
	};

	return async function refreshModels(context: ModelCatalogRefreshContext): Promise<CatalogModel[]> {
		const cache = readModelDiscoveryCache(dependencies.cacheFile);
		if (!context.allowNetwork) {
			// Restore phase: pi runs this at startup, before auth resolution or
			// network access. Cached ids only — never spawn the CLI here.
			return dependencies.buildCatalog(cache?.models ?? []);
		}

		let ids = cache?.models ?? [];
		const identity = dependencies.identity(provider);
		const cliChanged = identity.cliStamp !== undefined && cache?.cliStamp !== undefined && identity.cliStamp !== cache.cliStamp;
		const stale = context.force === true || cache === undefined || cliChanged || dependencies.now() - cache.checkedAt > MODEL_DISCOVERY_TTL_MS;
		if (stale) {
			try {
				const probed = await dependencies.probe({ cwd, provider, signal: context.signal });
				ids = mergeDiscoveredIds(probed, ids);
				writeModelDiscoveryCache({
					checkedAt: dependencies.now(),
					cliPath: identity.cliPath,
					cliStamp: identity.cliStamp,
					models: ids,
				}, dependencies.cacheFile);
				dependencies.log(`model-discovery: probe ok (${probed.length} advertised), cached=[${ids.join(",")}]`);
			} catch (error) {
				// Discovery may add models, never remove them: a failed probe keeps
				// serving the cached list.
				dependencies.log(`model-discovery: probe failed, keeping ${ids.length} cached id(s): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return dependencies.buildCatalog(ids);
	};
}
