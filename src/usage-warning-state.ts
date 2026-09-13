import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageEventV1, UsageProviderV1 } from "./usage-bus.js";

export const PROVIDER_USAGE_WARNING_ENTRY_TYPE = "provider-usage:warning-v1";

type SessionEntriesContext = {
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getEntries">;
};

export type StandaloneWarningContext = {
	appendEntry(customType: string, data: { provider: UsageProviderV1; shownAt: number }): void;
	ui: {
		notify(message: string, level: "warning"): void;
	};
};

const shownSoftWarnings = new Set<UsageProviderV1>();

function isUsageProvider(value: unknown): value is UsageProviderV1 {
	return value === "anthropic" || value === "codex";
}

/** Restore the once-per-provider allowance after startup, reload, or resume. */
export function restoreStandaloneWarningState(ctx: SessionEntriesContext): void {
	shownSoftWarnings.clear();
	for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
		if (entry.type !== "custom" || entry.customType !== PROVIDER_USAGE_WARNING_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const provider = Reflect.get(data, "provider");
		const shownAt = Reflect.get(data, "shownAt");
		if (isUsageProvider(provider) && typeof shownAt === "number" && Number.isFinite(shownAt)) {
			shownSoftWarnings.add(provider);
		}
	}
}

/** A fork is a new provider session even though its history includes old markers. */
export function resetStandaloneWarningState(): void {
	shownSoftWarnings.clear();
}

/** Remember a soft warning handled by pi-usage without writing its marker a
 * second time. This also prevents a duplicate during a listener reload gap. */
export function noteStandaloneWarningHandledByListener(
	event: Exclude<ProviderUsageEventV1, { type: "snapshot" }>,
): void {
	if (event.type === "soft-warning") shownSoftWarnings.add(event.provider);
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
	if (shownSoftWarnings.has(event.provider)) return;

	const marker = { provider: event.provider, shownAt: Date.now() };
	ctx.appendEntry(PROVIDER_USAGE_WARNING_ENTRY_TYPE, marker);
	shownSoftWarnings.add(event.provider);
	ctx.ui.notify(event.message, "warning");
}
