#!/usr/bin/env node

// A child Pi session evaluates the bridge extension again, but streamSimple
// forwards to the first instance so the in-flight query and tool results stay
// together. Its capture must reach that first instance too: otherwise a skill
// added by resource discovery makes the child's prompt unresolvable there.
import { it } from "node:test";
import assert from "node:assert/strict";
import { projectPromptCapture } from "../src/prompt-capture.js";

const owner = await import("../src/prompt-record.js");
const child = await import("../src/prompt-record.js?child-session");

it("resolves a child's changed skill list at the stream owner without forwarding Pi's harness", () => {
	const base = "You are pi.\n<skills>obsidian-bases</skills>";
	const childCustom = `Child task: inherit parent instructions.\n${base}`;
	const withDiscoveredSkill = `${childCustom}\n<skills>ego-browser, obsidian-bases</skills>`;
	const skill = {
		name: "ego-browser", description: "Browser operations", filePath: "/skills/ego-browser/SKILL.md",
		baseDir: "/skills/ego-browser", sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
	};
	owner.createPromptRecorder().recordAssembled(base, {
		contextFiles: [{ path: "/parent/AGENTS.md", content: "parent rules" }], skills: [],
	});
	child.createPromptRecorder().recordAssembled(withDiscoveredSkill, {
		customPrompt: childCustom,
		contextFiles: [{ path: "/child/AGENTS.md", content: "child rules" }], skills: [skill],
	});

	const resolved = owner.promptCaptures.resolveOrDerive(withDiscoveredSkill);
	const projected = projectPromptCapture(resolved, { skillReadTool: "mcp" });
	assert.match(projected, /parent rules/);
	assert.match(projected, /child rules/);
	assert.match(projected, /ego-browser/);
	assert.doesNotMatch(projected, /You are pi/);
});
