// The one-time welcome notice.

import { markStartupNoticeShown } from "./config.js";
import { getPiMode, getPiUI } from "./runtime-config.js";

/** Add a line to the notice, if it has not been shown before. Queued rather than
 *  shown, because what is worth telling the user is known at activation while
 *  whether anyone is watching is not. */
export function queueStartupNotice(notice: string): void {
	pendingNotices.push(notice);
}

// Defaults that silently cost the user something (no Opus 1M on Max, no
// AskClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];

export function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || getPiMode() !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	getPiUI()?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}
