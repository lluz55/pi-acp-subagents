import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Exercise extension lifecycle with real ACP fixture processes. Only Pi UI/schema are substituted.
const require = createRequire(import.meta.url);
let createJiti;
try { ({ createJiti } = require(process.env.PI_TEST_JITI ?? '/home/lluz/.pi/agent/npm/node_modules/jiti')); }
catch {}
test('background lifecycle, notifications, cancellation and model defaults', { skip: !createJiti, timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-background-'));
  process.env.PI_ACP_CONFIG = join(dir, 'config.json');
  process.env.PI_ACP_RUNS_DIR = join(dir, 'runs');
  const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
  const config = { harnesses: {}, agents: {} };
  for (const [name, scenario] of [['normal', 'normal'], ['wait', 'ignore-cancel'], ['permission', 'permission'], ['broken', 'crash']]) {
    config.harnesses[name] = { command: process.execPath, args: [fixture, scenario] };
    config.agents[name] = { harness: name };
  }
  await writeFile(process.env.PI_ACP_CONFIG, JSON.stringify(config));
  const schema = join(dir, 'schema.mjs'), ui = join(dir, 'ui.mjs');
  await writeFile(schema, 'export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });');
  await writeFile(ui, 'export const truncateToWidth = (s,w) => s.slice(0,w); export class Text { constructor(text) { this.text=text; } }');
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { '@earendil-works/pi-ai': schema, '@earendil-works/pi-tui': ui } });
  const { default: extension } = await jiti.import(fileURLToPath(new URL('../index.ts', import.meta.url)));
  const renderers = new Map(), widgets = new Map();
  const tools = new Map(), handlers = new Map(), commands = new Map(), messages = [], notices = [];
  extension({ registerMessageRenderer: (n, r) => renderers.set(n, r), registerTool: t => tools.set(t.name, t), registerCommand: (n,c) => commands.set(n,c), on: (n,f) => handlers.set(n,f), sendMessage: (m,o) => messages.push({ ...m, options: o }) });
  let selecting = 0, maxSelecting = 0, setWidgetCalls = 0;
  const ctx = { cwd: dir, hasUI: true, ui: {
    setWidget: (key, value) => { setWidgetCalls++; return value === undefined ? widgets.delete(key) : widgets.set(key, value); }, setStatus() {}, notify: s => notices.push(s),
    select: async (_t, labels) => { selecting++; maxSelecting = Math.max(maxSelecting, selecting); await new Promise(r => setTimeout(r, 40)); selecting--; return labels[0]; },
  } };
  const call = (name, p, signal) => tools.get(name).execute('test', p, signal, undefined, ctx);
  const start = (agent, signal) => call('acp_subagent', { tasks: [{ agent, task: 'inspect' }] }, signal);
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ACP event');
      await new Promise(r => setTimeout(r, 15));
    }
  };
  const terminal = id => messages.find(m => m.details.runs[0].id === id && m.details.event !== 'attention');
  try {
    await handlers.get('session_start')({}, ctx);
    const controller = new AbortController();
    const first = await start('normal', controller.signal);
    const id = first.details.runs[0].id;
    assert.equal(first.details.runs[0].finishedAt, undefined, 'tool returns before completion');
    controller.abort(); // Original tool signal must no longer own detached run.
    await until(() => terminal(id));
    assert.equal(terminal(id).details.event, 'completed');
    assert.equal(terminal(id).options.triggerTurn, true);
    assert.equal(terminal(id).options.deliverAs, 'followUp');
    const failed = await start('broken');
    await until(() => terminal(failed.details.runs[0].id));
    assert.equal(terminal(failed.details.runs[0].id).details.event, 'failed');
    const permissions = await call('acp_subagent', { tasks: [1,2].map(() => ({ agent: 'permission', task: 'inspect' })) });
    await until(() => permissions.details.runs.every(r => terminal(r.id)));
    assert.equal(messages.filter(m => m.details.event === 'attention').length, 2);
    assert.equal(maxSelecting, 1);
    const waiting = await start('wait');
    const waitId = waiting.details.runs[0].id;
    await assert.rejects(call('acp_control', { action: 'cancel' }), /requires id/);
    await assert.rejects(call('acp_control', { action: 'cancel', id: 'missing' }), /ID ativo/);
    const stopped = await call('acp_control', { action: 'cancel', id: waitId.slice(0,8) });
    assert.deepEqual(stopped.details.ids, [waitId]);
    await until(() => terminal(waitId));
    assert.equal(terminal(waitId).details.event, 'cancelled');
    const status = await call('acp_control', { action: 'status', id: waitId });
    assert.equal(status.details.runs[0].status, 'cancelled');
    const raced = await Promise.allSettled([1,2].map(() => call('acp_subagent', { tasks: [1,2,3].map(() => ({ agent: 'wait', task: 'wait' })) })));
    assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
    const batch = raced.find(r => r.status === 'fulfilled').value.details.runs;
    await call('acp_control', { action: 'cancel', id: 'all' });
    await until(() => batch.every(r => terminal(r.id)));
    const command = s => commands.get('acp').handler(s, ctx);
    const theme = { fg: (_c, text) => text };
    const widgetText = () => widgets.get('acp-subagents')({}, theme).render(100).join('\n');
    await command('panel hidden');
    assert.equal(widgets.size, 0);
    await command('panel compact');
    assert.match(widgetText(), /Cancelado/);
    await command('toggle stages');
    assert.match(widgetText(), /▾ Etapas/);
    await command('panel expanded');
    assert.match(widgetText(), /▾ Diagnóstico/);
    await command('toggle diagnostics');
    assert.match(widgetText(), /▸ Diagnóstico/);
    const renderedMessage = renderers.get('acp-subagents')(terminal(id), { expanded: false }, theme);
    assert.match(renderedMessage.render(100).join('\n'), /Concluído/);
    const expandedMessage = renderers.get('acp-subagents')(terminal(id), { expanded: true }, theme);
    assert.match(expandedMessage.render(100).join('\n'), /▾ Etapas/);
    assert.ok(!terminal(id).content.includes('fixture tool result'), 'notification excludes tool payloads');
    const messageCount = messages.length;
    await command('show ' + id.slice(0, 8));
    assert.equal(messages.length, messageCount + 1);
    assert.equal(messages.at(-1).options, undefined, 'show must not wake model');
    await command('model normal test-model');
    const saved = JSON.parse(await readFile(process.env.PI_ACP_CONFIG, 'utf8'));
    assert.equal(saved.agents.normal.model, 'test-model');
    assert.deepEqual(saved.harnesses, config.harnesses);
    const callsBefore = setWidgetCalls;
    const modelRun = await start('normal');
    await until(() => terminal(modelRun.details.runs[0].id));
    assert.equal(setWidgetCalls, callsBefore, 'widget remains mounted without churn on stream updates');
    assert.match(terminal(modelRun.details.runs[0].id).content, /session\/set_config_option:.*test-model/);
    await command('model normal --clear');
    assert.equal(JSON.parse(await readFile(process.env.PI_ACP_CONFIG, 'utf8')).agents.normal.model, undefined);
    await command('run normal command task');
    await until(() => messages.some(m => m.content.includes('final: command task')));
    await start('wait');
    const count = messages.length;
    await handlers.get('session_start')({}, ctx);
    assert.equal(messages.length, count, 'shutdown cannot notify replacement session');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(start('normal', aborted.signal), /launch cancelled/);
  } finally {
    await handlers.get('session_shutdown')({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
