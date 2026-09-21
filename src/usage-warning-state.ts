import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageEventV1, UsageProviderV1 } from "./usage-bus.js";

export const PROVIDER_USAGE_WARNING_ENTRY_TYPE = "provider-usage:warning-v1";

type SessionEntriesContext = {
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getEntries">;
};

export type StandaloneWarningContext = SessionEntriesContext & {
	appendEntry(customType: string, data: { provider: UsageProviderV1; shownAt: number }): void;
	ui: {
		notify(message: string, level: "warning"): void;
	};
};

const shownSoftWarnings = new Set<UsageProviderV1>();
const ignoredForkMarkers = new Map<UsageProviderV1, number>();

function isUsageProvider(value: unknown): value is UsageProviderV1 {
	return value === "claude" || value === "codex";
}

function validMarkerCounts(ctx: SessionEntriesContext): Map<UsageProviderV1, number> {
	const counts = new Map<UsageProviderV1, number>();
	for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
		if (entry.type !== "custom" || entry.customType !== PROVIDER_USAGE_WARNING_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const provider = Reflect.get(data, "provider");
		const shownAt = Reflect.get(data, "shownAt");
		if (isUsageProvider(provider) && typeof shownAt === "number" && Number.isFinite(shownAt)) {
			counts.set(provider, (counts.get(provider) ?? 0) + 1);
		}
	}
	return counts;
}

/** Refresh from durable entries before using bridge fallback UI. */
function refreshStandaloneWarningState(ctx: SessionEntriesContext): void {
	for (const [provider, count] of validMarkerCounts(ctx)) {
		if (count > (ignoredForkMarkers.get(provider) ?? 0)) shownSoftWarnings.add(provider);
	}
}

/** Restore the once-per-provider allowance after startup, reload, or resume. */
export function restoreStandaloneWarningState(ctx: SessionEntriesContext): void {
	shownSoftWarnings.clear();
	ignoredForkMarkers.clear();
	refreshStandaloneWarningState(ctx);
}

/** A fork is a new provider session even though its history includes old markers. */
export function resetStandaloneWarningState(ctx: SessionEntriesContext = {}): void {
	shownSoftWarnings.clear();
	ignoredForkMarkers.clear();
	for (const [provider, count] of validMarkerCounts(ctx)) ignoredForkMarkers.set(provider, count);
}

// The pi session this process can fall back to when nothing is listening on the
// usage bus. Null between sessions, and for every in-process child instance that
// did not claim the usage adapter.
let standaloneWarningContext: StandaloneWarningContext | null = null;

/** Bind the running pi session as the fallback UI, and start its once-per-provider
 *  allowance — fresh for a fork, restored from durable entries otherwise. */
export function beginStandaloneWarningSession(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "ui">,
	fork: boolean,
): void {
	standaloneWarningContext = {
		appendEntry: (customType, data) => { pi.appendEntry(customType, data); },
		sessionManager: ctx.sessionManager,
		ui: ctx.ui,
	};
	if (fork) resetStandaloneWarningState(ctx);
	else restoreStandaloneWarningState(ctx);
}

/** The session is gone, so there is no UI left to fall back to. */
export function endStandaloneWarningSession(): void {
	standaloneWarningContext = null;
}

/** Fallback UI for an event the bus delivered to nobody. A no-op when no session
 *  is bound, which is what keeps a child instance from notifying on its own. */
export function notifyIfStandalone(event: Exclude<ProviderUsageEventV1, { type: "snapshot" }>): void {
	if (standaloneWarningContext) notifyWithStandaloneSessionPolicy(event, standaloneWarningContext);
}

/** Fallback UI used only when the provider-usage bus has no listeners. */
export function notifyWithStandaloneSessionPolicy(
	event: Exclude<ProviderUsageEventV1, { type: "snapshot" }>,
	ctx: StandaloneWarningContext,
): void {
	if (event.type === "hard-limit") {
		ctx.ui.notify(event.message, "warning");
		return;
	}

	// Listener invocation is not an acknowledgement. Only a valid session marker
	// written by pi-usage (or our own persisted fallback) consumes the allowance.
	refreshStandaloneWarningState(ctx);
	if (shownSoftWarnings.has(event.provider)) return;

	const marker = { provider: event.provider, shownAt: Date.now() };
	ctx.appendEntry(PROVIDER_USAGE_WARNING_ENTRY_TYPE, marker);
	shownSoftWarnings.add(event.provider);
	ctx.ui.notify(event.message, "warning");
}
