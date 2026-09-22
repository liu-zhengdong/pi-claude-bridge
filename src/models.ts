// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

// pi-ai's bundled catalog is a release-time snapshot, so a model Anthropic
// ships after it — Fable 5.1 on 28/08/2026 — is simply absent, and buildModels
// drops what it cannot find. Rather than invent a context window that pi would
// put behind its compaction threshold, inherit a verified sibling's metadata
// and override only identity. Drop the entry when the base is missing too.
//
// Two sibling rules, explicit first:
// - DERIVED_FROM: hand-written bases whose display name is not the base name
//   plus the numeric suffix.
// - Suffix derivation: an id that is a known base plus only "-<number>"
//   segments ("claude-opus-5-5" from "claude-opus-5"). This is what lets
//   runtime-discovered ids — models the installed Claude Code CLI serves but
//   this catalog predates — register with their sibling's metadata instead of
//   a guess.
export const DERIVED_FROM: Record<string, { from: string; name: string }> = {
	"claude-fable-5-1": { from: "claude-fable-5", name: "Claude Fable 5.1" },
};

const NUMERIC_SUFFIX = /^(-\d+)+$/;

function findSuffixBase<T extends { id: string }>(piAiModels: T[], candidates: readonly string[], id: string): T | undefined {
	let best: T | undefined;
	for (const candidate of candidates) {
		if (candidate.length >= id.length || !id.startsWith(`${candidate}-`)) continue;
		if (!NUMERIC_SUFFIX.test(id.slice(candidate.length))) continue;
		const model = piAiModels.find((m) => m.id === candidate);
		if (model && (best === undefined || candidate.length > best.id.length)) best = model;
	}
	return best;
}

function deriveMissing<T extends { id: string; name?: string; [key: string]: any }>(
	piAiModels: T[],
	candidates: readonly string[],
	id: string,
): T | undefined {
	const rule = DERIVED_FROM[id];
	const base = rule
		? piAiModels.find((m) => m.id === rule.from)
		: findSuffixBase(piAiModels, candidates, id);
	if (!base) return undefined;
	const name = rule?.name
		?? `${base.name ?? base.id}${id.slice(base.id.length).split("-").filter(Boolean).map((part) => `.${part}`).join("")}`;
	return { ...base, id, name };
}

export const MODEL_IDS_IN_ORDER = ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
//
// `discoveredIds` are runtime-discovered ids (model-discovery.ts), newest first:
// they lead the list so a partial match like `resolveModel("opus")` finds the
// newest model. A discovered id that MODEL_IDS_IN_ORDER already covers is
// ignored here — the static entry, not the discovery, owns that slot's order.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[], discoveredIds: readonly string[] = []) {
	const staticIds = new Set(MODEL_IDS_IN_ORDER);
	const order: string[] = [];
	for (const id of discoveredIds) {
		if (!id.startsWith("claude-") || staticIds.has(id) || order.includes(id)) continue;
		order.push(id);
	}
	order.push(...MODEL_IDS_IN_ORDER);

	// Each accepted id joins the derivation candidates, so a discovered sibling
	// can itself be the base for a later one (e.g. opus-5-5 → opus-5-5-1).
	const candidates: string[] = [...MODEL_IDS_IN_ORDER];
	const models = [];
	for (const id of order) {
		const found = piAiModels.find((m) => m.id === id) ?? deriveMissing(piAiModels, candidates, id);
		if (found == null) continue;
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		const { id: modelId, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap } = found;
		models.push({
			id: modelId,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		candidates.push(id);
	}
	return models;
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, and [1m] entitlement differs by model. See diag/CONTEXT-SIZE.md.
type RuntimePolicy = (settings: LongContextSettings) => ClaudeCodeRuntimeModel;

const RUNTIME_POLICIES: Record<string, RuntimePolicy> = {
	"claude-opus-5": () => ({ cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT }),
	"claude-opus-4-8": () => ({ cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT }),
	"claude-opus-4-7": () => ({ cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT }),
	"claude-opus-4-6": (settings) => {
		const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
		return {
			cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
			contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
		};
	},
	"claude-fable-5-1": () => ({ cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT }),
	"claude-fable-5": () => ({ cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT }),
	"claude-sonnet-5": () => ({ cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT }),
	"claude-sonnet-4-6": (settings) => ({
		cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
		contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
	}),
	"claude-haiku-4-5": () => ({ cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT }),
};

export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	const exact = RUNTIME_POLICIES[modelId];
	if (exact) return exact(settings);
	const inherited = resolveSuffixPolicy(modelId, settings);
	if (inherited) return inherited;
	console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

// A derived sibling (see deriveMissing) inherits its base's policy: the same
// context window and entitlement shape, with the base's id replaced by the full
// model id inside the CLI request id ("claude-opus-5[1m]" → "claude-opus-5-5[1m]").
function resolveSuffixPolicy(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel | undefined {
	let bestId: string | undefined;
	for (const id of Object.keys(RUNTIME_POLICIES)) {
		if (id.length >= modelId.length || !modelId.startsWith(`${id}-`)) continue;
		if (!NUMERIC_SUFFIX.test(modelId.slice(id.length))) continue;
		if (bestId === undefined || id.length > bestId.length) bestId = id;
	}
	if (bestId === undefined) return undefined;
	const base = RUNTIME_POLICIES[bestId](settings);
	const cliModelId = base.cliModelId.startsWith(bestId) ? `${modelId}${base.cliModelId.slice(bestId.length)}` : modelId;
	return { cliModelId, contextWindow: base.contextWindow };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
