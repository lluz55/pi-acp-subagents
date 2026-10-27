import { mkdir, open, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AcpConnection } from './transport.mjs';
import { runsDir } from './config.mjs';

export const clean = text => String(text ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const tail = (text, limit = 12_000) => text.length > limit ? text.slice(-limit) : text;
const selectionSummary = options => options?.map(({ id, category, currentValue }) => ({ id, category, currentValue }));

function preview(run, text, limit) {
  const value = clean(text);
  if (value.length > limit) run.previewTruncated = true;
  return tail(value, limit);
}

export function newRun(agent, task, cwd, timeoutSeconds) {
  const timeout = timeoutSeconds ?? agent.timeoutSeconds ?? 600;
  return {
    id: randomUUID(), agent: agent.name, harness: agent.harness, task, cwd: resolve(agent.cwd ?? cwd),
    model: agent.model, stages: ['prepare', 'connect', 'session', 'configure', 'execute'].map(id => ({ id, status: 'pending' })),
    status: 'starting', startedAt: Date.now(), text: '', thought: '', tools: {}, plan: [], usage: undefined,
    timeoutSeconds: timeout,
    deadline: Date.now() + timeout * 1000,
    toolHistory: [],
  };
}

export function applyUpdate(run, update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') { run.text = preview(run, run.text + update.content.text, 12_000); run.notice = undefined; }
      break;
    case 'agent_thought_chunk':
      if (update.content?.type === 'text') run.thought = tail(run.thought + clean(update.content.text), 2000);
      break;
    case 'tool_call':
    case 'tool_call_update': {
      const old = run.tools[update.toolCallId] ?? {};
      const fields = Object.fromEntries(Object.entries(update).filter(([k, v]) => v !== null && v !== undefined && !['rawInput', 'rawOutput'].includes(k)));
      if (fields.content) fields.content = fields.content.map(item => {
        if (item.type === 'content' && item.content?.type === 'text') return { type: 'content', content: { type: 'text', text: preview(run, item.content.text, 2000) } };
        if (item.type === 'diff') return { type: 'diff', path: clean(item.path) };
        return { type: item.type, terminalId: item.terminalId };
      });
      run.tools[update.toolCallId] = { ...old, ...fields };
      // The complete stream stays on disk; keep the live UI bounded.
      const ids = Object.keys(run.tools);
      if (ids.length > 30) delete run.tools[ids[0]];

      run.toolHistory ??= [];
      const toolTitle = clean(fields.title ?? old.title ?? update.toolCallId);
      const status = fields.status ?? old.status ?? 'pending';
      const existing = run.toolHistory.find(h => h.toolCallId === update.toolCallId);
      if (existing) {
        existing.status = status;
        if (toolTitle) existing.title = toolTitle;
        if (fields.content) {
          const textItem = fields.content.findLast(c => c.type === 'content' && c.content?.type === 'text');
          if (textItem) existing.output = tail(clean(textItem.content.text), 300);
        }
      } else {
        const entry = { toolCallId: update.toolCallId, title: toolTitle, status, at: Date.now() };
        if (fields.content) {
          const textItem = fields.content.findLast(c => c.type === 'content' && c.content?.type === 'text');
          if (textItem) entry.output = tail(clean(textItem.content.text), 300);
        }
        run.toolHistory.push(entry);
        if (run.toolHistory.length > 30) run.toolHistory.shift();
      }
      break;
    }
    case 'plan': run.plan = update.entries ?? []; break;
    case 'usage_update': run.usage = update; break;
    case 'current_mode_update': run.mode = update.currentModeId; break;
    case 'config_option_update': run.configOptions = selectionSummary(update.configOptions); break;
    case 'session_info_update': {
      const retry = update._meta?.['opencode/retry'];
      if (retry?.error?.message) run.notice = tail(`Retry ${retry.attempt ?? ''}: ${clean(retry.error.message)}`, 1000);
      break;
    }
  }
}

function findOptionValue(option, value) {
  const options = option.options ?? [];
  const flat = options.flatMap(o => o.options ?? [o]);
  const exact = flat.find(o => o.value === value);
  if (exact) return exact.value;
  const byName = flat.find(o => o.name && o.name.toLowerCase() === String(value).toLowerCase());
  if (byName) return byName.value;
  const norm = str => String(str).toLowerCase().replace(/^m:minimax:|^opencode:|^minimax\/|^opencode\/|:v:thinking|:v:/g, '').replace(/[-_.\s]/g, '');
  const targetNorm = norm(value);
  const matches = flat.filter(o => norm(o.value) === targetNorm || (o.name && norm(o.name) === targetNorm));
  if (matches.length > 0) {
    if (option.currentValue && matches.some(m => m.value === option.currentValue)) return option.currentValue;
    const thinking = matches.find(m => m.value.includes('thinking'));
    if (thinking) return thinking.value;
    return matches[0].value;
  }
  const bySub = flat.find(o => norm(o.value).includes(targetNorm) || (o.name && norm(o.name).includes(targetNorm)));
  if (bySub) return bySub.value;
  return undefined;
}

async function configure(connection, run, agent, session) {
  let options = session.configOptions ?? [];
  const desired = new Map();
  for (const category of ['mode', 'model']) {
    if (agent[category] === undefined) continue;
    const option = options.find(o => o.category === category || o.id === category);
    if (option) {
      if (Object.hasOwn(agent.config ?? {}, option.id) && agent.config[option.id] !== agent[category]) throw new Error(`Conflicting ACP ${category} configuration`);
      desired.set(option.id, agent[category]);
    } else if (category === 'mode' && session.modes) {
      if (!session.modes.availableModes?.some(m => m.id === agent.mode)) throw new Error(`ACP mode unavailable: ${agent.mode}`);
      await connection.request('session/set_mode', { sessionId: run.sessionId, modeId: agent.mode });
    } else if (category === 'model' && session.models) {
      if (!session.models.availableModels?.some(m => m.modelId === agent.model)) throw new Error(`ACP model unavailable: ${agent.model}`);
      await connection.request('session/set_model', { sessionId: run.sessionId, modelId: agent.model });
    } else throw new Error(`Harness does not advertise ACP ${category} selection`);
  }
  // Model changes can reset dependent selectors such as reasoning effort.
  for (const [id, value] of Object.entries(agent.config ?? {})) desired.set(id, value);
  for (const [configId, value] of desired) {
    const option = options.find(o => o.id === configId);
    if (!option) throw new Error(`ACP config option unavailable: ${configId}`);
    let valueToSet = value;
    if (option.type === 'select') {
      const resolved = findOptionValue(option, value);
      if (resolved === undefined) throw new Error(`ACP value unavailable: ${configId}=${value}`);
      valueToSet = resolved;
    } else if (option.type !== 'boolean' || typeof value !== 'boolean') throw new Error(`Unsupported ACP config: ${configId}`);
    const result = await connection.request('session/set_config_option', { sessionId: run.sessionId, configId, value: valueToSet });
    options = result?.configOptions ?? options;
  }
  run.configOptions = selectionSummary(options);
  run.model = agent.model ?? options.find(o => o.category === 'model' || o.id === 'model')?.currentValue ?? session.models?.currentModelId;
}

export function detectLoop(run) {
  const history = run.toolHistory ?? [];
  const completedCalls = history.filter(h => h.status === 'completed' || h.status === 'failed');
  const now = Date.now();
  const remainingSeconds = Math.max(0, Math.round(((run.deadline ?? (run.startedAt + (run.timeoutSeconds ?? 600) * 1000)) - now) / 1000));

  // 1. Check for 3+ consecutive identical tool calls with same title and output (or repeated failure)
  if (completedCalls.length >= 3) {
    const last3 = completedCalls.slice(-3);
    const sameTool = last3.every(c => c.title === last3[0].title);
    if (sameTool) {
      const allFailed = last3.every(c => c.status === 'failed');
      const sameOutput = last3.every(c => (c.output || '') === (last3[0].output || ''));
      if (allFailed || (sameOutput && last3[0].output)) {
        return {
          isStuck: true,
          confidence: 'high',
          pattern: allFailed ? 'repeated_failures' : 'repeated_identical_calls',
          message: `Possível loop: a ferramenta '${last3[0].title}' foi executada 3 vezes consecutivas ${allFailed ? 'com falha' : 'com a mesma saída'}.`,
          remainingSeconds,
          repeatedCount: 3,
        };
      }
    }
  }

  // 2. Check for ping-pong alternating pattern (A, B, A, B)
  if (completedCalls.length >= 4) {
    const last4 = completedCalls.slice(-4);
    if (last4[0].title === last4[2].title && last4[1].title === last4[3].title && last4[0].title !== last4[1].title) {
      return {
        isStuck: true,
        confidence: 'medium',
        pattern: 'alternating_cycle',
        message: `Possível loop: padrão alternado detectado entre as ferramentas '${last4[0].title}' e '${last4[1].title}'.`,
        remainingSeconds,
      };
    }
  }

  // 3. Check for high retry count from provider/harness
  if (run.notice && /Retry ([3-9]|\d{2,}):/i.test(run.notice)) {
    return {
      isStuck: true,
      confidence: 'high',
      pattern: 'provider_retry_loop',
      message: `Possível loop: múltiplas tentativas consecutivas falhando (${run.notice}).`,
      remainingSeconds,
    };
  }

  // 4. Check for repeating text in output
  if (run.text && run.text.length > 200) {
    const lines = run.text.split('\n').map(l => l.trim()).filter(l => l.length > 15);
    if (lines.length >= 6) {
      const last6 = lines.slice(-6);
      const unique = new Set(last6);
      if (unique.size <= 2) {
        return {
          isStuck: true,
          confidence: 'high',
          pattern: 'repeating_output_text',
          message: 'Possível loop: o agente está gerando texto repetitivo na resposta.',
          remainingSeconds,
        };
      }
    }
  }

  const toolCount = completedCalls.length;
  return {
    isStuck: false,
    confidence: 'low',
    pattern: 'normal_progress',
    message: toolCount > 0
      ? `Nenhum loop detectado (${toolCount} ações executadas, progresso normal).`
      : 'Nenhum loop detectado (iniciando execução ou processando normalmente).',
    remainingSeconds,
  };
}

/** One isolated process/session per run. Updates are observable before prompt completion. */
export async function executeRun(run, agent, { signal, onChange = () => {}, requestPermission, onTimeoutWarning, logDir = runsDir } = {}) {
  let connection, log, timer, warningTimer, warningFired = false, stopTimer, stopped, logFailure;
  let writes = Promise.resolve();
  const permissionController = new AbortController();
  const permissionWaiters = new Set();
  const record = event => {
    writes = writes.then(() => log.write(JSON.stringify({ at: Date.now(), ...event }) + '\n')).catch(error => {
      logFailure ??= error;
      connection?.fail(new Error(`ACP log write failed: ${error.message}`));
    });
  };
  const changed = () => onChange(run);
  const stage = id => {
    const now = Date.now();
    for (const item of run.stages ?? []) if (item.status === 'running') { item.status = 'completed'; item.finishedAt = now; }
    const item = run.stages?.find(item => item.id === id);
    if (item) { item.status = 'running'; item.startedAt = now; }
    changed();
  };
  const stop = reason => {
    if (stopped || run.finishedAt) return;
    stopped = reason;
    permissionController.abort();
    run.status = reason;
    for (const cancel of permissionWaiters) cancel();
    if (run.sessionId) connection?.notify('session/cancel', { sessionId: run.sessionId });
    changed();
    // Let the harness acknowledge session/cancel before closing its process group.
    stopTimer = setTimeout(() => connection?.fail(new Error(reason)), 700);
  };
  const abort = () => stop('cancelled');

  const timeoutSec = run.timeoutSeconds ?? agent.timeoutSeconds ?? 600;
  run.timeoutSeconds = timeoutSec;
  run.startedAt = Date.now();
  run.deadline = run.startedAt + timeoutSec * 1000;

  function scheduleTimers() {
    clearTimeout(timer);
    clearTimeout(warningTimer);
    if (stopped || run.finishedAt) return;
    const now = Date.now();
    const remainingMs = Math.max(0, run.deadline - now);
    timer = setTimeout(() => stop('timed_out'), remainingMs);

    if (!warningFired && onTimeoutWarning && remainingMs > 0) {
      const leadSec = Math.min(60, Math.max(1, Math.floor(run.timeoutSeconds * 0.2)));
      const warnInMs = (run.deadline - leadSec * 1000) - now;
      const delay = Math.max(0, warnInMs);
      warningTimer = setTimeout(() => {
        if (stopped || run.finishedAt || warningFired) return;
        warningFired = true;
        const remSec = Math.max(1, Math.round((run.deadline - Date.now()) / 1000));
        onTimeoutWarning(run, remSec);
      }, delay);
    }
  }

  run.extendTimeout = additionalSeconds => {
    if (stopped || run.finishedAt) throw new Error('Cannot extend timeout of finished run');
    if (!Number.isInteger(additionalSeconds) || additionalSeconds < 1 || additionalSeconds > 86400) {
      throw new Error('Timeout extension must be between 1 and 86400 seconds');
    }
    run.timeoutSeconds += additionalSeconds;
    run.deadline += additionalSeconds * 1000;
    warningFired = false;
    scheduleTimers();
    record({ type: 'timeout_extended', addedSeconds: additionalSeconds, newTimeoutSeconds: run.timeoutSeconds, deadline: run.deadline });
    changed();
    return {
      timeoutSeconds: run.timeoutSeconds,
      remainingSeconds: Math.max(0, Math.round((run.deadline - Date.now()) / 1000)),
    };
  };

  run.setTimeoutSeconds = newTotalSeconds => {
    if (stopped || run.finishedAt) throw new Error('Cannot set timeout of finished run');
    if (!Number.isInteger(newTotalSeconds) || newTotalSeconds < 1 || newTotalSeconds > 86400) {
      throw new Error('timeoutSeconds must be between 1 and 86400');
    }
    run.timeoutSeconds = newTotalSeconds;
    run.deadline = run.startedAt + newTotalSeconds * 1000;
    if (run.deadline <= Date.now()) {
      stop('timed_out');
      return { timeoutSeconds: run.timeoutSeconds, remainingSeconds: 0 };
    }
    warningFired = false;
    scheduleTimers();
    record({ type: 'timeout_updated', newTimeoutSeconds: run.timeoutSeconds, deadline: run.deadline });
    changed();
    return {
      timeoutSeconds: run.timeoutSeconds,
      remainingSeconds: Math.max(0, Math.round((run.deadline - Date.now()) / 1000)),
    };
  };
  try {
    if (signal?.aborted) { run.status = 'cancelled'; return run; }
    stage('prepare');
    if (!(await stat(run.cwd)).isDirectory()) throw new Error(`Not a directory: ${run.cwd}`);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    run.logPath = resolve(logDir, `${run.id}.jsonl`);
    log = await open(run.logPath, 'wx', 0o600);
    record({ type: 'start', id: run.id, agent: run.agent, harness: run.harness, task: run.task, cwd: run.cwd });
    signal?.addEventListener('abort', abort, { once: true });
    scheduleTimers();
    stage('connect');
    connection = new AcpConnection(agent.command, agent.args, {
      cwd: run.cwd, env: agent.env,
      onStderr: data => { run.stderr = tail((run.stderr ?? '') + clean(data), 4000); record({ type: 'stderr', text: data }); },
      onNotification: (method, params) => {
        if (method !== 'session/update' || !params?.update) return;
        if (run.sessionId && params.sessionId !== run.sessionId) return;
        record({ type: 'update', ...params });
        applyUpdate(run, params.update);
        changed();
      },
      onRequest: async (method, params) => {
        if (method !== 'session/request_permission') {
          const error = new Error(`Client capability not supported: ${method}`); error.code = -32601; throw error;
        }
        if (!run.sessionId || params?.sessionId !== run.sessionId || stopped) return { outcome: { outcome: 'cancelled' } };
        run.status = 'permission'; changed();
        record({ type: 'permission', toolCall: params.toolCall, options: params.options });
        let outcome = { outcome: 'cancelled' };
        try {
          const policy = agent.permissions ?? 'ask';
          if (policy === 'allow' || policy === 'deny') {
            const option = params.options?.find(o => o.kind === (policy === 'allow' ? 'allow_once' : 'reject_once'));
            if (option) outcome = { outcome: 'selected', optionId: option.optionId };
          } else if (requestPermission) {
            let cancel;
            const cancelled = new Promise(resolve => { cancel = () => resolve(undefined); });
            permissionWaiters.add(cancel);
            try {
              const optionId = await Promise.race([requestPermission(run, params, permissionController.signal), cancelled]);
              if (!stopped && params.options?.some(o => o.optionId === optionId)) outcome = { outcome: 'selected', optionId };
            } finally { permissionWaiters.delete(cancel); }
          }
        } finally {
          if (!stopped) run.status = 'running';
          record({ type: 'permission_result', outcome }); changed();
        }
        return { outcome };
      },
    });
    // Cover cancellation during directory/log setup before the listener was attached.
    if (signal?.aborted) abort();
    const init = await connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: 'pi-acp-subagents', version: '1.0.0' },
    });
    if (init?.protocolVersion !== 1) throw new Error(`Unsupported ACP protocol version: ${init?.protocolVersion}`);
    stage('session');
    const session = await connection.request('session/new', { cwd: run.cwd, mcpServers: [] });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('ACP session/new returned no sessionId');
    run.sessionId = session.sessionId;
    record({ type: 'session', ...session });
    stage('configure');
    await configure(connection, run, agent, session);
    if (stopped) throw new Error(stopped);
    run.status = 'running'; stage('execute');
    const instructions = agent.instructions?.trim();
    const prompt = instructions ? `Agent instructions:\n${instructions}\n\nTask:\n${run.task}` : run.task;
    const response = await connection.request('session/prompt', { sessionId: run.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0);
    run.stopReason = response?.stopReason;
    if (!run.stopReason) throw new Error('ACP session/prompt returned no stopReason');
    run.status = stopped ?? (run.stopReason === 'end_turn' ? 'completed' : run.stopReason === 'cancelled' ? 'cancelled' : 'failed');
    if (run.status === 'failed') run.error = `ACP stopped: ${run.stopReason}`;
  } catch (error) {
    run.status = stopped ?? 'failed';
    run.error = error.code === -32000 ? `${error.message}. Authenticate in the harness CLI, then retry.` : error.message;
  } finally {
    clearTimeout(timer); clearTimeout(warningTimer); clearTimeout(stopTimer);
    permissionController.abort();
    signal?.removeEventListener('abort', abort);
    for (const cancel of permissionWaiters) cancel();
    if (connection) await connection.close();
    run.finishedAt = Date.now();
    for (const item of run.stages ?? []) if (item.status === 'running') {
      item.status = run.status; item.finishedAt = run.finishedAt;
    }
    if (log) {
      record({ type: 'finish', status: run.status, stopReason: run.stopReason, error: run.error, usage: run.usage });
      await writes;
      await log.close();
      if (logFailure) { run.status = 'failed'; run.error = `ACP log write failed: ${logFailure.message}`; }
    }
    changed();
  }
  return run;
}

export function runText(run, { expanded = false } = {}) {
  const duration = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);
  const lines = [`${run.id.slice(0, 8)} ${run.agent} (${run.harness}) · ${run.status} · ${duration}s`];
  if (run.usage) {
    const u = run.usage;
    lines.push(`Context: ${u.used ?? '?'} / ${u.size ?? '?'} tokens${u.cost ? ` · ${u.cost.amount} ${u.cost.currency}` : ''}`);
  }
  const tools = Object.values(run.tools);
  for (const tool of tools.slice(expanded ? -30 : -3)) {
    lines.push(`  ${clean(tool.title ?? tool.toolCallId)} · ${tool.status ?? 'pending'}`);
    if (expanded) for (const c of tool.content ?? []) {
      if (c.type === 'content' && c.content?.type === 'text') lines.push(clean(c.content.text));
      if (c.type === 'diff') lines.push(`  diff: ${clean(c.path)}`);
    }
    if (!expanded) {
      const output = tool.content?.findLast(c => c.type === 'content' && c.content?.type === 'text');
      if (output) lines.push(`    ${tail(clean(output.content.text), 180).split('\n').filter(Boolean).at(-1) ?? ''}`);
    }
  }
  if (expanded) for (const item of run.plan ?? []) lines.push(`  [${item.status}] ${clean(item.content)}`);
  if (!run.text && run.thought && !run.finishedAt) lines.push(`  ${tail(run.thought, expanded ? 2000 : 180)}`);
  if (run.text) lines.push(expanded ? run.text : run.text.split('\n').filter(Boolean).slice(-3).join('\n'));
  if (run.error) lines.push(`Error: ${clean(run.error)}`);
  if (run.notice) lines.push(clean(run.notice));
  if (run.previewTruncated) lines.push('Preview limited; complete output in the full stream log.');
  if (run.status === 'failed' && run.stderr) lines.push(run.stderr);
  if (run.logPath && (expanded || run.finishedAt)) lines.push(`Full stream: ${run.logPath}`);
  return clean(lines.join('\n'));
}
