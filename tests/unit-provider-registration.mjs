#!/usr/bin/env node

/**
 * Every activation registers the provider; only the streamSimple is shared.
 *
 * pi's ModelRegistry is per session, so an activation that skipped
 * registerProvider left that session with no claude-bridge models at all —
 * models appearing in one session and missing in the next. What genuinely must
 * not be overwritten is the streamSimple function: a tool result has to reach
 * the instance holding the in-flight QueryContext, which is the instance that
 * registered first.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const { default: activate } = await import("../src/index.js");

function activateWithMockPi() {
	const registrations = [];
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (name, config) => registrations.push({ name, config }),
		registerTool: () => {},
	});
	return { registrations, handlers };
}

beforeEach(() => {
	globalThis[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
});

describe("provider registration", () => {
	it("registers the models on every activation, not only the first", () => {
		const first = activateWithMockPi();
		const second = activateWithMockPi();

		for (const [label, { registrations }] of [["first", first], ["second", second]]) {
			assert.equal(registrations.length, 1, `${label} activation must register the provider`);
			assert.equal(registrations[0].name, "claude-bridge");
			assert.ok(registrations[0].config.models.length > 0, `${label} activation must register models`);
			assert.equal(typeof registrations[0].config.refreshModels, "function", `${label} activation must wire the discovery hook`);
		}
		assert.deepEqual(
			second.registrations[0].config.models.map((model) => model.id),
			first.registrations[0].config.models.map((model) => model.id),
			"a later activation registers the same model list as the first",
		);
	});

	it("restores the registration list when nothing has been discovered", async () => {
		const { registrations } = activateWithMockPi();
		const restored = await registrations[0].config.refreshModels({ allowNetwork: false, signal: new AbortController().signal });
		assert.deepEqual(
			restored.map((model) => model.id),
			registrations[0].config.models.map((model) => model.id),
			"the restore phase serves exactly what was registered",
		);
	});

	it("routes a query to the instance that owns the in-flight state", () => {
		const calls = [];
		const owner = (model, context, options) => {
			calls.push({ model, context, options });
			return "owner-stream";
		};
		globalThis[ACTIVE_STREAM_SIMPLE_KEY] = owner;

		const { registrations } = activateWithMockPi();
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], owner, "a later activation must not seize ownership");

		const stream = registrations[0].config.streamSimple("model", "context", "options");
		assert.equal(stream, "owner-stream", "the registered streamSimple must forward to the owner");
		assert.deepEqual(calls, [{ model: "model", context: "context", options: "options" }]);
	});

	it("claims ownership when no instance holds it, and resolves the owner per call", () => {
		const { registrations } = activateWithMockPi();
		assert.equal(typeof globalThis[ACTIVE_STREAM_SIMPLE_KEY], "function", "the first activation claims ownership");

		// Resolution happens at call time, not at registration time: whoever holds
		// the global when the call lands serves it.
		globalThis[ACTIVE_STREAM_SIMPLE_KEY] = () => "later-owner";
		assert.equal(registrations[0].config.streamSimple(), "later-owner");
	});
});
