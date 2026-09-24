#!/usr/bin/env node
// Issue #16: an extension that compacts through the `context` hook (ACP) makes
// pi's own history shorter without emitting session_compact. The bridge used to
// take a context shorter than its cursor for a subagent's and served pi's next
// turn from an empty Claude Code session, so the model lost the conversation.
//
// Verifies that turn instead resumes a session rebuilt from the shortened history:
// the retained exchange is in it, and the dropped user's prompt is not.

console.log("=== int-context-shrink.mjs ===");

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const FLAG = join(tmpdir(), `int-context-shrink-${process.pid}.flag`);

const harness = createRpcHarness({
	name: "context-shrink",
	args: ["-e", resolve(DIR, "tests/fixtures/shrink-context-extension.ts"), "--model", BRIDGE_MODEL],
	env: { SHRINK_CONTEXT_FLAG: FLAG },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

rmSync(FLAG, { force: true });
await startAndWait();

try {
	console.log("Turn 1: first codeword...");
	await promptAndWait("Remember the codeword APPLE. Reply with just OK. Do not use the memory system.");
	console.log("Turn 2: second codeword...");
	await promptAndWait("Remember a second codeword, BANANA. Reply with just OK. Do not use the memory system.");

	// From here on the extension drops the first exchange (APPLE) from every request.
	writeFileSync(FLAG, "");
	const mark = readFileSync(DEBUG_LOG, "utf8").length;

	console.log("Turn 3: after the context shrank...");
	const reply = await promptAndWait("List every codeword you were asked to remember, comma-separated, nothing else.");
	console.log(`  Reply: ${JSON.stringify(reply.trim())}`);

	const log = readFileSync(DEBUG_LOG, "utf8").slice(mark);
	const paths = [...log.matchAll(/syncResult: path=(\S+)/g)].map((m) => m[1]);
	console.log(`  syncResults: ${JSON.stringify(paths)}`);
	if (paths[0] !== "rebuild") {
		throw new Error(`turn 3 took syncResult path=${paths[0] ?? "(none)"} — expected rebuild from the shortened history`);
	}

	const jsonlPath = /jsonlPath=(\S+)/.exec(log)?.[1];
	if (!jsonlPath) throw new Error("no jsonlPath logged for the rebuilt session");
	// Only what the rebuild wrote: the records before turn 3's own prompt.
	const records = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const promptIndex = records.findIndex((r) => r.type === "user" && JSON.stringify(r.message?.content ?? "").includes("List every codeword"));
	const rebuiltRecords = promptIndex === -1 ? records : records.slice(0, promptIndex);
	const rebuilt = JSON.stringify(rebuiltRecords);
	if (!rebuilt.includes("BANANA")) throw new Error("the rebuilt session lacks the exchange the extension kept (BANANA)");
	// Pi can retain references to APPLE inside the second assistant's thinking;
	// those remain authoritative history. Only the dropped user exchange must go.
	const userPrompts = rebuiltRecords.filter((r) => r.type === "user").map((r) => JSON.stringify(r.message?.content ?? ""));
	if (userPrompts.some((text) => text.includes("Remember the codeword APPLE"))) {
		throw new Error("the rebuilt session still holds the user exchange the extension dropped (APPLE)");
	}

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	rmSync(FLAG, { force: true });
	await stop();
}
