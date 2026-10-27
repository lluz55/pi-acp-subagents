import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTasks } from '../tasks.mjs';

test('one public shape accepts single and parallel assignments', () => {
  for (const count of [1, 2, 4]) {
    const tasks = Array.from({ length: count }, () => ({ agent: 'opencode', task: 'oi', cwd: '/tmp' }));
    assert.equal(validateTasks({ tasks }), tasks);
  }
});

test('reject mixed and legacy top-level fields with actionable example', () => {
  const tasks = [{ agent: 'opencode', task: 'oi' }];
  for (const params of [
    { agent: 'codex', task: 'oi', tasks },
    { agent: 'codex', task: 'oi' },
    { cwd: '/tmp', tasks },
  ]) assert.throws(() => validateTasks(params), /use only tasks.*Example:.*opencode/);
});

test('reject empty, oversized and malformed assignments', () => {
  for (const params of [undefined, {}, { tasks: [] }, { tasks: 'oi' },
    { tasks: Array(5).fill({ agent: 'codex', task: 'oi' }) },
    ...[null, [], {}, { agent: 'codex', task: '' }, { agent: ' ', task: 'oi' },
      { agent: 'codex', task: 'oi', cwd: 1 }, { agent: 'codex', task: 'oi', extra: true }]
      .map(task => ({ tasks: [task] })),
  ]) assert.throws(() => validateTasks(params), /ACP:/);
});

test('extension exposes only tasks and validates before reading configuration', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const tool = source.slice(source.indexOf("name: 'acp_subagent'"));
  const parameters = tool.slice(tool.indexOf('parameters:'), tool.indexOf('async execute'));
  assert.match(parameters, /tasks: Type.Array/);
  assert.doesNotMatch(parameters, /Type.Optional|agent:|task:|cwd:/);
  assert.ok(tool.indexOf('validateTasks(params)') < tool.indexOf('await loadConfig()'));
});
