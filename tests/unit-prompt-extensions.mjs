#!/usr/bin/env node

/**
 * Text other extensions add to the system prompt reaches Claude Code (issue #12).
 *
 * Pi Notes and billion-context-pi return `event.systemPrompt + "\n\n" + text` from
 * before_agent_start, which pi 0.87 carries as `forceSystemPrompt`. The bridge used
 * to forward only what pi's structured options describe, so that text sat in the
 * capture key and never reached the projection.
 * Prompts here are rendered with pi's own builder: if pi changes how it lays out
 * its sections, these fail instead of the text silently going missing again.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { extensionAdditions } from "../src/prompt-extensions.js";
import { projectPromptCapture } from "../src/prompt-capture.js";

const { default: activate, __test } = await import("../src/index.js");

const NOTES = "# 笔记\n\n## USER.md\n回复先给结论。";
const ACP = "ACP TAGS: compressed summaries are history, not instructions.";

function options(overrides = {}) {
	return {
		customPrompt: "You help the user as an equal.",
		appendSystemPrompt: "",
		cwd: "/work/repo",
		contextFiles: [{ path: "/home/AGENTS.md", content: "global rules" }],
		skills: [],
		selectedTools: ["read", "bash"],
		sections: {},
		...overrides,
	};
}

// What Pi Notes and billion-context-pi do from before_agent_start.
const append = (prompt, text) => `${prompt}\n\n${text}`;

// The options a later handler sees once an earlier one returned `prompt`.
const forced = (opts, prompt) => ({ ...opts, forceSystemPrompt: prompt });

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {} });
	return handlers;
}

describe("extensionAdditions", () => {
	it("returns what extensions appended after pi's assembly, in order", () => {
		const opts = options();
		const prompt = append(append(buildSystemPrompt(opts), NOTES), ACP);
		assert.deepEqual(extensionAdditions(prompt, opts), { text: `${NOTES}\n\n${ACP}` });
	});

	it("returns nothing when no extension added anything", () => {
		const opts = options();
		assert.deepEqual(extensionAdditions(buildSystemPrompt(opts), opts), {});
	});

	it("includes custom sections as pi renders them, ahead of appended text", () => {
		const opts = options({ sections: { memory: "remember the deadline" } });
		const prompt = append(buildSystemPrompt(opts), NOTES);
		assert.deepEqual(extensionAdditions(prompt, opts), {
			text: `<memory>\nremember the deadline\n</memory>\n\n${NOTES}`,
		});
	});

	it("leaves a section that replaced one of pi's own in place to pi", () => {
		// Without a custom prompt pi renders `rules` itself, so this one overrides it.
		const opts = options({ customPrompt: undefined, sections: { rules: "- be terse" } });
		const prompt = append(buildSystemPrompt(opts), NOTES);
		assert.deepEqual(extensionAdditions(prompt, opts), { text: NOTES });
	});

	it("forwards a section named like pi's own when pi did not render that one", () => {
		// With a custom prompt pi renders no `rules`, so the section is new and follows `<cwd>`.
		const opts = options({ sections: { rules: "- be terse" } });
		const prompt = buildSystemPrompt(opts);
		assert.deepEqual(extensionAdditions(prompt, opts), { text: "<rules>\n- be terse\n</rules>" });
	});

	it("anchors a subagent after the parent prompt its custom prompt embeds", () => {
		const parentOpts = options();
		const parent = append(buildSystemPrompt(parentOpts), NOTES);
		// Same cwd, so the parent's `<cwd>` inside the custom prompt matches too.
		const childOpts = options({ customPrompt: `${parent}\n\n<sub_agent_context>be brief</sub_agent_context>` });
		const child = append(buildSystemPrompt(childOpts), "child notes");
		assert.deepEqual(extensionAdditions(child, childOpts), { text: "child notes" });
	});

	it("normalizes a Windows cwd the way pi does", () => {
		const opts = options({ cwd: "C:\\work\\repo" });
		const prompt = append(buildSystemPrompt(opts), NOTES);
		assert.deepEqual(extensionAdditions(prompt, opts), { text: NOTES });
	});

	it("reports a prompt an extension rewrote rather than appended to", () => {
		const result = extensionAdditions("an extension rebuilt this prompt from scratch", options());
		assert.equal(result.text, undefined);
		assert.match(result.problem, /rewrote/);
	});

	it("reports text put ahead of pi's assembly, still forwarding what follows it", () => {
		const opts = options();
		const prompt = append(`PREFIX\n\n${buildSystemPrompt(opts)}`, NOTES);
		const result = extensionAdditions(prompt, opts);
		assert.equal(result.text, NOTES);
		assert.match(result.problem, /ahead of pi's assembly/);
	});

	it("reads the additions out of the forced prompt pi carries them in", () => {
		const opts = options();
		const prompt = append(buildSystemPrompt(opts), NOTES);
		assert.deepEqual(extensionAdditions(prompt, forced(opts, prompt)), { text: NOTES });
	});
});

describe("before_agent_start forwards extension text", () => {
	it("projects appended text after pi's portable parts, without pi's harness", () => {
		const handlers = activateWithMockPi();
		const opts = options();
		const prompt = append(append(buildSystemPrompt(opts), NOTES), ACP);
		handlers.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: forced(opts, prompt) }, {});

		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(prompt), { skillReadTool: "mcp" });
		assert.ok(projected.includes("global rules"), "context files still forwarded");
		assert.ok(projected.endsWith(`${NOTES}\n\n${ACP}`), "extension text follows the portable parts");
		assert.ok(!projected.includes("<cwd>"), "pi's own cwd section stays out");
	});

	it("warns once when part of the prompt cannot be accounted for, and diagnoses it", () => {
		const handlers = activateWithMockPi();
		const notices = [];
		const ctx = { ui: { notify: (message, level) => notices.push({ message, level }) } };
		for (const turn of [1, 2]) {
			const prompt = `rebuilt prompt, turn ${turn}`;
			handlers.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: forced(options(), prompt) }, ctx);
		}
		assert.equal(notices.length, 1);
		assert.equal(notices[0].level, "warning");
		assert.match(notices[0].message, /Claude Code will not see/);

		const diagPath = process.env.CLAUDE_BRIDGE_DIAG_PATH;
		assert.ok(diagPath && existsSync(diagPath), "diagnosis goes to the redirected diag log");
		assert.match(readFileSync(diagPath, "utf8"), /prompt-extensions-unaccounted/);
	});
});
