/**
 * Unit-suite preload: redirect the bridge's debug log and model-discovery cache
 * to a throwaway directory.
 *
 * src/index.ts resolves DEBUG_LOG_PATH into a module-level const at import time
 * (and mkdirs it when CLAUDE_BRIDGE_DEBUG=1), so the override has to be in place
 * before any test imports the module. Doing that per test file is easy to forget,
 * and forgetting is invisible: the suite still passes everywhere except on a
 * developer machine with CLAUDE_BRIDGE_DEBUG=1, where the tests instead append
 * fixture data to the real ~/.pi/agent/claude-bridge.log.
 *
 * The cache override matters the same way: activation seeds the registered model
 * list from the discovery cache, which on a machine that has opened the model
 * picker holds extra ids while CI sees none. Pinning both to one empty temp file
 * keeps activations identical everywhere.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts the log override
 * took effect, and tests/unit-model-discovery.mjs the cache one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(logDir, "claude-bridge.log");
// diagDump writes unconditionally, so a test that reaches a diagnosed path would
// otherwise append fixtures to the real ~/.pi/agent/claude-bridge-diag.log.
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(logDir, "claude-bridge-diag.log");
process.env.CLAUDE_BRIDGE_MODELS_CACHE = join(logDir, "claude-bridge-models.json");
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));
