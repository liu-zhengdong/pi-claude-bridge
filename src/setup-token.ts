// A Pi identity receives this variable only at launch. Capture it before any
// tools or SDK calls and remove it from Pi's ambient environment. Pi's extension
// loader can evaluate this module more than once (/reload); the first capture
// remains authoritative until the identity process exits.
const key = Symbol.for("claude-bridge/setup-token/v1");
interface SetupTokenState { provided: boolean; value: string | undefined }
const globals = globalThis as unknown as Record<symbol, SetupTokenState | undefined>;
const initial = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const state = globals[key] ?? (globals[key] = { provided: initial !== undefined, value: initial?.trim() });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

export function hasClaudeCodeSetupToken(): boolean {
	return state.provided && !!state.value;
}

export function claudeCodeSetupToken(): string | undefined {
	if (state.provided && !state.value) throw new Error("Claude setup-token is empty; replace the assigned account token and restart this identity");
	return state.value;
}
