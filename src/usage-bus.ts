// Structural provider-usage protocol shared with pi-usage.
//
// Keep this file dependency-free at runtime: pi-usage and the bridge discover one
// another exclusively through the global symbol, regardless of load order.

export type ProviderKeyV1 = "claude" | "codex";
export type UsageProviderV1 = ProviderKeyV1;
export type UsageStateV1 = "available" | "warning" | "rejected" | "unknown";
export type UsageScopeV1 =
	| { kind: "account" }
	| { kind: "model"; modelIds: string[]; label: string }
	| { kind: "overage" }
	| { kind: "provider"; id: string; label?: string };

export type NormalizedUsageWindow = {
	id: string;
	label: string;
	usedPercent?: number;
	resetsAt?: number;
	windowMinutes?: number;
	scope: UsageScopeV1;
	state?: UsageStateV1;
	usedAmount?: number;
	limitAmount?: number;
	currency?: string;
};

export type ProviderUsageSnapshotV1 = {
	version: 1;
	provider: ProviderKeyV1;
	providerLabel?: string;
	source: string;
	capturedAt: number;
	complete: boolean;
	adapterId?: string;
	windows: NormalizedUsageWindow[];
};

export type ProviderUsageEventV1 =
	| { version: 1; type: "snapshot"; snapshot: ProviderUsageSnapshotV1 }
	| {
		version: 1;
		type: "soft-warning";
		provider: ProviderKeyV1;
		message: string;
		snapshot?: ProviderUsageSnapshotV1;
	}
	| {
		version: 1;
		type: "hard-limit";
		provider: ProviderKeyV1;
		message: string;
		snapshot?: ProviderUsageSnapshotV1;
	};

export type ProviderUsageAdapterV1 = {
	id: string;
	usageProvider: ProviderKeyV1;
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
			if (!isValidAdapter(adapter)) return () => {};
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
			if (typeof listener !== "function") return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publish(event) {
			if (!isValidEvent(event)) return 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function finiteNumberValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function finiteNonNegative(value: unknown): value is number {
	return finiteNumberValue(value) && value >= 0;
}

function isProvider(value: unknown): value is ProviderKeyV1 {
	return value === "claude" || value === "codex";
}

function isState(value: unknown): value is UsageStateV1 {
	return value === "available" || value === "warning" || value === "rejected" || value === "unknown";
}

function isScope(value: unknown): value is UsageScopeV1 {
	if (!isRecord(value)) return false;
	if (value.kind === "account" || value.kind === "overage") return true;
	if (value.kind === "model") {
		return (
			nonEmptyString(value.label) &&
			Array.isArray(value.modelIds) &&
			value.modelIds.length > 0 &&
			value.modelIds.every(nonEmptyString)
		);
	}
	return value.kind === "provider" && nonEmptyString(value.id) && (value.label === undefined || nonEmptyString(value.label));
}

function isWindow(value: unknown): value is NormalizedUsageWindow {
	if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.label) || !isScope(value.scope)) return false;
	if (value.usedPercent !== undefined && !finiteNumberValue(value.usedPercent)) return false;
	if (value.resetsAt !== undefined && !finiteNonNegative(value.resetsAt)) return false;
	if (value.windowMinutes !== undefined && (!finiteNonNegative(value.windowMinutes) || value.windowMinutes === 0)) return false;
	if (value.state !== undefined && !isState(value.state)) return false;
	if (value.usedAmount !== undefined && !finiteNonNegative(value.usedAmount)) return false;
	if (value.limitAmount !== undefined && !finiteNonNegative(value.limitAmount)) return false;
	return value.currency === undefined || nonEmptyString(value.currency);
}

function isValidSnapshot(value: unknown): value is ProviderUsageSnapshotV1 {
	return (
		isRecord(value) &&
		value.version === 1 &&
		isProvider(value.provider) &&
		(value.providerLabel === undefined || nonEmptyString(value.providerLabel)) &&
		nonEmptyString(value.source) &&
		finiteNonNegative(value.capturedAt) &&
		typeof value.complete === "boolean" &&
		(value.adapterId === undefined || nonEmptyString(value.adapterId)) &&
		Array.isArray(value.windows) &&
		value.windows.every(isWindow)
	);
}

function isValidAdapter(value: unknown): value is ProviderUsageAdapterV1 {
	return (
		isRecord(value) &&
		nonEmptyString(value.id) &&
		isProvider(value.usageProvider) &&
		Array.isArray(value.modelProviders) &&
		value.modelProviders.length > 0 &&
		value.modelProviders.every(nonEmptyString) &&
		typeof value.refresh === "function"
	);
}

function isValidEvent(value: unknown): value is ProviderUsageEventV1 {
	if (!isRecord(value) || value.version !== 1) return false;
	if (value.type === "snapshot") return isValidSnapshot(value.snapshot);
	return (
		(value.type === "soft-warning" || value.type === "hard-limit") &&
		isProvider(value.provider) &&
		nonEmptyString(value.message) &&
		(value.snapshot === undefined || (isValidSnapshot(value.snapshot) && value.snapshot.provider === value.provider))
	);
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
	state?: UsageStateV1,
): NormalizedUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const utilization = finiteNumber(value.utilization);
	const resetsAt = epochSeconds(value.resets_at);
	if (utilization === undefined && resetsAt === undefined && state === undefined) return undefined;
	return {
		id,
		label,
		...(utilization === undefined ? {} : { usedPercent: clampPercent(utilization) }),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(windowMinutes === undefined ? {} : { windowMinutes }),
		...(state === undefined ? {} : { state }),
		scope,
	};
}

const SNAPSHOT_BASE = {
	version: 1,
	provider: "claude",
	providerLabel: "Claude",
	adapterId: "schuettc.pi-claude-bridge",
} as const;

/**
 * Rate-limit types that describe the usage-credits ("overage") bucket. This bucket is only
 * meaningful on usage-based accounts (credits enabled, or real spend). A subscription account
 * with credits off still emits an "overage" rate-limit event at a phantom utilization, so it
 * must be suppressed rather than shown.
 */
const OVERAGE_RATE_LIMIT_TYPES = new Set(["overage", "extra_usage"]);

/**
 * Whether the most recent complete snapshot showed the credits/overage bucket as active
 * (credits enabled, or real credits spent). Partial rate-limit events carry no is_enabled or
 * used_credits, so they defer to this to decide whether an "overage" window is real. Defaults
 * to false: overage stays hidden until a complete snapshot confirms the bucket is active.
 */
let lastOverageActive = false;

/** Reset the remembered overage activity. Test-only. */
export function __resetOverageActivityForTest(): void {
	lastOverageActive = false;
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
			const window = normalizeWindow(
				`model_scoped:${slug(displayName)}`,
				"7d",
				value,
				{ kind: "model", modelIds: modelIdsForBucket(displayName), label: displayName },
				7 * 24 * 60,
			);
			if (window) windows.push(window);
		}
	}

	if (isRecord(rateLimits.extra_usage)) {
		const extra = rateLimits.extra_usage;
		const utilization = finiteNumber(extra.utilization);
		const usedCredits = finiteNumber(extra.used_credits);
		const monthlyLimit = finiteNumber(extra.monthly_limit);
		const currency = typeof extra.currency === "string" && extra.currency.trim() ? extra.currency : undefined;
		const enabled = typeof extra.is_enabled === "boolean" ? extra.is_enabled : undefined;
		// Only surface overage on usage-based accounts: credits explicitly enabled, or real spend
		// recorded. A subscription account with credits off reports is_enabled=false and zero spend,
		// so the window is dropped instead of showing a phantom utilization.
		const overageActive = enabled === true || (usedCredits !== undefined && usedCredits > 0);
		lastOverageActive = overageActive;
		if (overageActive) {
			windows.push({
				id: "extra_usage",
				label: "overage",
				...(utilization === undefined ? {} : { usedPercent: clampPercent(utilization) }),
				...(enabled === undefined ? {} : { state: enabled ? "available" : "unknown" }),
				...(usedCredits === undefined ? {} : { usedAmount: usedCredits / 100 }),
				...(monthlyLimit === undefined ? {} : { limitAmount: monthlyLimit / 100 }),
				...(currency === undefined ? {} : { currency }),
				scope: { kind: "overage" },
			});
		}
	}

	return { ...SNAPSHOT_BASE, source: "claude-code-sdk", capturedAt, complete: true, windows };
}

/** Build the partial snapshot carried by an SDK rate_limit_event. */
export function snapshotFromClaudeRateLimitInfo(info: unknown, capturedAt = Date.now()): ProviderUsageSnapshotV1 | undefined {
	if (!isRecord(info) || typeof info.rateLimitType !== "string" || info.rateLimitType.trim() === "") return undefined;
	const type = info.rateLimitType;
	// Credits/overage events are only real on usage-based accounts; suppress them unless a complete
	// snapshot has confirmed the bucket is active (see lastOverageActive).
	const isOverage = OVERAGE_RATE_LIMIT_TYPES.has(type);
	if (isOverage && !lastOverageActive) return undefined;
	const metadata = ACCOUNT_WINDOWS[type] ?? { label: isOverage ? "overage" : type.replaceAll("_", " ") };
	const utilization = finiteNumber(info.utilization);
	const resetsAt = finiteNumber(info.resetsAt);
	const state =
		info.status === "allowed_warning"
			? "warning"
			: info.status === "rejected"
				? "rejected"
				: info.status === "allowed"
					? "available"
					: undefined;
	if (utilization === undefined && resetsAt === undefined && state === undefined) return undefined;
	const window: NormalizedUsageWindow = {
		id: type,
		label: metadata.label,
		...(utilization === undefined ? {} : { usedPercent: clampPercent(utilization * 100) }),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(metadata.windowMinutes === undefined ? {} : { windowMinutes: metadata.windowMinutes }),
		...(state === undefined ? {} : { state }),
		scope: isOverage ? { kind: "overage" } : metadata.scope ?? { kind: "account" },
	};
	return {
		...SNAPSHOT_BASE,
		source: "claude-code-sdk-rate-limit-event",
		capturedAt,
		complete: false,
		windows: [window],
	};
}

export function publishProviderUsage(event: ProviderUsageEventV1): number {
	if (!isValidEvent(event)) return 0;
	try {
		return getUsageBusV1().publish(event);
	} catch {
		return 0;
	}
}

export function registerClaudeUsageAdapter(refresh: ProviderUsageAdapterV1["refresh"]): () => void {
	const adapter: ProviderUsageAdapterV1 = {
		id: "schuettc.pi-claude-bridge",
		usageProvider: "claude",
		modelProviders: ["claude-bridge"],
		refresh,
	};
	if (!isValidAdapter(adapter)) return () => {};
	try {
		const unregister = getUsageBusV1().register(adapter);
		return typeof unregister === "function" ? unregister : () => {};
	} catch {
		return () => {};
	}
}
