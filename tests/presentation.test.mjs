import test from 'node:test';
import assert from 'node:assert/strict';
import { cardRows, cardComponent, notificationText } from '../presentation.mjs';
import { newRun, executeRun } from '../run.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = () => ({ id: '12345678-abcdef', agent: 'opencode', harness: 'opencode', status: 'completed', startedAt: 1000, finishedAt: 5000,
  task: 'Resuma projeto', cwd: '/tmp', text: 'Resposta final\nSegunda linha', tools: { a: { title: 'Ler arquivo', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'TOOL RAW PAYLOAD' } }] } },
  stages: [{ id: 'prepare', status: 'completed' }, { id: 'execute', status: 'completed' }], plan: [{ content: 'Examinar código', status: 'completed' }], logPath: '/tmp/run.jsonl' });
test('compact cards separate output from tools; individual sections expand', () => {
  const compact = cardRows(run()).map(r => r.text).join('\n');
  assert.match(compact, /\[ok\] opencode · padrão · Concluído \(4s\) · 0 tok · Ler arquivo/);
  assert.equal(cardRows(run()).length, 1);
  const tools = cardRows(run(), { sections: new Set(['tools']) }).map(r => r.text).join('\n');
  assert.match(tools, /TOOL RAW PAYLOAD/);
  assert.doesNotMatch(tools, /Examinar código/);
  const expanded = cardRows(run(), { expanded: true }).map(r => r.text).join('\n');
  assert.match(expanded, /Resposta final\n  Segunda linha/);
  assert.match(expanded, /Examinar código/);
  assert.match(expanded, /Log completo: \/tmp\/run.jsonl/);
});
test('compact mode renders exactly one line per subagent with required fields', () => {
  const r1 = { ...run(), model: 'opencode/deepseek-v4.1-flash-free', usage: { used: 9943 } };
  const r2 = { ...run(), agent: 'mcode', harness: 'mcode', model: 'minimax/MiniMax-M3.1-Flash', status: 'running', finishedAt: undefined, tools: { b: { title: 'git diff', status: 'in_progress' } }, usage: { used: 15400 } };
  const c = cardComponent([r1, r2], {}, { fg: (_c, t) => t }, (s, w) => s.slice(0, w));
  const lines = c.render(120);
  assert.equal(lines.length, 2, 'exactly one line per subagent in compact mode');
  assert.match(lines[0], /\[ok\] opencode · deepseek-v4.1-flash-free · Concluído \(\d+s\) · 9\.9k tok · Ler arquivo/);
  assert.match(lines[1], /\[~\] mcode · MiniMax-M3.1-Flash · Executando \(\d+s\) · 15\.4k tok · Executando: git diff/);
});
test('notification content never duplicates tool traces', () => {
  const content = notificationText(run(), 'completed');
  assert.match(content, /Resposta final/);
  assert.doesNotMatch(content, /TOOL RAW PAYLOAD/);
  const attention = { ...run(), status: 'permission', text: '' };
  assert.match(notificationText(attention, 'attention', 'Responda ao seletor'), /Responda ao seletor/);
});
test('live details bounded; controls sanitized; old snapshots supported', () => {
  const r = run(); r.text = Array(1000).fill('long output').join('\n'); r.task = '\x1b[31mTeste\x00';
  const rows = cardRows(r, { expanded: true, live: true });
  assert.ok(rows.length < 45);
  assert.match(rows.map(r => r.text).join('\n'), /omitidos/);
  assert.doesNotMatch(rows.map(r => r.text).join('\n'), /\x1b|\x00/);
  delete r.stages;
  assert.doesNotThrow(() => cardRows(r));
  const c = cardComponent([r], {}, { fg: (_c,t) => t }, (s,w) => s.slice(0,w));
  for (const w of [0,1,8,20,80]) assert.ok(c.render(w).every(line => line.length <= w));
  c.invalidate();
});
test('real fixture stages finish on success and preserve failed phase', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-stages-'));
  try {
    for (const scenario of ['normal', 'crash']) {
      const agent = { name: 'fixture', harness: 'fixture', command: process.execPath, args: [fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url)), scenario] };
      const r = newRun(agent, 'oi', dir), observed = new Set();
      await executeRun(r, agent, { logDir: dir, onChange: r => { for (const s of r.stages) if (s.status === 'running') observed.add(s.id); } });
      assert.ok(observed.has('prepare')); assert.ok(observed.has('connect'));
      if (scenario === 'normal') assert.ok(r.stages.every(s => s.status === 'completed'));
      else {
        assert.equal(r.stages.find(s => s.id === 'connect').status, 'failed');
        assert.equal(r.stages.find(s => s.id === 'execute').status, 'pending');
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
