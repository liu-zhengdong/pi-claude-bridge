// Structural provider-usage protocol shared with pi-usage.
//
// Keep this file dependency-free at runtime: pi-usage and the bridge discover one
// another exclusively through the global symbol, regardless of load order.

export type UsageProviderV1 = "anthropic" | "codex";
export type UsageScopeV1 = { kind: "account" } | { kind: "model"; modelIds: string[]; label: string };

export type NormalizedUsageWindow = {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: number;
	windowMinutes?: number;
	scope: UsageScopeV1;
};

export type ProviderUsageSnapshotV1 = {
	version: 1;
	provider: "anthropic" | "codex";
	capturedAt: number;
	windows: NormalizedUsageWindow[];
};

export type ProviderUsageEventV1 =
	| { version: 1; type: "snapshot"; snapshot: ProviderUsageSnapshotV1 }
	| {
		version: 1;
		type: "soft-warning";
		provider: "anthropic" | "codex";
		message: string;
		snapshot?: ProviderUsageSnapshotV1;
	}
	| {
		version: 1;
		type: "hard-limit";
		provider: "anthropic" | "codex";
		message: string;
		snapshot?: ProviderUsageSnapshotV1;
	};

export type ProviderUsageAdapterV1 = {
	id: string;
	usageProvider: "anthropic" | "codex";
	modelProviders: string[];
	refresh(options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProviderUsageSnapshotV1>;
};

export type ProviderUsageBusV1 = {
	version: 1;
	register(adapter: ProviderUsageAdapterV1): () => void;
	adapters(): ProviderUsageAdapterV1[];
	subscribe(listener: (event: ProviderUsageEventV1) => void): () => void;
	publish(event: ProviderUsageEventV1): number;
};

export const PROVIDER_USAGE_BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;

export function getUsageBusV1(): ProviderUsageBusV1 {
	const existing = globalRegistry[PROVIDER_USAGE_BUS_SYMBOL];
	if (existing !== undefined) {
		if (typeof existing !== "object" || existing === null) {
			throw new Error("Incompatible provider usage bus version undefined; expected version 1.");
		}
		const version = Reflect.get(existing, "version");
		if (version !== 1) {
			throw new Error(`Incompatible provider usage bus version ${String(version)}; expected version 1.`);
		}
		for (const method of ["register", "adapters", "subscribe", "publish"] as const) {
			if (typeof Reflect.get(existing, method) !== "function") {
				throw new Error(`Incompatible provider usage bus version 1: ${method} must be a function.`);
			}
		}
		return existing as ProviderUsageBusV1;
	}

	const bus = createUsageBusV1();
	globalRegistry[PROVIDER_USAGE_BUS_SYMBOL] = bus;
	return bus;
}

function createUsageBusV1(): ProviderUsageBusV1 {
	const adaptersById = new Map<string, { adapter: ProviderUsageAdapterV1; registration: symbol }>();
	const listeners = new Set<(event: ProviderUsageEventV1) => void>();

	return {
		version: 1,
		register(adapter) {
			const registration = Symbol(adapter.id);
			adaptersById.set(adapter.id, { adapter, registration });
			return () => {
				if (adaptersById.get(adapter.id)?.registration === registration) adaptersById.delete(adapter.id);
			};
		},
		adapters() {
			return [...adaptersById.values()].map(({ adapter }) => adapter);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publish(event) {
			let invoked = 0;
			for (const listener of [...listeners]) {
				invoked += 1;
				try {
					listener(event);
				} catch {
					// Isolate listeners so one extension cannot hide usage from another.
				}
			}
			return invoked;
		},
	};
}

const ACCOUNT_WINDOWS: Record<string, { label: string; windowMinutes?: number; scope?: UsageScopeV1 }> = {
	five_hour: { label: "5h", windowMinutes: 5 * 60 },
	seven_day: { label: "7d", windowMinutes: 7 * 24 * 60 },
	seven_day_oauth_apps: { label: "7d OAuth apps", windowMinutes: 7 * 24 * 60 },
	seven_day_opus: {
		label: "7d",
		windowMinutes: 7 * 24 * 60,
		scope: {
			kind: "model",
			modelIds: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"],
			label: "Opus",
		},
	},
	seven_day_sonnet: {
		label: "7d",
		windowMinutes: 7 * 24 * 60,
		scope: {
			kind: "model",
			modelIds: ["claude-sonnet-5", "claude-sonnet-4-6"],
			label: "Sonnet",
		},
	},
};

const MODEL_IDS_BY_BUCKET: Record<string, string[]> = {
	fable: ["claude-fable-5-1", "claude-fable-5"],
	opus: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"],
	sonnet: ["claude-sonnet-5", "claude-sonnet-4-6"],
	haiku: ["claude-haiku-4-5"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function epochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function modelIdsForBucket(displayName: string): string[] {
	const key = slug(displayName);
	for (const [family, ids] of Object.entries(MODEL_IDS_BY_BUCKET)) {
		if (key.includes(family)) return [...ids];
	}
	return [key];
}

function normalizeWindow(
	id: string,
	label: string,
	value: unknown,
	scope: UsageScopeV1,
	windowMinutes?: number,
): NormalizedUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const utilization = finiteNumber(value.utilization);
	if (utilization === undefined) return undefined;
	const resetsAt = epochSeconds(value.resets_at);
	return {
		id,
		label,
		usedPercent: clampPercent(utilization),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(windowMinutes === undefined ? {} : { windowMinutes }),
		scope,
	};
}

/** Normalize the rate-limit section returned by the Agent SDK's usage control. */
export function snapshotFromClaudeUsage(payload: unknown, capturedAt = Date.now()): ProviderUsageSnapshotV1 {
	if (!isRecord(payload) || !isRecord(payload.rate_limits)) {
		throw new Error("Claude usage response did not include plan rate limits.");
	}
	const rateLimits = payload.rate_limits;
	const windows: NormalizedUsageWindow[] = [];

	for (const [key, metadata] of Object.entries(ACCOUNT_WINDOWS)) {
		const window = normalizeWindow(
			key,
			metadata.label,
			rateLimits[key],
			metadata.scope ?? { kind: "account" },
			metadata.windowMinutes,
		);
		if (window) windows.push(window);
	}

	if (Array.isArray(rateLimits.model_scoped)) {
		for (const value of rateLimits.model_scoped) {
			if (!isRecord(value) || typeof value.display_name !== "string" || value.display_name.trim() === "") continue;
			const displayName = value.display_name.trim();
			const bucketSlug = slug(displayName);
			const window = normalizeWindow(
				`model_scoped:${bucketSlug}`,
				"7d",
				value,
				{ kind: "model", modelIds: modelIdsForBucket(displayName), label: displayName },
				7 * 24 * 60,
			);
			if (window) windows.push(window);
		}
	}

	const extraUsage = normalizeWindow(
		"extra_usage",
		"Monthly extra usage",
		rateLimits.extra_usage,
		{ kind: "account" },
	);
	if (extraUsage) windows.push(extraUsage);

	return { version: 1, provider: "anthropic", capturedAt, windows };
}

/** Build the partial snapshot carried by an SDK rate_limit_event. */
export function snapshotFromClaudeRateLimitInfo(info: unknown, capturedAt = Date.now()): ProviderUsageSnapshotV1 | undefined {
	if (!isRecord(info) || typeof info.rateLimitType !== "string") return undefined;
	const utilization = finiteNumber(info.utilization);
	if (utilization === undefined) return undefined;
	const type = info.rateLimitType;
	const metadata = ACCOUNT_WINDOWS[type] ?? { label: type.replaceAll("_", " ") };
	const resetsAt = finiteNumber(info.resetsAt);
	const window: NormalizedUsageWindow = {
		id: type,
		label: metadata.label,
		usedPercent: clampPercent(utilization * 100),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(metadata.windowMinutes === undefined ? {} : { windowMinutes: metadata.windowMinutes }),
		scope: metadata.scope ?? { kind: "account" },
	};
	return { version: 1, provider: "anthropic", capturedAt, windows: [window] };
}

export function publishProviderUsage(event: ProviderUsageEventV1): number {
	return getUsageBusV1().publish(event);
}

export function registerClaudeUsageAdapter(refresh: ProviderUsageAdapterV1["refresh"]): () => void {
	return getUsageBusV1().register({
		id: "schuettc.pi-claude-bridge",
		usageProvider: "anthropic",
		modelProviders: ["claude-bridge"],
		refresh,
	});
}
