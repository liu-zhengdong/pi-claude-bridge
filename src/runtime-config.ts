// Values written once — when the extension registers, or when a pi session
// starts — and read from everywhere else.
//
// Each of these used to be a module-level `let` in index.ts, shared by being in
// the same file. Collecting them here puts the single writer next to the value
// it writes, and leaves every other module with nothing but a getter.

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { applyLongContext, buildModels, resolveModel as _resolveModel, type LongContextSettings } from "./models.js";
import { getModels } from "@earendil-works/pi-ai/compat";

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
export const MODELS = buildModels(getModels("anthropic"));

let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

/**
 * The registered model list: the static catalog plus any runtime-discovered ids
 * (model-discovery.ts), with long-context entitlement applied. Discovered ids
 * lead the list so partial matches resolve to the newest model.
 */
export function buildModelCatalog(discoveredIds: readonly string[] = []) {
	return applyLongContext(buildModels(getModels("anthropic"), discoveredIds), longContextSettings);
}

/**
 * Adopt the config the extension just loaded. Written once per activation.
 *
 * Returns the model list with long-context entitlement applied, which is what
 * `pi.registerProvider` takes — derived here because the entitlement is read off
 * the same settings this call is adopting.
 */
export function applyRuntimeConfig(config: Config, discoveredIds: readonly string[] = []) {
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
	};
	return buildModelCatalog(discoveredIds);
}

export function getProviderSettings(): NonNullable<Config["provider"]> {
	return providerSettings;
}

export function getLongContextSettings(): LongContextSettings {
	return longContextSettings;
}

export function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// The process's TOP-LEVEL pi session, captured at session_start and stamped on
// every Claude Code child as AGENT_SESSION_ID.
//
// Module scope is NOT per extension instance. pi 0.85.1's extension loader
// caches the module per cwd and only re-invokes the factory (the default export)
// for an in-process child session, so every instance in this process shares this
// one variable — a naive capture on every session_start let a pi-subagents child
// overwrite the parent's id. So: capture on "new", "resume" and "fork" (each
// mints a new top-level id), and on "startup" only when nothing is captured yet.
// pi's top-level session emits "startup" exactly once per process, and pi always
// starts an in-process child session with reason "startup", so a later "startup"
// is a child and never overwrites.
//
// Top-level is the identity the nested-harness consumers want: a Claude Code
// child is a model call inside the top-level conversation, not a conversation of
// its own. A child never inherits the host process's AGENT_SESSION_ID — that
// inherited value is exactly what a sibling extension used to leave behind after
// a subagent ran, and every Claude Code child spawned afterwards then announced
// itself as the subagent's session.
let piSessionId: string | undefined;

export function getPiSessionId(): string | undefined {
	return piSessionId;
}

export function setPiSessionId(sessionId: string): void {
	piSessionId = sessionId;
}

let piUI: ExtensionUIContext | null = null;
let piMode: ExtensionContext["mode"] | null = null;

export function getPiUI(): ExtensionUIContext | null {
	return piUI;
}

export function setPiUI(ui: ExtensionUIContext | null): void {
	piUI = ui;
}

export function getPiMode(): ExtensionContext["mode"] | null {
	return piMode;
}

export function setPiMode(mode: ExtensionContext["mode"] | null): void {
	piMode = mode;
}

// The name the AskClaude tool was registered under, which the provider needs in
// order to exclude it from the tools it forwards to Claude Code. Configurable,
// so the provider cannot just hardcode the default.
let askClaudeToolName = "AskClaude";

export function getAskClaudeToolName(): string {
	return askClaudeToolName;
}

export function setAskClaudeToolName(name: string): void {
	askClaudeToolName = name;
}
