// What every Claude Code subprocess the bridge spawns is given: the environment
// overrides, the context-file excludes, and the reasoning→effort mapping.
//
// Stateless by construction. The provider, AskClaude and the compact summary all
// spawn a child, and each used to reach for these through the single file they
// shared; here there is nothing to reach for.

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

// Applied to every Claude Code subprocess the bridge spawns — provider, AskClaude
// and the compact summary. One place, so a guard is added once rather than three
// times, and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
// - MUSTER_HOOK_DISABLE=1: the child inherits $TMUX and the pane's process
//   ancestry, so the user's `muster hook` SessionStart/SessionEnd hooks would
//   reclaim and then tombstone the hosting pi session's bus row on every
//   request, leaving the pane permanently "departed" (muster >= 0.16 honors
//   the guard).
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	MUSTER_HOOK_DISABLE: "1",
} as const;

// Builds a Claude Code child's environment: base, then identity, then the
// CC_CHILD_ENV overrides. AGENT_SESSION_ID is ALWAYS a key in the result: set
// when an id was captured, explicitly undefined when not, so spawn unsets it
// rather than passing whatever base carried. Pure; never mutates base.
export function childEnv(base: NodeJS.ProcessEnv, captured: string | undefined): Record<string, string | undefined> {
	return {
		...base,
		AGENT_SESSION_ID: captured?.trim() || undefined,
		...CC_CHILD_ENV,
	};
}

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise a project CLAUDE.md arrives twice, and the user's
// ~/.claude/CLAUDE.md — a persona written for a harness that is not the one
// running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; "**/CLAUDE.md" covers the user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

// Pi reasoning levels → CC SDK effort levels.
export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};
