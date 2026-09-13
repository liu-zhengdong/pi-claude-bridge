import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	return value === "anthropic" || value === "codex";
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
