/**
 * A tool result with no live query to hand it to arrives in two different
 * situations that look identical in the context alone:
 *
 *  - pi aborted a tool call and delivered the result anyway → end the turn
 *  - pi is retrying a turn whose query we killed → resume it
 *
 * Getting the second one wrong is what made auto-retry return an empty message
 * and silently park the session (issue #1). Message count is the discriminator,
 * so pin down every case of it here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { orphanedToolResultAction } = __test;

describe("orphanedToolResultAction", () => {
	it("resumes when the re-issued context matches what we last delivered", () => {
		// Pi's auto-retry drops the failed assistant message and re-sends the exact
		// same messages, so the count is unchanged from delivery time.
		assert.equal(orphanedToolResultAction(12, 12), "resume");
	});

	it("ends the turn when the context grew since the last delivery", () => {
		// A fresh orphan added at least the assistant tool call and its result.
		assert.equal(orphanedToolResultAction(14, 12), "end-turn");
		assert.equal(orphanedToolResultAction(13, 12), "end-turn");
	});

	it("ends the turn when nothing was ever delivered", () => {
		// Initial state: first turn of a session aborted during a tool call.
		assert.equal(orphanedToolResultAction(2, 0), "end-turn");
	});

	it("ends the turn when the context shrank below the last delivery", () => {
		// /compact and tree navigation rewrite history out from under us; a shorter
		// context is never the retry of the turn we delivered into.
		assert.equal(orphanedToolResultAction(8, 12), "end-turn");
	});

	it("does not read the initial state as a match", () => {
		// Without the zero guard 0 === 0 would read as a retry. The caller only asks
		// when the last message is a tool result, so count 0 should not arrive here
		// at all — but the answer should not depend on that.
		assert.equal(orphanedToolResultAction(0, 0), "end-turn");
	});
});
