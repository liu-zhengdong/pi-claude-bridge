/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 *
 * The child is also told WHICH pi session it belongs to: the process's TOP-LEVEL
 * pi session, captured at session_start and stamped as AGENT_SESSION_ID on every
 * child; it never lets a value already sitting in process.env through. That
 * inherited value is exactly the bug: pi-subagents runs children inside the
 * parent's process, another extension used to write the child's id into the
 * shared process.env, and every Claude Code child the parent spawned afterwards
 * announced itself as the subagent's.
 *
 * The module is cached per cwd and shared by every extension instance in the
 * process, so the capture rule has to be selective rather than last-write-wins —
 * an in-process child session (always reason "startup") must not overwrite the
 * top-level id. The two session_start tests below therefore share module state
 * and MUST stay in this order: the first one needs a virgin, uncaptured module.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// activate() loads the user's real ~/.pi/agent/claude-bridge.json. Whenever
// askClaude.enabled is true there, activate() reaches pi.registerTool(), which
// the mock `pi` below doesn't provide, and the session_start test would fail
// for a reason that has nothing to do with childEnv or session identity. Point
// loadConfig at an empty, unwritten directory so this file's activate() calls
// see no config, matching a machine with the default (askClaude disabled).
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Same disposal as tests/lib/setup.mjs: the directory is this process's alone,
// so clean it up when the process ends rather than leaving one per test run.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

const ctxFor = (id) => ({ ui: null, mode: "interactive", sessionManager: { getSessionId: () => id } });

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, and muster hooks", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			MUSTER_HOOK_DISABLE: "1",
		});
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// referencing childEnv() are the guard, and a fourth is a review question.

	it("stamps the captured session id regardless of what the host env says", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSION_ID: "stale-from-a-subagent" };
		const env = __test.childEnv(base, "01a08409-parent");
		assert.equal(env.AGENT_SESSION_ID, "01a08409-parent");
		assert.equal(env.PATH, "/usr/bin");
		assert.equal(env.MUSTER_HOOK_DISABLE, "1", "CC_CHILD_ENV still applies");
	});

	it("does not let an inherited id through when nothing was captured", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSION_ID: "stale-from-a-subagent" };
		const env = __test.childEnv(base, undefined);
		assert.ok("AGENT_SESSION_ID" in env, "key is present so spawn unsets it");
		assert.equal(env.AGENT_SESSION_ID, undefined);
	});

	it("treats an empty captured id as none", () => {
		const env = __test.childEnv({ AGENT_SESSION_ID: "stale" }, "");
		assert.equal(env.AGENT_SESSION_ID, undefined);
	});

	it("treats a whitespace-only captured id as none", () => {
		const env = __test.childEnv({ AGENT_SESSION_ID: "stale" }, "  \t\n ");
		assert.ok("AGENT_SESSION_ID" in env, "key is present so spawn unsets it");
		assert.equal(env.AGENT_SESSION_ID, undefined);
	});

	it("never mutates the base environment", () => {
		const base = { AGENT_SESSION_ID: "stale" };
		__test.childEnv(base, "fresh");
		assert.equal(base.AGENT_SESSION_ID, "stale");
	});

	it("keeps CC_CHILD_ENV authoritative over both base and identity", () => {
		const env = __test.childEnv({ DISABLE_AUTO_COMPACT: "0" }, "x");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	});

	// The two tests below share the module-level capture and run in declaration
	// order; this one must come first, while nothing has been captured yet.
	it("keeps the top-level session when a second instance starts an in-process child", () => {
		// Two activations, one process: pi caches the module per cwd and re-invokes
		// only the factory for an in-process child session, so both instances write
		// the same module-level variable. Both sessions start with reason "startup",
		// which is how a subagent's id used to clobber the parent's.
		const parent = activateWithMockPi();
		const child = activateWithMockPi();

		parent.get("session_start")({ reason: "startup" }, ctxFor("parent"));
		assert.equal(__test.piSessionId(), "parent", "the process's first startup is the top-level session");

		child.get("session_start")({ reason: "startup" }, ctxFor("child"));
		assert.equal(__test.piSessionId(), "parent", "an in-process child's startup must not overwrite it");

		const env = __test.childEnv({ PATH: "/usr/bin", AGENT_SESSION_ID: "child" }, __test.piSessionId());
		assert.equal(env.AGENT_SESSION_ID, "parent", "children spawned during the subagent still say parent");
	});

	it("re-captures when the top-level session id changes, but never on a later startup", () => {
		const handlers = activateWithMockPi();

		handlers.get("session_start")({ reason: "new" }, ctxFor("second"));
		assert.equal(__test.piSessionId(), "second", "/new mints a new id and the capture follows it");

		handlers.get("session_start")({ reason: "resume" }, ctxFor("third"));
		assert.equal(__test.piSessionId(), "third");

		handlers.get("session_start")({ reason: "fork" }, ctxFor("fourth"));
		assert.equal(__test.piSessionId(), "fourth");

		handlers.get("session_start")({ reason: "startup" }, ctxFor("late"));
		assert.equal(__test.piSessionId(), "fourth", "a later startup is an in-process child, not the top level");
	});
});
