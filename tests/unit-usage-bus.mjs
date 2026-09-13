#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const usageBus = await import("../src/usage-bus.js");
const warningState = await import("../src/usage-warning-state.js");
const { default: activate, __test } = await import("../src/index.js");

const ACCOUNT_USAGE = {
	session: {
		total_cost_usd: 0,
		total_api_duration_ms: 0,
		total_duration_ms: 0,
		total_lines_added: 0,
		total_lines_removed: 0,
		model_usage: {},
	},
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 23.5, resets_at: "2026-09-13T05:00:00.000Z" },
		seven_day: { utilization: 41, resets_at: "2026-09-19T00:00:00.000Z" },
		model_scoped: [
			{ display_name: "Fable", utilization: 67, resets_at: "2026-09-20T00:00:00.000Z" },
		],
	},
	behaviors: null,
};

async function consume(messages) {
	const { QueryContext } = await import("../src/query-state.js");
	const c = new QueryContext();
	c.currentPiStream = { push() {}, end() {} };
	c.resetTurnState({ api: "claude-bridge", provider: "claude-bridge", id: "claude-fable-5-1" });
	async function* sdkMessages() {
		for (const message of messages) yield message;
	}
	await __test.consumeQuery(
		sdkMessages(),
		new Map(),
		{ api: "claude-bridge", provider: "claude-bridge", id: "claude-fable-5-1" },
		() => false,
		c,
	);
	return c;
}

function clearBus() {
	delete globalThis[BUS_SYMBOL];
}

function activateHarness() {
	const handlers = new Map();
	activate({
		on(event, handler) { handlers.set(event, handler); },
		registerProvider() {},
		registerTool() {},
		appendEntry() {},
	});
	return handlers;
}

function sessionContext(cwd, sessionId) {
	return {
		cwd,
		mode: "rpc",
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		ui: { notify() {} },
	};
}

describe("Claude provider usage protocol", () => {
	it("normalizes SDK account and Fable model-scoped windows", () => {
		const capturedAt = Date.parse("2026-09-13T01:00:00.000Z");
		const snapshot = usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE, capturedAt);

		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.provider, "anthropic");
		assert.equal(snapshot.capturedAt, capturedAt);
		assert.deepEqual(snapshot.windows.slice(0, 2), [
			{
				id: "five_hour",
				label: "5h",
				usedPercent: 23.5,
				resetsAt: Date.parse("2026-09-13T05:00:00.000Z") / 1000,
				windowMinutes: 300,
				scope: { kind: "account" },
			},
			{
				id: "seven_day",
				label: "7d",
				usedPercent: 41,
				resetsAt: Date.parse("2026-09-19T00:00:00.000Z") / 1000,
				windowMinutes: 10_080,
				scope: { kind: "account" },
			},
		]);
		const fable = snapshot.windows.find((window) => window.scope.kind === "model");
		assert.ok(fable);
		assert.equal(fable.id, "model_scoped:fable");
		assert.equal(fable.label, "7d");
		assert.equal(fable.usedPercent, 67);
		assert.deepEqual(fable.scope, {
			kind: "model",
			modelIds: ["claude-fable-5-1", "claude-fable-5"],
			label: "Fable",
		});
	});

	it("registers the structural adapter when the bridge creates the bus", () => {
		clearBus();
		const refresh = async () => usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE);
		const unregister = usageBus.registerClaudeUsageAdapter(refresh);
		const bus = globalThis[BUS_SYMBOL];

		assert.equal(bus.version, 1);
		assert.deepEqual(bus.adapters().map(({ id, usageProvider, modelProviders }) => ({ id, usageProvider, modelProviders })), [
			{
				id: "schuettc.pi-claude-bridge",
				usageProvider: "anthropic",
				modelProviders: ["claude-bridge"],
			},
		]);
		assert.strictEqual(bus.adapters()[0].refresh, refresh);
		unregister();
		assert.deepEqual(bus.adapters(), []);
	});

	it("extension activation publishes its adapter and unregisters it on shutdown", () => {
		clearBus();
		const handlers = activateHarness();
		const bus = globalThis[BUS_SYMBOL];
		assert.equal(bus.adapters().length, 1);
		assert.equal(bus.adapters()[0].id, "schuettc.pi-claude-bridge");
		handlers.get("session_shutdown")();
		assert.deepEqual(bus.adapters(), []);
	});

	it("waits for the owning session_start when pi-usage refreshes first", async () => {
		clearBus();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-usage-owner-"));
		const agentDir = join(root, "agent");
		const ownerCwd = join(root, "owner");
		mkdirSync(join(ownerCwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(ownerCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: {
				autoMemoryEnabled: true,
				strictMcpConfig: false,
				pathToClaudeCodeExecutable: "/owner/claude",
			},
		}));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let queryInput;
		let usageCalls = 0;
		let handlers;
		try {
			__test.setUsageControlQuery((input) => {
				queryInput = input;
				return {
					async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
						usageCalls++;
						return ACCOUNT_USAGE;
					},
					close() {},
				};
			});
			handlers = activateHarness();
			const adapter = globalThis[BUS_SYMBOL].adapters()[0];
			await assert.rejects(adapter.refresh({ timeoutMs: 5 }), /timeout/i);
			const caller = new AbortController();
			const aborted = adapter.refresh({ timeoutMs: 1_000, signal: caller.signal });
			caller.abort(new Error("caller stopped before start"));
			await assert.rejects(aborted, /caller stopped before start/);

			const refreshing = adapter.refresh({ timeoutMs: 1_000 });
			await Promise.resolve();
			assert.equal(usageCalls, 0, "refresh must wait until the owner is ready");

			handlers.get("session_start")({ reason: "startup" }, sessionContext(ownerCwd, "owner-session"));
			const snapshot = await refreshing;
			assert.equal(snapshot.version, 1);
			assert.equal(queryInput.options.cwd, ownerCwd);
			assert.equal(queryInput.options.env.AGENT_SESSION_ID, "owner-session");
			assert.equal(queryInput.options.settings.autoMemoryEnabled, true);
			assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/owner/claude");
			assert.equal(queryInput.options.strictMcpConfig, false);
			assert.equal("extraArgs" in queryInput.options, false);
		} finally {
			handlers?.get("session_shutdown")();
			__test.setUsageControlQuery();
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps refresh bound to the owner after a child factory activates", async () => {
		clearBus();
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-usage-child-"));
		const agentDir = join(root, "agent");
		const ownerCwd = join(root, "owner");
		const childCwd = join(root, "child");
		for (const cwd of [ownerCwd, childCwd]) mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(ownerCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: { strictMcpConfig: false, pathToClaudeCodeExecutable: "/owner/claude" },
		}));
		writeFileSync(join(childCwd, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/child/claude" },
		}));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldCwd = process.cwd();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let ownerHandlers;
		try {
			let queryInput;
			__test.setUsageControlQuery((input) => {
				queryInput = input;
				return {
					async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return ACCOUNT_USAGE; },
					close() {},
				};
			});
			process.chdir(ownerCwd);
			ownerHandlers = activateHarness();
			ownerHandlers.get("session_start")({ reason: "startup" }, sessionContext(ownerCwd, "owner-session"));

			process.chdir(childCwd);
			const childHandlers = activateHarness();
			childHandlers.get("session_start")({ reason: "startup" }, sessionContext(childCwd, "child-session"));
			assert.equal(globalThis[BUS_SYMBOL].adapters().length, 1);
			await globalThis[BUS_SYMBOL].adapters()[0].refresh({ timeoutMs: 1_000 });

			assert.equal(queryInput.options.cwd, ownerCwd);
			assert.equal(queryInput.options.env.AGENT_SESSION_ID, "owner-session");
			assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/owner/claude");
			assert.equal(queryInput.options.strictMcpConfig, false);
		} finally {
			ownerHandlers?.get("session_shutdown")();
			__test.setUsageControlQuery();
			process.chdir(oldCwd);
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers into a compatible bus that existed before the bridge import", async () => {
		let adapter;
		let removed = false;
		const existing = {
			version: 1,
			register(value) { adapter = value; return () => { removed = true; }; },
			adapters() { return adapter ? [adapter] : []; },
			subscribe() { return () => {}; },
			publish() { return 0; },
		};
		globalThis[BUS_SYMBOL] = existing;
		const loadedAfterBus = await import(`../src/usage-bus.ts?existing-bus=${Date.now()}`);
		const refresh = async () => loadedAfterBus.snapshotFromClaudeUsage(ACCOUNT_USAGE);
		const unregister = loadedAfterBus.registerClaudeUsageAdapter(refresh);

		assert.strictEqual(globalThis[BUS_SYMBOL], existing);
		assert.equal(adapter.id, "schuettc.pi-claude-bridge");
		assert.equal(adapter.usageProvider, "anthropic");
		assert.deepEqual(adapter.modelProviders, ["claude-bridge"]);
		unregister();
		assert.equal(removed, true);
	});

	it("refresh invokes only the SDK usage control with an empty prompt and closes", async () => {
		let queryInput;
		let usageCalls = 0;
		let closeCalls = 0;
		let streamReads = 0;
		const sdkQuery = {
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
				usageCalls++;
				assert.deepEqual(options, { skipBehaviors: true });
				return ACCOUNT_USAGE;
			},
			close() { closeCalls++; },
			async interrupt() { throw new Error("refresh must not interrupt a successful request"); },
			async *[Symbol.asyncIterator]() {
				streamReads++;
				throw new Error("refresh must not consume an assistant stream");
			},
		};
		const queryFactory = (input) => { queryInput = input; return sdkQuery; };

		const snapshot = await __test.refreshClaudeUsage(
			{ timeoutMs: 1_000 },
			{
				query: queryFactory,
				cwd: "/tmp/usage-project",
				env: { HOME: "/tmp/home", AGENT_SESSION_ID: "session-1" },
				provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/mock/claude" },
			},
		);

		const prompts = [];
		for await (const prompt of queryInput.prompt) prompts.push(prompt);
		assert.deepEqual(prompts, [], "account refresh must not yield a completion prompt");
		assert.equal(queryInput.options.cwd, "/tmp/usage-project");
		assert.deepEqual(queryInput.options.env, { HOME: "/tmp/home", AGENT_SESSION_ID: "session-1" });
		assert.equal(queryInput.options.pathToClaudeCodeExecutable, "/mock/claude");
		assert.equal(queryInput.options.strictMcpConfig, true);
		assert.deepEqual(queryInput.options.extraArgs, { "strict-mcp-config": null });
		assert.deepEqual(queryInput.options.tools, []);
		assert.equal("settingSources" in queryInput.options, false, "refresh keeps normal provider settings sources");
		assert.equal(usageCalls, 1);
		assert.equal(streamReads, 0);
		assert.equal(closeCalls, 1);
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.provider, "anthropic");
	});

	it("refresh aborts on timeout and still closes the SDK query", async () => {
		let closeCalls = 0;
		let querySignal;
		const never = new Promise(() => {});
		const sdkQuery = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return never; },
			close() { closeCalls++; },
		};

		await assert.rejects(
			__test.refreshClaudeUsage(
				{ timeoutMs: 5 },
				{
					query(input) { querySignal = input.options.abortController.signal; return sdkQuery; },
					cwd: "/tmp/usage-project",
					env: {},
					provider: {},
				},
			),
			/timeout/i,
		);
		assert.equal(querySignal.aborted, true);
		assert.equal(closeCalls, 1);
	});

	it("refresh forwards caller aborts and still closes the SDK query", async () => {
		let closeCalls = 0;
		let querySignal;
		const caller = new AbortController();
		const sdkQuery = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return new Promise(() => {}); },
			close() { closeCalls++; },
		};
		const refreshing = __test.refreshClaudeUsage(
			{ timeoutMs: 1_000, signal: caller.signal },
			{
				query(input) { querySignal = input.options.abortController.signal; return sdkQuery; },
				cwd: "/tmp/usage-project",
				env: {},
				provider: {},
			},
		);
		caller.abort(new Error("caller cancelled"));
		await assert.rejects(refreshing, /caller cancelled/);
		assert.equal(querySignal.aborted, true);
		assert.equal(closeCalls, 1);
	});

	it("maps SDK statuses directly to snapshot, soft-warning, and hard-limit events", async () => {
		clearBus();
		const events = [];
		const unregister = usageBus.registerClaudeUsageAdapter(async () => usageBus.snapshotFromClaudeUsage(ACCOUNT_USAGE));
		const unsubscribe = globalThis[BUS_SYMBOL].subscribe((event) => events.push(event));
		try {
			await consume([
				{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.73, resetsAt: 1_800_000_000, rateLimitType: "five_hour" } },
				{ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.12, resetsAt: 1_800_001_000, rateLimitType: "five_hour" } },
				{ type: "rate_limit_event", rate_limit_info: { status: "rejected", utilization: 1, resetsAt: 1_800_002_000, rateLimitType: "five_hour" } },
			]);
		} finally {
			unsubscribe();
			unregister();
		}

		assert.deepEqual(events.map((event) => event.type), ["soft-warning", "snapshot", "hard-limit"]);
		assert.match(events[0].message, /73% used/);
		assert.equal(events[0].snapshot.windows[0].usedPercent, 73);
		assert.equal(events[1].snapshot.windows[0].usedPercent, 12);
		assert.match(events[2].message, /rate limited \(five_hour\)/);
		assert.equal(events[2].snapshot.windows[0].usedPercent, 100);
	});
});

describe("standalone provider warning policy", () => {
	it("persists before the first soft notification and suppresses later queries", () => {
		const order = [];
		const entries = [];
		const notifications = [];
		warningState.restoreStandaloneWarningState({ sessionManager: { getEntries: () => [] } });
		const context = {
			appendEntry(customType, data) { order.push("append"); entries.push({ customType, data }); },
			ui: { notify(message, level) { order.push("notify"); notifications.push({ message, level }); } },
		};
		const first = { version: 1, type: "soft-warning", provider: "anthropic", message: "first" };
		const second = { version: 1, type: "soft-warning", provider: "anthropic", message: "second" };

		warningState.notifyWithStandaloneSessionPolicy(first, context);
		warningState.notifyWithStandaloneSessionPolicy(second, context);

		assert.deepEqual(order, ["append", "notify"]);
		assert.deepEqual(notifications, [{ message: "first", level: "warning" }]);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].customType, "provider-usage:warning-v1");
		assert.equal(entries[0].data.provider, "anthropic");
		assert.equal(typeof entries[0].data.shownAt, "number");
	});

	it("routes query, reentrant, and subagent warnings through one session allowance", async () => {
		clearBus();
		const notifications = [];
		const markers = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { markers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => [] },
				ui: { notify(message) { notifications.push(message); } },
			},
			true,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});

		await consume([soft(0.51)]); // top-level query
		await consume([soft(0.62)]); // reentrant query
		await consume([soft(0.78)]); // simulated subagent query
		assert.equal(markers.length, 1);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /51% used/);
	});

	it("suppresses fallback when pi-usage left a valid handled marker", async () => {
		clearBus();
		const notifications = [];
		const markers = [];
		const sessionEntries = [
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "anthropic", shownAt: 1 } },
		];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { markers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);

		await consume([{
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization: 0.8, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		}]);
		assert.deepEqual(markers, []);
		assert.deepEqual(notifications, []);
	});

	it("falls back after a listener without a marker disappears", async () => {
		clearBus();
		const notifications = [];
		const sessionEntries = [];
		const markers = [];
		__test.beginStandaloneWarningSession(
			{
				appendEntry(customType, data) {
					markers.push({ customType, data });
					sessionEntries.push({ type: "custom", customType, data });
				},
			},
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});
		const unsubscribe = usageBus.getUsageBusV1().subscribe(() => { throw new Error("listener failed before persisting"); });
		await consume([soft(0.81)]);
		unsubscribe();
		await consume([soft(0.82)]);

		assert.equal(markers.length, 1);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /82% used/);
	});

	it("does not duplicate the normal listener path once its marker is durable", async () => {
		clearBus();
		const notifications = [];
		const sessionEntries = [];
		const bridgeMarkers = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry(customType, data) { bridgeMarkers.push({ customType, data }); } },
			{
				sessionManager: { getEntries: () => sessionEntries },
				ui: { notify(message) { notifications.push(message); } },
			},
			false,
		);
		const soft = (utilization) => ({
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed_warning", utilization, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		});
		let listenerEvents = 0;
		const unsubscribe = usageBus.getUsageBusV1().subscribe((event) => {
			if (event.type !== "soft-warning") return;
			listenerEvents++;
			sessionEntries.push({
				type: "custom",
				customType: "provider-usage:warning-v1",
				data: { provider: event.provider, shownAt: Date.now() },
			});
		});
		await consume([soft(0.83)]);
		unsubscribe();
		await consume([soft(0.91)]);

		assert.equal(listenerEvents, 1);
		assert.deepEqual(bridgeMarkers, []);
		assert.deepEqual(notifications, []);
	});

	it("keeps every rejected notice and its following failed result visible", async () => {
		clearBus();
		const notifications = [];
		__test.beginStandaloneWarningSession(
			{ appendEntry() {} },
			{
				sessionManager: { getEntries: () => [] },
				ui: { notify(message) { notifications.push(message); } },
			},
			true,
		);
		const rejection = {
			type: "rate_limit_event",
			rate_limit_info: { status: "rejected", utilization: 1, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
		};
		const failure = { type: "result", subtype: "success", is_error: true, result: "out of usage" };
		const first = await consume([rejection, failure]);
		const second = await consume([rejection, failure]);

		assert.equal(notifications.length, 2);
		assert.match(first.turnOutput.errorMessage, /Claude rate limit.*out of usage/);
		assert.match(second.turnOutput.errorMessage, /Claude rate limit.*out of usage/);
	});

	it("validates restored markers, resets forks, and always shows hard limits", () => {
		const inherited = [
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "anthropic", shownAt: 1 } },
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "codex", shownAt: "bad" } },
			{ type: "custom", customType: "provider-usage:warning-v1", data: { provider: "other", shownAt: 1 } },
		];
		const notifications = [];
		const entries = [];
		const context = {
			appendEntry(customType, data) { entries.push({ customType, data }); },
			ui: { notify(message) { notifications.push(message); } },
		};
		warningState.restoreStandaloneWarningState({ sessionManager: { getEntries: () => inherited } });
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "soft-warning", provider: "anthropic", message: "restored" }, context,
		);
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "hard-limit", provider: "anthropic", message: "hard one" }, context,
		);
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "hard-limit", provider: "anthropic", message: "hard two" }, context,
		);
		assert.deepEqual(notifications, ["hard one", "hard two"]);
		assert.deepEqual(entries, []);

		warningState.resetStandaloneWarningState();
		warningState.notifyWithStandaloneSessionPolicy(
			{ version: 1, type: "soft-warning", provider: "anthropic", message: "fork allowance" }, context,
		);
		assert.deepEqual(notifications, ["hard one", "hard two", "fork allowance"]);
		assert.equal(entries.length, 1);
	});
});
