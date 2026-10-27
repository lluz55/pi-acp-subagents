import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const host = process.env.PI_TEST_HOST_DIR;
test('real Pi loader: background tools, rendering, notifications and cleanup', { skip: !host, timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-runtime-'));
  process.env.PI_ACP_CONFIG = join(directory, 'agents.json');
  process.env.PI_ACP_RUNS_DIR = join(directory, 'runs');
  const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
  const config = { harnesses: {}, agents: {} };
  for (const name of ['codex', 'opencode', 'claude', 'mcode']) {
    config.harnesses[name] = { command: process.execPath, args: [fixture] };
    config.agents[`${name}-reviewer`] = { harness: name, instructions: `Review using ${name}` };
  }
  config.harnesses.wait = { command: process.execPath, args: [fixture, 'ignore-cancel'] };
  config.agents.wait = { harness: 'wait' };
  await writeFile(process.env.PI_ACP_CONFIG, JSON.stringify(config));
  const { loadExtensions } = await import(pathToFileURL(resolve(host, 'dist/core/extensions/loader.js')).href);
  const { visibleWidth } = await import(pathToFileURL(resolve(host, '../pi-tui/dist/index.js')).href);
  const loaded = await loadExtensions([fileURLToPath(new URL('../index.ts', import.meta.url))], directory);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0], widgets = new Map(), notices = [], messages = [];
  loaded.runtime.sendMessage = (message, options) => messages.push({ ...message, options });
  const ctx = { cwd: directory, hasUI: true, mode: 'tui', ui: {
    setWidget: (key, value) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
    setStatus() {}, notify: text => notices.push(text),
  } };
  const emit = async type => { for (const handler of ext.handlers.get(type) ?? []) await handler({ type }, ctx); };
  const tool = name => ext.tools.get(name).definition;
  const command = args => ext.commands.get('acp').handler(args, ctx);
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('ACP event timeout');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await emit('session_start');
    const listed = await tool('acp_agents').execute('list', {}, undefined, undefined, ctx);
    assert.match(listed.content[0].text, /mcode-reviewer/);
    const result = await tool('acp_subagent').execute('batch', { tasks: ['codex', 'opencode', 'claude', 'mcode'].map(name => ({ agent: `${name}-reviewer`, task: 'inspect' })) }, undefined, undefined, ctx);
    assert.equal(result.details.runs.length, 4);
    assert.ok(result.details.runs.every(r => !r.finishedAt));
    assert.ok(widgets.has('acp-subagents'));
    const component = widgets.get('acp-subagents')();
    for (const width of [8,20,60,100]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    await until(() => messages.length === 4);
    assert.ok(messages.every(m => m.details.event === 'completed' && m.options.triggerTurn && m.options.deliverAs === 'followUp'));
    const theme = { fg: (_color, text) => text };
    for (const expanded of [false,true]) {
      const rendered = tool('acp_subagent').renderResult(result, { expanded }, theme);
      assert.ok(rendered.render(100).every(line => visibleWidth(line) <= 100));
    }
    await assert.rejects(tool('acp_subagent').execute('invalid', { tasks: [{ agent: 'codex', task: 'one' }, { agent: 'missing', task: 'two' }] }, undefined, undefined, ctx), /Unknown ACP agent/);
    const waiting = await tool('acp_subagent').execute('wait', { tasks: [{ agent: 'wait', task: 'wait' }] }, undefined, undefined, ctx);
    await tool('acp_control').execute('stop', { action: 'cancel', id: waiting.details.runs[0].id }, undefined, undefined, ctx);
    await until(() => messages.length === 5);
    assert.equal(messages.at(-1).details.event, 'cancelled');
    await command('run wait wait until cancelled');
    await emit('session_start');
    assert.equal(messages.length, 5, 'old background run cannot notify replacement session');
    assert.equal(widgets.size, 0);
    await command('list'); assert.match(notices.at(-1), /mcode-reviewer/);
  } finally {
    await emit('session_shutdown'); await rm(directory, { recursive: true, force: true });
  }
});
