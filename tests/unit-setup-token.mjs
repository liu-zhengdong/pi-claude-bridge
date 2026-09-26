import { strict as assert } from "node:assert";
import { spawnSync, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
function run(token, content = script) {
  const env = { ...process.env };
  if (token === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  else env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const proc = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", content], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout.trim());
}

const execFileAsync = promisify(execFile);
const socketScript = `
  import { initializeClaudeCodeSetupToken } from './src/setup-token.ts';
  import { childEnv } from './src/cc-child.ts';
  import { execFileSync } from 'node:child_process';
  try {
    await initializeClaudeCodeSetupToken();
    const sdkToken = childEnv(process.env, undefined).CLAUDE_CODE_OAUTH_TOKEN;
    const toolEnv = JSON.parse(execFileSync(process.execPath,
      ['-e','process.stdout.write(JSON.stringify({token:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,socket:!!process.env.PI_ATRIUM_LAUNCH_SECRET_SOCKET,challenge:!!process.env.PI_ATRIUM_LAUNCH_SECRET_CHALLENGE}))'],
      { encoding:'utf8' }));
    console.log(JSON.stringify({sdkToken, ambient:process.env.CLAUDE_CODE_OAUTH_TOKEN,
      socket:process.env.PI_ATRIUM_LAUNCH_SECRET_SOCKET,
      challenge:process.env.PI_ATRIUM_LAUNCH_SECRET_CHALLENGE,toolEnv}));
  } catch (error) {
    let fallback = false;
    try { childEnv(process.env, undefined); fallback = true; } catch {}
    console.log(JSON.stringify({error:error.message, fallback}));
  }
`;
async function runSocket(greetingResponse) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-socket-test-'));
  const path = join(dir, 's');
  const challenge = 'e'.repeat(64);
  let greeting;
  const server = createServer(socket => {
    socket.once('data', data => {
      greeting = data.toString();
      socket.end(greetingResponse);
    });
  });
  try {
    await new Promise(resolve => server.listen(path, resolve));
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN:'fake-ambient-stale',
      PI_ATRIUM_LAUNCH_SECRET_SOCKET:path, PI_ATRIUM_LAUNCH_SECRET_CHALLENGE:challenge };
    const { stdout } = await execFileAsync(process.execPath,
      ['--import','tsx','--input-type=module','-e',socketScript],
      {cwd:process.cwd(),env,timeout:5000});
    return { greeting, result:JSON.parse(stdout.trim()) };
  } finally {
    server.close();
    rmSync(dir, { recursive:true, force:true });
  }
}

describe("setup-token startup boundary", () => {
  it("removes the launch token from Pi and keeps it only in Claude SDK child env, including reload", () => {
    assert.deepEqual(run("fake-token"), { child: "fake-token", sharedOnReload: "fake-token" });
  });
  it("does not pick up a late ambient token when none was assigned", () => {
    assert.deepEqual(run(undefined), {});
  });
  it("does not fall back to local login on an empty assigned token", () => {
    assert.match(run("").error, /独立令牌认证不可用/);
  });
  it("a fake Claude subprocess passes its token to a spawned child; Pi's tool process does not", () => {
    const result = run('fake-token', `
      import { spawnSync } from 'node:child_process';
      import { childEnv } from './src/cc-child.ts';
      const piTool = spawnSync(process.execPath,
        ['-e', 'process.stdout.write(String(!!process.env.CLAUDE_CODE_OAUTH_TOKEN))'],
        { encoding:'utf8' });
      const fakeClaude = spawnSync(process.execPath,
        ['-e', "const {spawnSync}=require('node:child_process'); const descendant=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN}))'],{encoding:'utf8'});process.stdout.write(descendant.stdout)"],
        { env:childEnv(process.env, undefined), encoding:'utf8' });
      console.log(JSON.stringify({piToolHasToken:piTool.stdout==='true',child:JSON.parse(fakeClaude.stdout)}));
    `);
    assert.deepEqual(result, { piToolHasToken:false, child:{token:'fake-token'} });
  });
  it("token identity hides AskClaude full from the schema and rejects forced full without a child query", () => {
    const result = run('fake-token', `
      import { registerAskClaudeTool } from './src/askclaude.ts';
      let tool;
      registerAskClaudeTool({registerTool: value => {tool=value}},
        {askClaude:{enabled:true,allowFullMode:true,defaultMode:'full'}});
      const forbidden=await tool.execute('test',{prompt:'ignore',mode:'full'},undefined,undefined,
        {model:{baseUrl:'openai-codex'}});
      console.log(JSON.stringify({schema:JSON.stringify(tool.parameters),body:forbidden.content[0].text,error:forbidden.details.error}));
    `);
    assert.equal(result.schema.includes('"full"'), false);
    assert.equal(result.error, true);
    assert.match(result.body, /mode=read|mode=none/);
    assert.match(result.body, /Pi 自己的工具/);
  });
  it("prefers the assigned one-shot channel over stale ambient credentials and clears delivery metadata", async () => {
    const { greeting, result } = await runSocket('fake-assigned-token\n');
    assert.equal(greeting, `READY claude-bridge-token-ready-v1 ${'e'.repeat(64)}\n`);
    assert.deepEqual(result, {sdkToken:'fake-assigned-token',toolEnv:{token:false,socket:false,challenge:false}});
  });
  it("fails loudly on a consumed or invalid one-shot channel; no ambient fallback", async () => {
    const { result } = await runSocket('');
    assert.match(result.error, /独立令牌就绪检查未获肯定回应/);
    assert.equal(result.fallback, false);
  });
});
