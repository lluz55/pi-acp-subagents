import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUpdate, executeRun, newRun, runText } from '../run.mjs';
import { loadConfig, resolveAgent } from '../config.mjs';
const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const agent = (scenario = 'normal', extra = {}) => ({ name: 'test', harness: 'test-harness', command: process.execPath, args: [fixture, scenario], ...extra });
const run = async (scenario, extra = {}, opts = {}, task = 'test task') => {
  const a = agent(scenario, extra), r = newRun(a, task, directory);
  await executeRun(r, a, { logDir: directory, ...opts }); return r;
};

test('streams text, UTF-8, thoughts, tools, plans and usage before completion; durable full log', async () => {
  let streamed = false;
  const r = await run('normal', { instructions: 'Review carefully' }, { onChange(r) {
    if (r.text.includes('first') && !r.finishedAt && r.status === 'running') streamed = true;
  } });
  assert.equal(streamed, true); assert.equal(r.status, 'completed');
  assert.match(r.text, /first ação/); assert.match(r.text, /Agent instructions:\nReview carefully\n\nTask:\ntest task/);
  assert.doesNotMatch(r.text, /WRONG SESSION|�/);
  assert.equal(r.tools.call.title, 'Read fixture'); assert.equal(r.tools.call.status, 'completed');
  assert.equal(r.usage.used, 42); assert.equal(r.plan[0].status, 'completed');
  assert.match(runText(r, { expanded: true }), /fixture tool result/);
  const records = (await readFile(r.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].type, 'start'); assert.equal(records.at(-1).status, 'completed');
  assert.ok(records.some(e => e.type === 'update' && e.update.sessionUpdate === 'agent_message_chunk'));
  assert.equal((await stat(r.logPath)).mode & 0o777, 0o600);
});

test('configOptions selects grouped model, mode, reasoning and boolean; legacy mode/model supported', async () => {
  const r = await run('normal', { model: 'test-model', mode: 'ask', config: { reasoning: 'high', flag: true } });
  assert.equal(r.status, 'completed');
  for (const value of ['chosen-model', 'test-model', 'reasoning', 'flag']) assert.match(r.text, new RegExp(value));
  assert.ok(r.text.indexOf('chosen-model') < r.text.indexOf('reasoning'), 'select model before model-dependent reasoning options');
  const legacy = await run('legacy', { model: 'test-model', mode: 'ask' });
  assert.equal(legacy.status, 'completed'); assert.match(legacy.text, /session\/set_model/); assert.match(legacy.text, /session\/set_mode/);
  const bad = await run('normal', { model: 'missing-model' });
  assert.equal(bad.status, 'failed'); assert.match(bad.error, /value unavailable/); assert.doesNotMatch(bad.text, /first/);
});

test('permission policy: interactive choice, headless deny, explicit allow and deny', async () => {
  const interactive = await run('permission', {}, { requestPermission: async (_r, p) => p.options[0].optionId });
  assert.match(interactive.text, /"optionId":"yes"/);
  const headless = await run('permission'); assert.match(headless.text, /"outcome":"cancelled"/);
  const allow = await run('permission', { permissions: 'allow' }); assert.match(allow.text, /"optionId":"yes"/);
  const deny = await run('permission', { permissions: 'deny' }); assert.match(deny.text, /"optionId":"no"/);
});

test('cancels an open permission dialog and returns even if the UI never resolves', async () => {
  const controller = new AbortController(); let dialogSignal;
  const pending = run('permission-hang', {}, { signal: controller.signal, requestPermission: async (_r, _p, s) => {
    dialogSignal = s; controller.abort(); return new Promise(() => {});
  } });
  const r = await pending;
  assert.equal(r.status, 'cancelled'); assert.equal(dialogSignal.aborted, true);
});

test('cooperative and uncooperative cancellation, pre-aborted signal and total timeout', async () => {
  for (const scenario of ['normal', 'ignore-cancel', 'hang-init']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const r = await run(scenario, {}, { signal: controller.signal }); clearTimeout(timer);
    assert.equal(r.status, 'cancelled'); assert.ok(r.finishedAt);
  }
  const c = new AbortController(); c.abort(); assert.equal((await run('normal', {}, { signal: c.signal })).status, 'cancelled');
  const timed = await run('ignore-cancel', { timeoutSeconds: 1 }); assert.equal(timed.status, 'timed_out');
});

test('kills a harness grandchild as well as its adapter', async () => {
  const pidPath = join(directory, 'grandchild.pid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const r = await run('grandchild', {}, { signal: controller.signal }, pidPath); clearTimeout(timer);
  assert.equal(r.status, 'cancelled');
  const pid = Number(await readFile(pidPath, 'utf8'));
  // SIGKILL is asynchronous; allow the scheduler to finish removing the child.
  const deadline = Date.now() + 1000;
  while (true) {
    try {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (/^\d+ \(.*\) Z /.test(status)) break;
      assert.ok(Date.now() < deadline, `Grandchild still running after SIGKILL: ${status}`);
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) break;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});

test('protocol mismatch, malformed stdout, crash, missing binary, auth and incomplete response are failures', async () => {
  for (const [scenario, pattern] of [['v2', /protocol version/], ['bad-stdout', /Invalid ACP stdout/], ['crash', /exited/], ['auth', /Authenticate/], ['max-tokens', /max_tokens/]]) {
    const r = await run(scenario); assert.equal(r.status, 'failed', scenario); assert.match(r.error, pattern);
  }
  const r = await run('normal', { command: '/does-not-exist/pi-acp' }); assert.equal(r.status, 'failed'); assert.match(r.error, /Cannot start/);
});

test('large output bounded in memory but complete on disk', async () => {
  const text = 'x'.repeat(20000);
  const r = await run('normal', {}, {}, text);
  assert.equal(r.status, 'completed'); assert.ok(r.text.length <= 12000);
  assert.equal(r.previewTruncated, true); assert.match(runText(r), /Preview limited/);
  const records = (await readFile(r.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(e => e.update?.content?.text?.includes(text)));
});

test('global agent/harness overrides and invalid config validation', async () => {
  const path = join(directory, 'config.json');
  const defaultConfig = await loadConfig(path);
  assert.deepEqual(Object.keys(defaultConfig.harnesses), ['codex', 'opencode', 'claude', 'mcode']);
  for (const harness of Object.keys(defaultConfig.harnesses)) assert.equal(resolveAgent(defaultConfig, harness).harness, harness);
  await writeFile(path, JSON.stringify({ harnesses: { codex: { command: 'custom-codex' } }, agents: { reviewer: { harness: 'codex', instructions: 'Review', model: 'm' } } }));
  const custom = await loadConfig(path); assert.equal(resolveAgent(custom, 'reviewer').command, 'custom-codex');
  assert.throws(() => resolveAgent(custom, 'missing'), /Unknown ACP agent/);
  assert.throws(() => resolveAgent(custom, '__proto__'), /Unknown ACP agent/);
  for (const value of [{ agents: { bad: { harness: 'missing' } } }, { agents: { bad: { harness: 'codex', permissions: 'typo' } } }, { agents: { bad: { harness: 'codex', timeoutSeconds: 0 } } }, { harnesses: { codex: { args: 'bad' } } }, { typo: {} }]) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(loadConfig(path), /ACP config/);
  }
});

test('provider retry errors appear live without misreporting success', () => {
  const r = newRun(agent(), 'test', directory);
  r.status = 'running';
  applyUpdate(r, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 2, error: { message: 'Provider returned 404' } } } });
  assert.match(runText(r), /Retry 2: Provider returned 404/);
  assert.equal(r.status, 'running');
  applyUpdate(r, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered' } });
  assert.equal(r.notice, undefined);
});

test('large tool output is previewed without retaining raw payloads in UI snapshots', () => {
  const r = newRun(agent(), 'test', directory);
  applyUpdate(r, { sessionUpdate: 'tool_call', toolCallId: 'large', title: 'Read', rawOutput: 'x'.repeat(100000), content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(10000) } }] });
  assert.equal(r.tools.large.rawOutput, undefined);
  assert.equal(r.tools.large.content[0].content.text.length, 2000);
  assert.equal(r.previewTruncated, true);
  assert.ok(runText(r, { expanded: true }).length < 2400);
});
