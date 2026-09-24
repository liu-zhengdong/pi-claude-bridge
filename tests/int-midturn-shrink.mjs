#!/usr/bin/env node
// Issue #21: an extension that compacts through the `context` hook (ACP) between
// two tool calls of one turn. The live Claude Code query used to take the tool
// result and carry on with the history it already held, so the compaction only
// reached Claude Code when the user spoke next.
//
// Verifies the turn instead moves to a session rebuilt from the shortened history,
// in the same turn: the dropped exchange is gone from the session Claude Code
// resumes and from the size of its next request, the turn still finishes, the next
// turn resumes the rebuilt session as is, and nothing is left behind.
//
// Size, not the model's answer, is the check within the turn: thinking written
// before the tool call belongs to the turn being continued and stays in the rebuilt
// session, so a model that recalled the dropped exchange there still knows it.

console.log("=== int-midturn-shrink.mjs ===");

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const FLAG = join(tmpdir(), `int-midturn-shrink-${process.pid}.flag`);
// Makes the dropped exchange worth several thousand tokens, well clear of the
// few hundred the handover itself adds to the next request.
const FILLER = Array.from({ length: 3000 }, (_, i) => i).join(" ");
const MIN_DROP = 2000;

const harness = createRpcHarness({
	name: "midturn-shrink",
	args: ["-e", resolve(DIR, "tests/fixtures/shrink-context-extension.ts"), "--model", BRIDGE_MODEL],
	env: { SHRINK_CONTEXT_FLAG: FLAG },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

/** Input tokens of each request in `log`: new, cache-read and cache-written together. */
function requestSizes(log) {
	return [...log.matchAll(/usage: in=(\d+) out=\d+ cacheRead=(\d+) cacheWrite=(\d+)/g)]
		.map((m) => Number(m[1]) + Number(m[2]) + Number(m[3]));
}

rmSync(FLAG, { force: true });
await startAndWait();

try {
	// The extension drops the first two messages: this exchange.
	console.log("Turn 1: the exchange that will be dropped...");
	await promptAndWait(`The provisional project name is APPLE. The raw data for this project is: ${FILLER}\nPlease acknowledge briefly.`);
	console.log("Turn 2: the exchange that stays...");
	await promptAndWait("The final project name is BANANA. Please acknowledge briefly.");

	const mark = readFileSync(DEBUG_LOG, "utf8").length;

	// The bash call switches the extension on, so the request carrying its result is
	// the first to come back without the APPLE exchange: mid-turn, after a tool call.
	console.log("Turn 3: tool call, then the history shrinks under the live query...");
	const reply = await promptAndWait(`Create an empty marker file with the bash tool: touch ${FLAG}\nThen confirm that it was created.`);
	console.log(`  Reply: ${JSON.stringify(reply.trim())}`);

	const log = readFileSync(DEBUG_LOG, "utf8").slice(mark);
	const handoverAt = log.indexOf("handing the turn to a rebuilt session");
	if (handoverAt === -1) throw new Error("no handover logged — the tool result went into the live query that still held APPLE");
	const afterHandover = log.slice(handoverAt);
	const path = /syncResult: path=(\S+)/.exec(afterHandover)?.[1];
	if (path !== "rebuild") throw new Error(`the handover's fresh query took syncResult path=${path ?? "(none)"} — expected rebuild`);

	const jsonlPath = /jsonlPath=(\S+)/.exec(afterHandover)?.[1];
	if (!jsonlPath) throw new Error("no jsonlPath logged for the rebuilt session");
	const rebuilt = readFileSync(jsonlPath, "utf8");
	if (rebuilt.includes("provisional project name is APPLE")) throw new Error("the rebuilt session still holds the exchange the extension dropped (APPLE)");
	if (!rebuilt.includes("final project name is BANANA")) throw new Error("the rebuilt session lacks the exchange the extension kept (BANANA)");
	if (!rebuilt.includes(FLAG)) throw new Error("the rebuilt session lacks the bash call it continues from");

	const before = requestSizes(log.slice(0, handoverAt)).at(-1);
	const after = requestSizes(afterHandover)[0];
	console.log(`  Request size: ${before} before the handover, ${after} after`);
	if (before === undefined || after === undefined) throw new Error("usage not logged on both sides of the handover");
	if (before - after < MIN_DROP) throw new Error(`the request after the handover is not smaller by the dropped exchange: ${before} → ${after}`);

	if (!/creat|done|success|已创建|完成|成功/i.test(reply)) throw new Error(`the turn did not finish in the rebuilt session: ${JSON.stringify(reply)}`);

	const warnings = log.split("\n").filter((line) => /WARNING|BUG:/.test(line));
	if (warnings.length > 0) throw new Error(`warnings during the handover turn:\n${warnings.join("\n")}`);

	// The rebuilt session is the shared one now: the next turn resumes it as is.
	const mark4 = readFileSync(DEBUG_LOG, "utf8").length;
	console.log("Turn 4: the next turn after the handover...");
	const reply4 = await promptAndWait("What is the final project name? Answer with just the name.");
	console.log(`  Reply: ${JSON.stringify(reply4.trim())}`);
	const log4 = readFileSync(DEBUG_LOG, "utf8").slice(mark4);
	const path4 = /syncResult: path=(\S+)/.exec(log4)?.[1];
	if (path4 !== "reuse") throw new Error(`the turn after the handover took syncResult path=${path4 ?? "(none)"} — expected reuse of the rebuilt session`);
	if (log4.includes("handing the turn to a rebuilt session")) throw new Error("the turn after the handover handed over again");
	if (!/BANANA/i.test(reply4)) throw new Error(`the kept codeword is missing after the handover: ${JSON.stringify(reply4)}`);

	// reportLeaks runs on session_shutdown, so read the log once pi has exited.
	const exited = new Promise((r) => harness.pi().once("exit", r));
	await stop();
	await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
	const leaks = readFileSync(DEBUG_LOG, "utf8").split("\n").filter((line) => line.includes("left state behind"));
	if (leaks.length > 0) throw new Error(`state left behind at shutdown:\n${leaks.join("\n")}`);

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
