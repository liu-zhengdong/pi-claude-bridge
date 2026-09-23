/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// Issue #16. ACP compacts through the `context` hook and never emits
	// session_compact, so pi's own history arrives shorter than the cursor with
	// needsRebuild unset. This used to be read as a subagent's context and answered
	// with an empty session holding only the new prompt. Subagents are now told
	// apart by the caller (ownsSharedSession, below) and never reach this function.
	it("rebuilds from pi's history when it comes back shorter than the cursor", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = "11111111-1111-4111-8111-111111111111";
		try {
			__test.setSharedSession({ sessionId, cursor: 42, cwd });

			const result = __test.syncSharedSession([
				{ role: "user", content: "[summary of the compacted turns]", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "The codeword was BANANA." }], timestamp: Date.now() },
				{ role: "user", content: "Which codeword?", timestamp: Date.now() },
			], cwd);

			assert.equal(result.sessionId, sessionId, "pi's turn must resume its own session, rewritten in place — not an empty one");
			assert.ok(!result.preserveSharedSession, "the rewritten session is pi's, so it stays the shared one");
			assert.equal(__test.getSharedSession().cursor, 2, "the cursor must restart from the rewritten history");
			const written = openSession({ sessionId, projectPath: cwd });
			assert.equal(written.messages.length, 2, "the rewritten history must reach Claude Code");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// Who may resume or rewrite the shared session. Getting this wrong in either
// direction loses a conversation: pi's own turn sent elsewhere starts from
// nothing, and a subagent let in takes over the parent's session mid-turn.
describe("ownsSharedSession", () => {
	const PI = "01a0cd2e-2a8a-73dd-8b79-8732f6dc5a7f";
	const cases = [
		["pi's own turn", { side: false, activeQuery: false, sessionId: PI }, PI, true],
		["a side request", { side: true, activeQuery: false, sessionId: PI }, PI, false],
		["a subagent inside a tool call of pi's live query", { side: false, activeQuery: true, sessionId: PI }, PI, false],
		["another agent session in this process", { side: false, activeQuery: false, sessionId: "child-session" }, PI, false],
		["a caller that sends no session id", { side: false, activeQuery: false }, PI, true],
		["before pi's session id is known", { side: false, activeQuery: false, sessionId: PI }, undefined, true],
	];
	for (const [label, call, piSessionId, expected] of cases) {
		it(`${expected ? "admits" : "turns away"} ${label}`, () => {
			assert.equal(__test.ownsSharedSession(call, piSessionId), expected);
		});
	}
});
