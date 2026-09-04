#!/usr/bin/env node

/**
 * tool_call re-records the widened system prompt.
 *
 * agent_start captures the prompt at the top of a turn, but pi keeps widening it
 * mid-turn as MCP servers finish connecting. pi-subagents reads ctx.getSystemPrompt()
 * when it dispatches a subagent at the Agent tool_call — later than agent_start — so
 * that snapshot can be wider than what agent_start recorded. If only the agent_start
 * prompt is a capture key, a child embedding the tool_call-time prompt resolves
 * against nothing, falls to a verbatim side request, and ships pi's harness — tripping
 * the server's third-party plan-eligibility check ("out of extra usage").
 *
 * These pin that tool_call records ctx.getSystemPrompt(), so the later snapshot — and
 * a child embedding it — resolves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

const AT_AGENT_START = "You are pi.\n# Tools\n- read: Read a file\n\npi packages (docs/packages.md)";
// A later MCP server connected mid-turn, widening the tool list past agent_start.
const AT_TOOL_CALL = "You are pi.\n# Tools\n- read: Read a file\n- Agent: Launch a subagent ...\n- SubagentWorkflow: orchestrate many subagents ...\n\npi packages (docs/packages.md)";

describe("tool_call widened-prompt capture", () => {
	it("records the later mid-turn prompt so it resolves exactly", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: AT_AGENT_START, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => AT_AGENT_START });

		// The mid-turn widened prompt is not yet a key.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive(AT_TOOL_CALL),
			/no capture/,
			"the tool_call-time prompt must not resolve off the agent_start record alone",
		);

		handlers.get("tool_call")({}, { getSystemPrompt: () => AT_TOOL_CALL });
		assert.ok(
			__test.promptCaptures.resolveOrDerive(AT_TOOL_CALL),
			"after tool_call the mid-turn prompt resolves exactly",
		);
	});

	it("lets a child embedding the tool_call-time parent resolve by inheritance", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: AT_AGENT_START, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => AT_AGENT_START });
		handlers.get("tool_call")({}, { getSystemPrompt: () => AT_TOOL_CALL });

		// pi-subagents embeds the widened parent prompt verbatim as the child's prefix.
		const child = `${AT_TOOL_CALL}\n\n<sub_agent_context>be concise</sub_agent_context>\n\n<active_agent name="worker"/>`;
		assert.ok(
			__test.promptCaptures.resolveOrDerive(child),
			"child embedding the tool_call-time parent must resolve, not fall to a side request",
		);
	});
});
