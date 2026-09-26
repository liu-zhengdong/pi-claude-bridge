import { createConnection } from "node:net";

// State is shared across re-evaluations of this extension within a Pi process.
// The broker endpoint is a one-shot rendezvous name, never a token/file path.
const key = Symbol.for("claude-bridge/setup-token/v1");
interface SetupTokenState {
	provided: boolean;
	value: string | undefined;
	endpoint: string | undefined;
	challenge: string | undefined;
	loading?: Promise<void>;
}
const globals = globalThis as unknown as Record<symbol, SetupTokenState | undefined>;
const initial = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const endpoint = process.env.PI_ATRIUM_LAUNCH_SECRET_SOCKET;
const challenge = process.env.PI_ATRIUM_LAUNCH_SECRET_CHALLENGE;
const state = globals[key] ?? (globals[key] = {
	provided: initial !== undefined || endpoint !== undefined,
	// A managed identity must use its assigned account even if some earlier
	// extension polluted process.env with a different Claude token.
	value: endpoint ? undefined : initial?.trim(),
	endpoint,
	challenge,
});
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.PI_ATRIUM_LAUNCH_SECRET_SOCKET;
delete process.env.PI_ATRIUM_LAUNCH_SECRET_CHALLENGE;

/** Announce the bridge capability before requesting the one-shot credential. */
export function hasClaudeCodeSetupToken(): boolean {
	return state.provided;
}

export async function initializeClaudeCodeSetupToken(): Promise<void> {
	if (!state.endpoint || state.value) return;
	if (!/^[a-f0-9]{64}$/.test(state.challenge ?? ""))
		throw new Error("独立令牌就绪检查未获肯定回应：缺少启动挑战；请升级 pi-atrium 并重启身份");
	state.loading ??= new Promise<void>((resolve, reject) => {
		const socket = createConnection(state.endpoint!);
		let payload = "";
		socket.setTimeout(8_000, () => socket.destroy(new Error("timeout")));
		socket.on("connect", () => socket.write(`READY claude-bridge-token-ready-v1 ${state.challenge}\n`));
		socket.on("data", part => {
			payload += part.toString("utf8");
			if (payload.length > 4097) socket.destroy(new Error("oversized"));
		});
		socket.once("error", reject);
		socket.once("end", () => {
			const token = payload.endsWith("\n") ? payload.slice(0, -1) : "";
			if (!token || /\s/.test(token)) {
				reject(new Error("invalid response"));
				return;
			}
			state.value = token;
			state.endpoint = undefined;
			state.challenge = undefined;
			resolve();
		});
	});
	try {
		await state.loading;
	} catch {
		// Do not leak socket paths, contents or credentials into Pi's error log.
		throw new Error("独立令牌就绪检查未获肯定回应：bridge 未能领取令牌；请重启身份或升级 pi-atrium");
	}
}

export function claudeCodeSetupToken(): string | undefined {
	if (state.provided && !state.value)
		throw new Error("独立令牌认证不可用；请修复账号或升级 pi-atrium 并重启身份");
	return state.value;
}
