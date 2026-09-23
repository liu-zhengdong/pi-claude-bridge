/**
 * Claude Code's refusal fallback (issue #18).
 *
 * When the safeguards refuse the model's reply, Claude Code retries the request on
 * a fallback model, swaps the whole session to it, deletes the refused partial from
 * its own transcript, and reports all of that in a `system/model_refusal_fallback`
 * message at the end of the turn. On 2026-09-23 Opus 5.5 fell back to Opus 5 three
 * times; pi recorded every later reply as Opus 5.5 and kept the refused partial in
 * its history, ahead of the retry.
 *
 * A refusal cannot be produced on demand, so these streams are synthetic, shaped
 * after that session's Claude Code transcript and the SDK's message types.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { servedModelId } from "../src/mapping.js";

const { __test } = await import("../src/index.js");

const model = {
	api: "anthropic-messages", provider: "claude-bridge", id: "claude-opus-5-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

const streamEvent = (event) => ({ type: "stream_event", event });
const start = (served) => streamEvent({ type: "message_start", message: { model: served } });
const stop = (stopReason) => [
	streamEvent({ type: "message_delta", delta: { stop_reason: stopReason } }),
	streamEvent({ type: "message_stop" }),
];
const thinking = (index, text) => [
	streamEvent({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
	streamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }),
	streamEvent({ type: "content_block_stop", index }),
];
const text = (index, value) => [
	streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
	streamEvent({ type: "content_block_stop", index }),
];
const toolUse = (index, id) => [
	streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id, input: {} } }),
	streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
	streamEvent({ type: "content_block_stop", index }),
];
const fallbackNotice = (sessionId, scope = "session") => ({
	type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", scope,
	original_model: "claude-opus-5-5[1m]", fallback_model: "claude-opus-5", request_id: null,
	api_refusal_category: "reasoning_extraction", retracted_message_uuids: ["8635a326-a1bd-4990-9ae9-0ccbf55337b4"],
	content: "", uuid: "063739e2-0000-4000-8000-000000000000", session_id: sessionId,
});

function makeCtx() {
	const c = new QueryContext();
	const events = [];
	c.currentPiStream = { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(model);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, model, () => false, c);
}

const contentTypes = (c) => c.turnOutput.content.map((b) => b.type);

describe("a refused API message retried on the fallback model", () => {
	afterEach(() => { __test.setPiUI(null); });

	it("leaves only the retry in the pi turn, recorded under the model that served it", async () => {
		const c = makeCtx();
		await consume(c, [
			start("claude-opus-5-5"), ...thinking(0, "refused partial"), ...stop("refusal"),
			start("claude-opus-5"), ...thinking(0, "retry thinking"), ...text(1, "retry reply"), ...stop("end_turn"),
		]);

		assert.deepEqual(contentTypes(c), ["thinking", "text"], "the refused partial must not stay ahead of the retry");
		assert.equal(c.turnOutput.content[0].thinking, "retry thinking");
		assert.equal(c.turnOutput.model, "claude-opus-5", "pi must record the model that answered, not the one it asked for");
		assert.equal(c.turnOutput.stopReason, "stop");
	});

	it("never ends the pi turn on a tool call Claude Code withdrew", async () => {
		const c = makeCtx();
		await consume(c, [start("claude-opus-5-5"), ...toolUse(0, "toolu_refused"), ...stop("refusal")]);

		const terminal = c.currentPiStream.events.filter((e) => e.type === "done" || e.type === "end");
		assert.deepEqual(terminal, [], "ending here has pi run the refused call");
		assert.deepEqual(c.turnOutput.content, []);
		assert.equal(c.turnSawToolCall, false);
		assert.deepEqual(c.turnToolCallIds, [], "a withdrawn call id must not route tool results");

		await consume(c, [start("claude-opus-5"), ...toolUse(0, "toolu_retry"), ...stop("tool_use")]);
		assert.deepEqual(c.turnOutput.content.map((b) => b.id), ["toolu_retry"]);
		assert.ok(c.currentPiStream === null, "the retry's tool call ends the turn as usual");
	});

	it("drops an API message that never finished when the next one starts", async () => {
		const c = makeCtx();
		await consume(c, [
			start("claude-opus-5-5"), ...text(0, "cut off"),
			start("claude-opus-5-5"), ...text(0, "complete"), ...stop("end_turn"),
		]);

		assert.deepEqual(c.turnOutput.content.map((b) => b.text), ["complete"]);
	});

	it("keeps every block of an ordinary turn", async () => {
		const c = makeCtx();
		await consume(c, [start("claude-opus-5-5"), ...thinking(0, "plan"), ...text(1, "answer"), ...stop("end_turn")]);

		assert.deepEqual(contentTypes(c), ["thinking", "text"]);
		assert.equal(c.turnOutput.model, "claude-opus-5-5");
	});
});

describe("the fallback notice", () => {
	afterEach(() => { __test.setPiUI(null); });

	// It comes after the retry's tool call has already ended the pi stream, so it
	// has to be read even with no stream to write to.
	it("tells the user once per Claude Code session, even after the pi stream ended", async () => {
		const notices = [];
		__test.setPiUI({ notify: (message, level) => notices.push({ message, level }) });
		const c = makeCtx();
		c.currentPiStream = null;
		await consume(c, [fallbackNotice("session-a"), fallbackNotice("session-a")]);

		assert.equal(notices.length, 1);
		assert.equal(notices[0].level, "warning");
		assert.match(notices[0].message, /claude-opus-5-5 的回复（reasoning_extraction）/);
		assert.match(notices[0].message, /已换成 claude-opus-5。/);
	});

	it("stays quiet when only a Claude Code subagent fell back", async () => {
		const notices = [];
		__test.setPiUI({ notify: (message) => notices.push(message) });
		await consume(makeCtx(), [fallbackNotice("session-b", "local")]);

		assert.deepEqual(notices, []);
	});
});

describe("servedModelId", () => {
	it("keeps pi's id for the model it asked for, dated snapshots included", () => {
		assert.equal(servedModelId("claude-opus-5-5", "claude-opus-5-5"), "claude-opus-5-5");
		assert.equal(servedModelId("claude-haiku-4-5-20251001", "claude-haiku-4-5"), "claude-haiku-4-5");
	});

	it("records another model under its own id", () => {
		assert.equal(servedModelId("claude-opus-5", "claude-opus-5-5"), "claude-opus-5");
		assert.equal(servedModelId("claude-opus-5-5", "claude-opus-5"), "claude-opus-5-5");
	});
});
