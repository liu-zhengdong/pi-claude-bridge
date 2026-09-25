import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const script = `
  import { childEnv } from './src/cc-child.ts';
  import { claudeCodeSetupToken } from './src/setup-token.ts?reload=1';
  const ambient = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'late-untrusted-value';
  let error;
  try { childEnv(process.env, undefined); } catch (e) { error = e.message; }
  console.log(JSON.stringify({ ambient, child: error ? null : childEnv(process.env, undefined).CLAUDE_CODE_OAUTH_TOKEN, error,
    sharedOnReload: error ? null : claudeCodeSetupToken() }));
`;
function run(token) {
  const env = { ...process.env };
  if (token === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  else env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const proc = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout.trim());
}

describe("setup-token startup boundary", () => {
  it("removes the launch token from Pi and keeps it only in Claude SDK child env, including reload", () => {
    assert.deepEqual(run("fake-token"), { child: "fake-token", sharedOnReload: "fake-token" });
  });
  it("does not pick up a late ambient token when none was assigned", () => {
    assert.deepEqual(run(undefined), {});
  });
  it("does not fall back to local login on an empty assigned token", () => {
    assert.match(run("").error, /empty/);
  });
});
