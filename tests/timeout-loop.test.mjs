import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTasks } from '../tasks.mjs';
import { applyUpdate, detectLoop, executeRun, newRun } from '../run.mjs';

const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));

test('validateTasks accepts valid timeoutSeconds and timeout alias, and rejects invalid values', () => {
  const valid = validateTasks({ tasks: [{ agent: 'opencode', task: 'fazer algo', timeoutSeconds: 300 }] });
  assert.equal(valid[0].timeoutSeconds, 300);

  const alias = validateTasks({ tasks: [{ agent: 'codex', task: 'fazer algo', timeout: 120 }] });
  assert.equal(alias[0].timeoutSeconds, 120);

  // Rejects invalid values
  for (const bad of [0, -1, 86401, '300', 1.5, null, {}]) {
    assert.throws(
      () => validateTasks({ tasks: [{ agent: 'opencode', task: 'fazer algo', timeoutSeconds: bad }] }),
      /ACP: each task needs non-empty agent and task strings/
    );
  }
});

test('detectLoop accurately flags loops and normal progress', () => {
  const baseRun = {
    id: 'test-run', agent: 'opencode', harness: 'opencode',
    status: 'running', startedAt: Date.now(), timeoutSeconds: 300,
    deadline: Date.now() + 300000, tools: {}, toolHistory: [],
  };

  // Normal run with different tools
  const normalRun = structuredClone(baseRun);
  normalRun.toolHistory = [
    { toolCallId: '1', title: 'read_file', status: 'completed', at: 1, output: 'content 1' },
    { toolCallId: '2', title: 'edit_file', status: 'completed', at: 2, output: 'content 2' },
    { toolCallId: '3', title: 'run_tests', status: 'completed', at: 3, output: 'passed' },
  ];
  const normalCheck = detectLoop(normalRun);
  assert.equal(normalCheck.isStuck, false);
  assert.match(normalCheck.message, /Nenhum loop detectado/);

  // Consecutive identical calls with same output
  const stuckIdentical = structuredClone(baseRun);
  stuckIdentical.toolHistory = [
    { toolCallId: '1', title: 'read_file', status: 'completed', at: 1, output: 'file not found' },
    { toolCallId: '2', title: 'read_file', status: 'completed', at: 2, output: 'file not found' },
    { toolCallId: '3', title: 'read_file', status: 'completed', at: 3, output: 'file not found' },
  ];
  const identicalCheck = detectLoop(stuckIdentical);
  assert.equal(identicalCheck.isStuck, true);
  assert.equal(identicalCheck.pattern, 'repeated_identical_calls');
  assert.match(identicalCheck.message, /read_file.*3 vezes/);

  // Consecutive failures
  const stuckFailures = structuredClone(baseRun);
  stuckFailures.toolHistory = [
    { toolCallId: '1', title: 'bash', status: 'failed', at: 1, output: 'error 1' },
    { toolCallId: '2', title: 'bash', status: 'failed', at: 2, output: 'error 2' },
    { toolCallId: '3', title: 'bash', status: 'failed', at: 3, output: 'error 3' },
  ];
  const failureCheck = detectLoop(stuckFailures);
  assert.equal(failureCheck.isStuck, true);
  assert.equal(failureCheck.pattern, 'repeated_failures');

  // Alternating cycle (A, B, A, B)
  const alternating = structuredClone(baseRun);
  alternating.toolHistory = [
    { toolCallId: '1', title: 'tool_a', status: 'completed', at: 1 },
    { toolCallId: '2', title: 'tool_b', status: 'completed', at: 2 },
    { toolCallId: '3', title: 'tool_a', status: 'completed', at: 3 },
    { toolCallId: '4', title: 'tool_b', status: 'completed', at: 4 },
  ];
  const altCheck = detectLoop(alternating);
  assert.equal(altCheck.isStuck, true);
  assert.equal(altCheck.pattern, 'alternating_cycle');

  // Provider retries
  const retrying = structuredClone(baseRun);
  retrying.notice = 'Retry 3: connection timeout';
  const retryCheck = detectLoop(retrying);
  assert.equal(retryCheck.isStuck, true);
  assert.equal(retryCheck.pattern, 'provider_retry_loop');
});

test('extendTimeout dynamically adds time and reschedules timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-extend-'));
  try {
    const agent = { name: 'wait', harness: 'wait', command: process.execPath, args: [fixture, 'ignore-cancel'], timeoutSeconds: 2 };
    const r = newRun(agent, 'wait task', dir, 2);
    assert.equal(r.timeoutSeconds, 2);

    const controller = new AbortController();
    const executing = executeRun(r, agent, { signal: controller.signal, logDir: dir });

    // Wait until started
    await new Promise(res => setTimeout(res, 200));
    assert.equal(r.status, 'running');

    // Extend timeout by 3 seconds (total 5s)
    const result = r.extendTimeout(3);
    assert.equal(r.timeoutSeconds, 5);
    assert.ok(result.remainingSeconds >= 3);

    // After 2.5s (which would have expired the original 2s timeout), ensure it is still running!
    await new Promise(res => setTimeout(res, 2200));
    assert.equal(r.status, 'running');

    // Cancel to clean up
    controller.abort();
    await executing;
    assert.equal(r.status, 'cancelled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('onTimeoutWarning triggers before deadline and allows extending to complete execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-warn-'));
  try {
    const agent = { name: 'wait', harness: 'wait', command: process.execPath, args: [fixture, 'ignore-cancel'], timeoutSeconds: 2 };
    const r = newRun(agent, 'wait task', dir, 2);
    const warnings = [];
    const controller = new AbortController();

    const executing = executeRun(r, agent, {
      signal: controller.signal,
      logDir: dir,
      onTimeoutWarning: (run, rem) => {
        warnings.push({ id: run.id, rem });
      },
    });

    // timeout is 2s; leadSec is 1s; warning fires at ~1s
    await new Promise(res => setTimeout(res, 1200));
    assert.ok(warnings.length >= 1, 'Warning should have fired before deadline');

    // Extend timeout now so execution continues without timing out
    r.extendTimeout(2);

    // Verify it is still running past the original 2s mark
    await new Promise(res => setTimeout(res, 1000));
    assert.equal(r.status, 'running');

    controller.abort();
    await executing;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
