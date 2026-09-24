/* Ordered message identities: a live query can continue only when the pi
 * history it already saw is still an exact prefix of the next request. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { historyIdentities, historyRewritten } = await import("../src/pi-context.js");

const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const answer = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const call = (id, timestamp, extra = []) => ({
	role: "assistant",
	content: [...extra, { type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
	timestamp,
});
const result = (id, text, timestamp) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp });

const history = [
	user("Remember APPLE.", 1),
	answer("OK", 2),
	user("List the files.", 3),
	call("t1", 4, [{ type: "thinking", thinking: "run ls", thinkingSignature: "sig" }]),
	result("t1", "a.txt\nb.txt", 5),
];

describe("historyRewritten", () => {
	it("keeps one ordered identity per message, including user messages and tool calls", () => {
		assert.deepEqual(historyIdentities(history), ["user:1", "assistant:2:", "user:3", "assistant:4:t1", "result:t1:5"]);
	});

	it("is false for an appended tool round", () => {
		const next = [...history, call("t2", 6), result("t2", "done", 7)];
		assert.equal(historyRewritten(historyIdentities(history), next), false);
	});

	it("detects compaction of a tool round and a plain exchange", () => {
		const replacedTool = [history[0], history[1], user("[Summary] Listed the files.", 8), call("t2", 6), result("t2", "done", 7)];
		const replacedPlain = [user("[Summary] APPLE.", 8), ...history.slice(2)];
		assert.equal(historyRewritten(historyIdentities(history), replacedTool), true);
		assert.equal(historyRewritten(historyIdentities(history), replacedPlain), true);
	});

	it("detects a removed tool call on the same assistant message", () => {
		const stripped = [...history.slice(0, 3), { ...history[3], content: history[3].content.filter((b) => b.type !== "toolCall") }, history[4]];
		assert.equal(historyRewritten(historyIdentities(history), stripped), true);
	});

	it("detects a same-length user replacement, reorder, and duplicate", () => {
		const replaced = [user("A different turn", 12), ...history.slice(1)];
		const reordered = [history[0], history[3], history[2], history[1], history[4]];
		const duplicated = [history[0], history[1], history[2], history[3], history[3]];
		for (const candidate of [replaced, reordered, duplicated]) {
			assert.equal(historyRewritten(historyIdentities(history), candidate), true);
		}
	});

	it("detects a transient note that was handed to the live query and later vanishes", () => {
		const seen = [...history, user("<system-reminder>compress soon</system-reminder>", 6)];
		const next = [...history, call("t2", 7), result("t2", "done", 8)];
		assert.equal(historyRewritten(historyIdentities(seen), next), true);
	});

	it("allows output truncation and thinking removal without changing identity", () => {
		const edited = history.map((m) => {
			if (m.role === "assistant") return { ...m, content: m.content.filter((b) => b.type !== "thinking") };
			if (m.role === "toolResult") return { ...m, content: [{ type: "text", text: "[output truncated]" }] };
			return m;
		});
		assert.equal(historyRewritten(historyIdentities(history), edited), false);
	});

	it("allows an empty prefix", () => {
		assert.equal(historyRewritten([], [user("hi", 1)]), false);
	});
});
