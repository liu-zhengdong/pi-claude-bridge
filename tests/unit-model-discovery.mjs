/**
 * Tests for runtime model discovery: advertised-id extraction, cache handling,
 * and the refreshModels hook's restore/network phases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MODEL_DISCOVERY_TTL_MS,
	createModelCatalogRefresher,
	extractModelIds,
	mergeDiscoveredIds,
	modelDiscoveryCachePath,
	probeModelIds,
	readModelDiscoveryCache,
} from "../src/model-discovery.js";

const tmpDir = mkdtempSync(join(tmpdir(), "claude-bridge-discovery-"));
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));

const cacheFile = () => join(tmpDir, `cache-${Math.random().toString(36).slice(2)}.json`);
const writeCache = (file, cache) => writeFileSync(file, JSON.stringify(cache));
const readCache = (file) => JSON.parse(readFileSync(file, "utf-8"));

// Stand-in for the real catalog builder, which projects pi-ai entries we cannot
// pin to a release here; discovery logic only needs the ids back, newest first.
const fakeCatalog = (ids) => [...ids.map((id) => ({ id })), { id: "claude-opus-5" }];

function makeRefresher({ file = cacheFile(), probe = async () => [], identity = () => ({}), now = () => 1000 } = {}) {
	const calls = { probe: 0 };
	return {
		calls,
		file,
		refresh: createModelCatalogRefresher({
			cwd: "/tmp",
			provider: {},
			dependencies: {
				cacheFile: file,
				buildCatalog: fakeCatalog,
				identity,
				now,
				probe: async (options) => {
					calls.probe += 1;
					return probe(options);
				},
				log: () => {},
			},
		}),
	};
}

describe("extractModelIds", () => {
	it("prefers resolvedModel, strips [..] and dated suffixes, filters non-claude ids", () => {
		const ids = extractModelIds([
			{ value: "default", resolvedModel: "claude-opus-5-5[1m]" },
			{ value: "sonnet", resolvedModel: "claude-sonnet-5" },
			{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
			{ value: "x", resolvedModel: "not-claude" },
			{ value: "claude-new-1" },
			{ value: "dup", resolvedModel: "claude-sonnet-5" },
		]);
		assert.deepEqual(ids, ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-new-1"]);
	});

	it("tolerates SDK drift: missing fields and nulls are skipped", () => {
		assert.deepEqual(extractModelIds([{}, { value: null, resolvedModel: null }, { value: "claude-bare-1" }]), ["claude-bare-1"]);
	});
});

describe("cache", () => {
	it("round-trips and ignores unparseable or foreign content", () => {
		const file = cacheFile();
		assert.equal(readModelDiscoveryCache(file), undefined);
		writeFileSync(file, "not json");
		assert.equal(readModelDiscoveryCache(file), undefined);
		writeFileSync(file, JSON.stringify({ models: "nope" }));
		assert.equal(readModelDiscoveryCache(file), undefined);
		writeFileSync(file, JSON.stringify({ checkedAt: 5, models: ["claude-x-1", "gpt-9", 7] }));
		assert.deepEqual(readModelDiscoveryCache(file), { checkedAt: 5, cliPath: undefined, cliStamp: undefined, models: ["claude-x-1"] });
	});

	it("reads the cache path from CLAUDE_BRIDGE_MODELS_CACHE when set", () => {
		assert.equal(modelDiscoveryCachePath(), process.env.CLAUDE_BRIDGE_MODELS_CACHE, "tests/lib/setup.mjs must redirect the cache");
	});

	it("falls back to the agent dir without the override", () => {
		const override = process.env.CLAUDE_BRIDGE_MODELS_CACHE;
		delete process.env.CLAUDE_BRIDGE_MODELS_CACHE;
		try {
			assert.ok(modelDiscoveryCachePath().endsWith("claude-bridge-models.json"));
			assert.notEqual(modelDiscoveryCachePath(), override);
		} finally {
			if (override === undefined) delete process.env.CLAUDE_BRIDGE_MODELS_CACHE;
			else process.env.CLAUDE_BRIDGE_MODELS_CACHE = override;
		}
	});
});

describe("mergeDiscoveredIds", () => {
	it("keeps probe order first and retains earlier discoveries", () => {
		assert.deepEqual(mergeDiscoveredIds(["claude-b-2", "claude-a-1"], ["claude-a-1", "claude-old-0"]), ["claude-b-2", "claude-a-1", "claude-old-0"]);
	});
});

describe("refreshModels restore phase", () => {
	it("returns cached ids without probing", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 0, models: ["claude-opus-5-5"] });
		const { refresh, calls } = makeRefresher({ file, probe: () => { throw new Error("must not probe"); } });
		const models = await refresh({ allowNetwork: false, signal: new AbortController().signal });
		assert.equal(calls.probe, 0);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-opus-5"]);
	});
});

describe("refreshModels network phase", () => {
	it("probes when there is no cache yet", async () => {
		const { refresh, calls, file } = makeRefresher({ probe: async () => ["claude-opus-5-5"] });
		const models = await refresh({ allowNetwork: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 1);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-opus-5"]);
		assert.deepEqual(readCache(file).models, ["claude-opus-5-5"]);
	});

	it("serves a fresh cache without probing", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 1000, cliStamp: "s1", models: ["claude-old-1"] });
		const { refresh, calls } = makeRefresher({ file, identity: () => ({ cliStamp: "s1" }), now: () => 1001, probe: async () => ["claude-new-2"] });
		const models = await refresh({ allowNetwork: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 0);
		assert.deepEqual(models.map((m) => m.id), ["claude-old-1", "claude-opus-5"]);
	});

	it("probes a cache older than the TTL, merges, and rewrites it", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 0, cliStamp: "s1", models: ["claude-old-1"] });
		const { refresh, calls } = makeRefresher({
			file,
			identity: () => ({ cliPath: "/cli", cliStamp: "s1" }),
			now: () => 10 * MODEL_DISCOVERY_TTL_MS,
			probe: async () => ["claude-opus-5-5"],
		});
		const models = await refresh({ allowNetwork: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 1);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-old-1", "claude-opus-5"]);
		assert.deepEqual(readCache(file), {
			checkedAt: 10 * MODEL_DISCOVERY_TTL_MS, cliPath: "/cli", cliStamp: "s1", models: ["claude-opus-5-5", "claude-old-1"],
		});
	});

	it("re-probes when the CLI binary changed", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 1000, cliStamp: "s1", models: ["claude-old-1"] });
		const { refresh, calls } = makeRefresher({ file, identity: () => ({ cliPath: "/cli", cliStamp: "s2" }), now: () => 1001, probe: async () => ["claude-new-2"] });
		const models = await refresh({ allowNetwork: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 1);
		assert.deepEqual(models.map((m) => m.id), ["claude-new-2", "claude-old-1", "claude-opus-5"]);
		assert.equal(readCache(file).cliStamp, "s2");
	});

	it("respects force over a fresh cache", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 1000, models: ["claude-old-1"] });
		const { refresh, calls } = makeRefresher({ file, now: () => 1001, probe: async () => ["claude-new-2"] });
		await refresh({ allowNetwork: true, force: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 1);
	});

	it("keeps the cached list when the probe fails", async () => {
		const file = cacheFile();
		writeCache(file, { checkedAt: 0, models: ["claude-old-1"] });
		const { refresh, calls } = makeRefresher({
			file,
			now: () => 10 * MODEL_DISCOVERY_TTL_MS,
			probe: async () => { throw new Error("CLI missing"); },
		});
		const models = await refresh({ allowNetwork: true, signal: new AbortController().signal });
		assert.equal(calls.probe, 1);
		assert.deepEqual(models.map((m) => m.id), ["claude-old-1", "claude-opus-5"]);
		assert.equal(readCache(file).checkedAt, 0, "cache untouched on failure");
	});
});

describe("probeModelIds", () => {
	it("extracts ids from supportedModels and closes the query", async () => {
		let closed = 0;
		const ids = await probeModelIds({
			cwd: "/tmp",
			dependencies: {
				query: () => ({
					supportedModels: async () => [{ value: "default", resolvedModel: "claude-opus-5-5[1m]" }],
					close: () => { closed += 1; },
				}),
			},
		});
		assert.deepEqual(ids, ["claude-opus-5-5"]);
		assert.equal(closed, 1);
	});

	it("rejects before spawning when the caller signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let queryCalls = 0;
		await assert.rejects(
			probeModelIds({
				cwd: "/tmp",
				signal: controller.signal,
				dependencies: { query: () => { queryCalls += 1; return { supportedModels: async () => [], close: () => {} }; } },
			}),
			/aborted/i,
		);
		assert.equal(queryCalls, 0);
	});
});
