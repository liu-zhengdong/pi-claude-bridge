#!/usr/bin/env node

/**
 * Extension messages are not presented to Claude Code as the user's (issue #14).
 *
 * pi hands the provider every user-role message alike: the user's prompts and
 * steers, custom messages from pi.sendMessage, and whatever a `context` hook
 * inserted for one request (billion-context-pi's nudges). The bridge used to send
 * everything after a tool result as a steer, which CC frames as "The user sent a
 * new message while you were working". Origins come from message_end, keyed by
 * timestamp, and anything pi never reported as user input is labelled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createOriginTracker,
	extensionNote,
	labelUserTurn,
	observeBranchTail,
	splitUserTurn,
} from "../src/message-origin.js";

const { default: activate } = await import("../src/index.js");
const { messageOrigins } = await import("../src/message-origin.js");

const text = (value) => [{ type: "text", text: value }];
const assistant = (ts) => ({ role: "assistant", content: text("working"), timestamp: ts });
const toolResult = (ts) => ({ role: "toolResult", toolCallId: "call-1", content: text("ok"), timestamp: ts });
const user = (value, ts) => ({ role: "user", content: text(value), timestamp: ts });

describe("createOriginTracker", () => {
	it("knows the user's own input from message_end, including !command output", () => {
		const tracker = createOriginTracker();
		tracker.observe({ role: "user", timestamp: 1 });
		tracker.observe({ role: "bashExecution", timestamp: 2 });
		assert.deepEqual(tracker.origin({ timestamp: 1 }), { from: "user" });
		assert.deepEqual(tracker.origin({ timestamp: 2 }), { from: "user" });
	});

	it("names a custom message by its customType", () => {
		const tracker = createOriginTracker();
		tracker.observe({ role: "custom", customType: "shadow-report", timestamp: 3 });
		assert.deepEqual(tracker.origin({ timestamp: 3 }), { from: "extension", name: "shadow-report" });
	});

	it("treats a message pi never reported as not the user's", () => {
		const tracker = createOriginTracker();
		tracker.observe({ role: "assistant", timestamp: 4 });
		assert.deepEqual(tracker.origin({ timestamp: 4 }), { from: "extension" });
		assert.deepEqual(tracker.origin({ timestamp: 999 }), { from: "extension" });
		assert.deepEqual(tracker.origin({}), { from: "extension" });
	});

	it("forgets the oldest entries past its limit", () => {
		const tracker = createOriginTracker(2);
		for (const ts of [1, 2, 3]) tracker.observe({ role: "user", timestamp: ts });
		assert.deepEqual(tracker.origin({ timestamp: 1 }), { from: "extension" });
		assert.deepEqual(tracker.origin({ timestamp: 3 }), { from: "user" });
	});
});

describe("observeBranchTail", () => {
	it("records only the user and custom messages after the last reply", () => {
		const tracker = createOriginTracker();
		observeBranchTail(tracker, [
			user("answered long ago", 1),
			assistant(2),
			user("still waiting", 3),
			{ role: "custom", customType: "reminder", timestamp: 4 },
		]);
		assert.deepEqual(tracker.origin({ timestamp: 3 }), { from: "user" });
		assert.deepEqual(tracker.origin({ timestamp: 4 }), { from: "extension", name: "reminder" });
		assert.deepEqual(tracker.origin({ timestamp: 1 }), { from: "extension" }, "history before the reply is not the turn");
	});
});

describe("splitUserTurn", () => {
	it("keeps the user's steer and turns the rest into labelled notes, in order", () => {
		const tracker = createOriginTracker();
		tracker.observe({ role: "user", timestamp: 10 });
		tracker.observe({ role: "custom", customType: "shadow-report", timestamp: 12 });
		const messages = [
			user("do the thing", 1),
			assistant(2),
			toolResult(3),
			user("actually stop", 10),
			user("This is an efficiency nudge to compress early", 11),
			user("review found two issues", 12),
		];
		const { fromUser, notes } = splitUserTurn(messages, tracker);
		assert.deepEqual(fromUser, [messages[3]]);
		assert.deepEqual(notes, [
			extensionNote("This is an efficiency nudge to compress early"),
			extensionNote("review found two issues", "shadow-report"),
		]);
		assert.match(notes[0], /^<system-reminder>\nAdded by pi or one of its extensions, not typed by the user:\n/);
		assert.match(notes[1], /extension message "shadow-report"/);
	});
});

describe("labelUserTurn", () => {
	it("wraps what the user did not send, leaving history and the user's own message as they were", () => {
		const tracker = createOriginTracker();
		tracker.observe({ role: "user", timestamp: 20 });
		const image = { type: "image", data: "iVBOR", mimeType: "image/png" };
		const history = user("earlier", 1);
		const own = user("fix the bug", 20);
		const injected = { role: "user", content: [...text("context note"), image], timestamp: 21 };
		const labelled = labelUserTurn([history, assistant(2), own, injected], tracker);

		assert.equal(labelled[0], history, "history before the turn is untouched");
		assert.equal(labelled[2], own, "the user's message is untouched");
		assert.deepEqual(labelled[3].content, [{ type: "text", text: extensionNote("context note") }, image]);
		assert.equal(labelled[3].timestamp, 21);
	});
});

describe("activation wiring", () => {
	function activateWithMockPi() {
		const handlers = new Map();
		activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {} });
		return handlers;
	}

	it("records message_end", () => {
		const handlers = activateWithMockPi();
		handlers.get("message_end")({ message: { role: "user", content: text("hi"), timestamp: 424242 } });
		assert.deepEqual(messageOrigins.origin({ timestamp: 424242 }), { from: "user" });
	});

	it("seeds input left waiting at the end of a resumed branch", () => {
		const handlers = activateWithMockPi();
		const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message });
		const branch = [
			entry("a", null, user("first", 515150)),
			entry("b", "a", assistant(515151)),
			entry("c", "b", user("never answered", 515152)),
		];
		handlers.get("session_start")(
			{ reason: "resume" },
			{ ui: {}, mode: "tui", sessionManager: { getBranch: () => branch, getSessionId: () => "s1" } },
		);
		assert.deepEqual(messageOrigins.origin({ timestamp: 515152 }), { from: "user" });
		assert.deepEqual(messageOrigins.origin({ timestamp: 515150 }), { from: "extension" });
	});
});
