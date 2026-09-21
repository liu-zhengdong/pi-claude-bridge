// What pi assembled as a system prompt, recorded so a Claude Code turn can be
// resolved back to it.
//
// The provider and AskClaude both need to know which pi assembly a prompt came
// from — it carries the context files and skills to forward. Nothing else can
// answer that, because by the time a prompt reaches the provider it is just
// bytes.

import { debug, diagDump } from "./debug.js";
import { PromptCaptures } from "./prompt-capture.js";

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot.
export const promptCaptures = new PromptCaptures(256, (diagnostic) => {
	const first = diagnostic.matches[0];
	// A prompt that shares a long prefix with a known key but still resolves against
	// nothing is a pi assembly that drifted after we recorded it — the subagent-
	// inheritance failure that ships pi's harness as a verbatim side request and trips
	// the server's third-party plan-eligibility check ("out of extra usage"). Persist
	// those unconditionally (diagDump ignores CLAUDE_BRIDGE_DEBUG) so a recurrence leaves
	// a trace to ground the next fix on. Foreign one-shot prompts — a judge or reviewer's
	// own rubric served as a side request — diverge near offset 0 and stay on the
	// debug-only path, so this file holds only the failures that matter.
	if (first !== undefined && first.firstDivergent >= 2000) {
		try {
			diagDump("prompt-capture-no-match", {
				unresolvedLen: diagnostic.systemPrompt.length,
				knownKeys: diagnostic.matches.length,
				closestKeyLen: first.key.length,
				firstDivergent: first.firstDivergent,
				unresolvedAtDivergence: diagnostic.systemPrompt.slice(first.firstDivergent - 60, first.firstDivergent + 160),
				closestAtDivergence: first.key.slice(first.firstDivergent - 60, first.firstDivergent + 160),
			});
		} catch {
			// Best-effort: a diagnostic write must never mask the resolver's own throw.
		}
	}
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

type SystemPromptOptions = {
	customPrompt?: string;
	appendSystemPrompt?: string;
	contextFiles?: { path: string; content: string }[];
	skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
	selectedTools?: string[];
};

/** Records one extension activation's prompts.
 *
 *  Per activation rather than per module: an in-process child session shares this
 *  module, and a subagent's run must not leave its own options behind for the
 *  parent's next recording. */
export function createPromptRecorder() {
	// The options (custom/append/contextFiles/skills) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stashed
	// at before_agent_start so the later recordings can reuse them.
	let lastOptions: SystemPromptOptions | undefined;

	function record(systemPrompt: string | undefined, options: SystemPromptOptions | undefined): void {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
		});
	}

	return {
		/** From `before_agent_start`: pi's own assembly, plus the options behind it. */
		recordAssembled(systemPrompt: string | undefined, options: SystemPromptOptions | undefined): void {
			lastOptions = options;
			record(systemPrompt, options);
		},

		/** From `agent_start` and every `tool_call`: the *widened* prompt, which is
		 *  what the provider actually queries with.
		 *
		 *  MCP tool descriptions merge into the system prompt only after their servers
		 *  connect, which is after before_agent_start — verified at 10,988 chars there
		 *  vs 23,479 at agent_start. pi keeps rebuilding it mid-turn as more servers
		 *  finish, so the prompt pi-subagents reads via ctx.getSystemPrompt() when it
		 *  dispatches (at the Agent tool_call) can be wider still. A child embeds that
		 *  prompt verbatim; if it is not a capture key, the child's turn resolves
		 *  against nothing, falls back to a verbatim side request and ships pi's
		 *  harness — tripping the server's third-party plan-eligibility check ("out of
		 *  extra usage"). Recording at both points keeps every snapshot a key.
		 *
		 *  Idempotent: record() dedupes by prompt. */
		recordWidened(systemPrompt: string | undefined): void {
			record(systemPrompt, lastOptions);
		},
	};
}
