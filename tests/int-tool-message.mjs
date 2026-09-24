#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { getProjectDir } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 40_000;

const harness = createRpcHarness({
	name: "tool-message",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("tool-message integration", () => {
	const { startAndWait, stop, send, addListener, waitForEvent, waitForMatch, collectText, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	// The debug log accumulates across tests in this file (one pi process), so
	// scope assertions to the bytes a single test wrote.
	const logMark = () => statSync(DEBUG_LOG).size;
	const logSince = (mark) => readFileSync(DEBUG_LOG, "utf8").slice(mark);

	/** Session id of the last query in a slice of the debug log. Logged
	 *  abbreviated, which is enough to pick the file out of the project dir. */
	function sessionIdFrom(log) {
		const ids = [...log.matchAll(/query done, session=([0-9a-f]+)/g)].map((m) => m[1]);
		assert.ok(ids.length > 0, "no session id in debug log — the query never completed");
		const prefix = ids[ids.length - 1];
		const dir = getProjectDir(harness.DIR);
		const file = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));
		assert.ok(file, `no session file for ${prefix} in ${dir}`);
		return `${dir}/${file}`;
	}

	/** CC's session transcript as parsed JSONL records, in write order. */
	function readSessionRecords(path) {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	}

	// --- Lifecycle ---

	before(async () => {
		await startAndWait();
	});

	afterEach(async () => {
		if (harness.pi().exitCode !== null) {
			await startAndWait();
		}
	});

	after(async () => {
		await stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- Tests ---

	it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
		);
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("followUp during tool execution delivers after tool completes", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		// followUp is queued by pi until the current turn finishes
		await send({
			type: "prompt",
			message: "This is a followUp during tool execution.",
			streamingBehavior: "followUp",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("steer during tool execution still delivers tool result", { timeout: 15_000 }, async () => {
		// Issue #3: steer injects a user message into the context during an active
		// tool call. extractAllToolResults stops at the user message and returns 0
		// results, leaving the pending handler stuck.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer message during tool execution.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("parallel tool calls with steer delivers all results", { timeout: TEST_TIMEOUT }, async () => {
		const mark = logMark();
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
		});
		// Wait for at least one tool to start, then inject steer
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer during parallel tool execution. IMPORTANT: also say the exact word 'PAPAYA' on its own line in your response.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		// All three tools should have their results in the response
		const matches = (text.match(/slowtool completed/gi) || []).length;
		assert.ok(matches >= 3, `Expected 3 SlowTool results, found ${matches}: ${text.slice(0, 300)}`);
		// Assert CC received the steer, not that Haiku obeyed it: CC presents a
		// queued_command next to tool results, which the model can mistake for an
		// injection and legitimately decline. A dropped steer has no attachment.
		const records = readSessionRecords(sessionIdFrom(logSince(mark)));
		const steerAt = records.findIndex((r) => r.attachment?.type === "queued_command"
			&& JSON.stringify(r.attachment.prompt ?? "").includes("PAPAYA"));
		assert.notEqual(steerAt, -1, "parallel tool steer never reached CC as a queued command");
		assert.ok(records.slice(steerAt).some((r) => r.type === "assistant"),
			"CC never responded after receiving the parallel-tool steer");
	});

	it("steer during text response (no tool call) completes both turns", { timeout: TEST_TIMEOUT }, async () => {
		// Steer during text-only streaming: the assistant is generating text (no tool
		// calls), a steer arrives, and pi delivers it after the current turn ends.
		// Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
		// for the steer, the bridge enters the tool-result-delivery path incorrectly.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write exactly 12 short numbered sentences about the history of computing, from Babbage to modern times. Do NOT call any tools.",
		});
		// Wait until text is actually streaming before injecting the steer
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /pineapple/);
	});

	it("steer during tool execution reaches CC", { timeout: 20_000 }, async () => {
		// At the tool boundary Pi injects the steer alongside the tool result.
		// Confirm CC received it, not that the model chose to say the magic word.
		const mark = logMark();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const records = readSessionRecords(sessionIdFrom(logSince(mark)));
		const steerAt = records.findIndex((r) => r.attachment?.type === "queued_command"
			&& JSON.stringify(r.attachment.prompt ?? "").includes("MANGO"));
		assert.notEqual(steerAt, -1, "steer never reached CC after the tool call");
		assert.ok(records.slice(steerAt).some((r) => r.type === "assistant"),
			"CC never responded after the steer");
	});

	it("steer is drained at the tool boundary, mid-turn", { timeout: 90_000 }, async () => {
		// The point of the whole steering fix, and the tripwire for the CC CLI
		// internals it rests on.
		//
		// Proof has to be structural, from CC's own session transcript — model
		// output doesn't discriminate. Under the *old* defer-and-replay behavior
		// Claude also ended up obeying the steer, just a turn later, so "it said
		// the magic word" passes either way. What only mid-turn steering produces
		// is a `queued_command` attachment sitting between the tool result and the
		// next assistant message: CC drained the steer at the tool boundary,
		// before the next API round-trip. A steer that lost the stdin race instead
		// lands after that assistant message, and a replayed one is a plain user
		// prompt with no attachment at all.
		const mark = logMark();
		const steerText = "STOP. Do not call SlowTool again. Reply with only the word BANANA.";

		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=1 exactly 4 times, strictly one at a time — wait for each result before starting the next. Do not call it twice in the same message.",
		});
		await waitForEvent("tool_execution_start");
		await send({ type: "prompt", message: steerText, streamingBehavior: "steer" });
		await waitForEvent("agent_end");

		const records = readSessionRecords(sessionIdFrom(logSince(mark)));
		const steerAt = records.findIndex((r) => r.attachment?.type === "queued_command"
			&& JSON.stringify(r.attachment.prompt ?? "").includes("Do not call SlowTool again"));
		assert.notEqual(steerAt, -1, "steer never reached CC as a queued command — it was replayed as a follow-up");

		const toolResultAt = records.findLastIndex((r, i) => i < steerAt
			&& JSON.stringify(r.message?.content ?? "").includes('"tool_result"'));
		assert.notEqual(toolResultAt, -1, "no tool result before the steer — test did not reach a tool boundary");
		const between = records.slice(toolResultAt + 1, steerAt).filter((r) => r.type === "assistant");
		assert.equal(between.length, 0,
			`steer was drained after the turn continued (${between.length} assistant message(s) between tool result and steer) — it lost the stdin race`);
		assert.ok(records.slice(steerAt).some((r) => r.type === "assistant"),
			"CC never responded after draining the steer");

		// This proves when CC received the steer, not whether the model chose to obey it.
		// Haiku may run all four calls even with the queued command at the right boundary.
	});

	it("steer at a text-only boundary is not pushed into the active query", { timeout: TEST_TIMEOUT }, async () => {
		// A steer at the end of a text-only turn can race the clearing of
		// activeQuery and be routed as a reentrant user query. It cannot be pushed
		// into the previous query: there is no tool boundary to steer at, and that
		// query's input generator has already been ended.
		//
		// This asserts only that no push is attempted. Landing as a reentrant query
		// is not itself safe — syncSharedSession takes the REUSE path and a second
		// CC process --resumes the session while the first is still flushing its
		// transcript. That race predates mid-turn steering and is untested here.
		//
		// Routing makes this unreachable today (no tool results ⇒ no delivery
		// path), and the race itself is timing-dependent, so read this as a
		// tripwire against a future change that starts pushing text-only steers —
		// not as proof the race is handled.
		const mark = logMark();
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write exactly 12 short numbered sentences about the history of computing. Do NOT call any tools.",
		});
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'KIWI' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		const log = logSince(mark);

		assert.match(text.toLowerCase(), /kiwi/);
		assert.doesNotMatch(log, /steer written to CC stdin/, "text-only steer was pushed into the active query's input stream");
		assert.doesNotMatch(log, /steer push rejected/, "text-only steer reached the push path at all");
	});

	it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=30.",
		});
		await waitForEvent("tool_execution_start");
		const idle = waitForEvent("agent_end");
		await send({ type: "abort" });
		await idle;
		// Next prompt should work without hanging
		const text = await promptAndWait("Reply with just the word 'recovered'.");
		assert.match(text.toLowerCase(), /recovered/);
	});
});
