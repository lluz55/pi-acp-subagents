import { clean } from './run.mjs';

export const sectionNames = ['stages', 'plan', 'tools', 'output', 'diagnostics'];
const labels = { pending: 'Pendente', in_progress: 'Em andamento', starting: 'Iniciando', running: 'Executando', permission: 'Aguardando usuário', completed: 'Concluído', failed: 'Falhou', cancelled: 'Cancelado', timed_out: 'Tempo esgotado' };
const marks = { completed: '[ok]', failed: '[!]', cancelled: '[-]', timed_out: '[!]', running: '[~]', pending: '[ ]', permission: '[?]', starting: '[~]', in_progress: '[~]' };
const stageNames = { prepare: 'Preparar arquivos', connect: 'Conectar harness', session: 'Abrir sessão', configure: 'Configurar modelo', execute: 'Executar tarefa' };
const oneLine = value => clean(value).replace(/\s+/g, ' ').trim();
const linesOf = value => clean(value).replace(/\t/g, '  ').split('\n');
const clip = (value, max = 180) => { const s = oneLine(value); return s.length > max ? `${s.slice(0, max)}…` : s; };
const colorFor = status => status === 'completed' ? 'success' : ['failed', 'timed_out'].includes(status) ? 'error' : ['permission', 'cancelled'].includes(status) ? 'warning' : 'accent';

export function formatTokens(num) {
  if (num === undefined || num === null) return '0 tok';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M tok`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k tok`;
  return `${num} tok`;
}

export function lastAction(run) {
  if (run.error) return `Erro: ${oneLine(run.error)}`;
  if (run.status === 'permission') return `Aguardando permissão: ${oneLine(run.attention || 'resposta necessária')}`;
  if (run.attention) return `Pedido: ${oneLine(run.attention)}`;
  if (run.notice) return oneLine(run.notice);

  const tools = Object.values(run.tools ?? {});
  if (tools.length > 0) {
    const lastTool = tools.at(-1);
    const title = oneLine(lastTool.title ?? lastTool.toolCallId ?? 'ferramenta');
    if (lastTool.status === 'failed') return `Falha: ${title}`;
    if (lastTool.status === 'completed') return title;
    return `Executando: ${title}`;
  }

  const plan = run.plan ?? [];
  const activePlan = plan.find(p => p.status === 'in_progress') ?? plan.find(p => p.status === 'pending');
  if (activePlan) return `Plano: ${oneLine(activePlan.content)}`;

  const stages = run.stages ?? [];
  const current = stages.find(s => s.status === 'running') ?? stages.find(s => s.status !== 'completed');
  if (current && current.id !== 'execute') {
    return `Etapa: ${stageNames[current.id] ?? oneLine(current.id)}`;
  }

  const output = linesOf(run.text ?? '').filter(Boolean);
  if (output.length > 0) {
    return oneLine(output.at(-1));
  }

  if (run.thought) {
    const thoughts = linesOf(run.thought).filter(Boolean);
    if (thoughts.length > 0) return `Pensando: ${oneLine(thoughts.at(-1))}`;
  }

  return `Tarefa: ${oneLine(run.task)}`;
}

export function modelDisplay(run) {
  const rawModel = oneLine(run.model ?? '');
  const cleanModel = rawModel
    .replace(/^(minimax|opencode|codex|claude)\//i, '')
    .replace(/^m:minimax:([^:]+):v:.*$/, '$1')
    .replace(new RegExp(`^(${run.agent}|${run.harness})/`), '');
  return cleanModel || 'padrão';
}

export function compactLine(run) {
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
  const mark = marks[run.status] ?? '[~]';
  const label = labels[run.status] ?? oneLine(run.status);
  const statusWithTime = `${label} (${seconds}s)`;
  const agentName = oneLine(run.agent);
  const modelName = modelDisplay(run);
  const tokensStr = formatTokens(run.usage?.used);
  const action = clip(lastAction(run), 80);
  return `${mark} ${agentName} · ${modelName} · ${statusWithTime} · ${tokensStr} · ${action}`;
}

export function runSummary(run) {
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
  return `${marks[run.status] ?? '[~]'} ${oneLine(run.agent)} · ${run.id.slice(0, 8)} · ${labels[run.status] ?? oneLine(run.status)} · ${seconds}s`;
}

// Plain rows keep model-facing content separate from terminal styling and layout.
export function cardRows(run, { expanded = false, sections = new Set(), live = false } = {}) {
  const open = name => expanded || sections.has(name);
  const rows = [];
  const row = (text, color = 'muted') => rows.push({ text, color });

  if (!expanded && sections.size === 0) {
    return [{ text: compactLine(run), color: colorFor(run.status) }];
  }

  rows.push({ text: runSummary(run), color: colorFor(run.status) });
  row(`Harness: ${oneLine(run.harness)} · Modelo: ${oneLine(run.model ?? 'padrão do harness')}`);
  row(`Tarefa: ${clip(run.task)}`);
  if (!run.finishedAt && run.timeoutSeconds) {
    const elapsed = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
    const rem = Math.max(0, Math.round(((run.deadline ?? (run.startedAt + run.timeoutSeconds * 1000)) - Date.now()) / 1000));
    row(`Timeout: ${run.timeoutSeconds}s · Decorrido: ${elapsed}s · Restante: ~${rem}s`);
  }
  const stages = run.stages ?? [];
  const current = stages.find(s => s.status !== 'completed') ?? stages.at(-1);
  if (current) row(`Etapa: ${stageNames[current.id] ?? oneLine(current.id)} · ${labels[current.status] ?? oneLine(current.status)}`, colorFor(current.status));
  if (run.status === 'permission') row('[?] Responda ao seletor de permissão do pi.', 'warning');
  if (run.attention) row(`Pedido: ${clip(run.attention, 300)}`, 'warning');
  if (run.notice) row(`Aviso: ${clip(run.notice)}`, 'warning');
  if (run.error) row(`Erro: ${clip(run.error, 400)}`, 'error');
  if (run.usage) {
    const u = run.usage;
    row(`Contexto: ${u.used ?? '?'} / ${u.size ?? '?'} tokens${u.cost ? ` · ${u.cost.amount} ${oneLine(u.cost.currency)}` : ''}`);
  }
  const block = (name, title, values, limit) => {
    if (!values.length) return;
    row(`${open(name) ? '▾' : '▸'} ${title} (${values.length})`, 'accent');
    if (!open(name)) return;
    for (const value of values.slice(0, limit)) row(`  ${value}`, 'text');
    if (values.length > limit) row(`  … ${values.length - limit} linhas/itens omitidos; consulte log completo.`, 'dim');
  };
  block('stages', 'Etapas', stages.map(s => `${marks[s.status] ?? '[ ]'} ${stageNames[s.id] ?? oneLine(s.id)} · ${labels[s.status] ?? oneLine(s.status)}`), 8);
  block('plan', 'Plano do agente', (run.plan ?? []).map(p => `${marks[p.status] ?? '[ ]'} ${oneLine(p.content)}`), live ? 5 : 30);
  const tools = Object.values(run.tools ?? {});
  block('tools', 'Ferramentas recentes', tools.flatMap(t => {
    const head = `${marks[t.status] ?? '[ ]'} ${oneLine(t.title ?? t.toolCallId)} · ${oneLine(t.status ?? 'pending')}`;
    if (live) return [head];
    return [head, ...(t.content ?? []).flatMap(c => c.type === 'content' && c.content?.type === 'text' ? linesOf(c.content.text).map(l => `  ${l}`) : c.type === 'diff' ? [`  diff: ${oneLine(c.path)}`] : [])];
  }), live ? 4 : 60);
  const output = linesOf(run.text ?? '').filter(Boolean);
  block('output', run.finishedAt ? 'Resposta do agente' : 'Saída parcial', output, live ? 6 : 160);
  if (output.length && !open('output')) row(`  ${clip(output.at(-1))}`, 'text');
  const diagnostics = [
    `Diretório: ${oneLine(run.cwd)}`,
    ...(run.error ? [`Erro completo: ${clean(run.error)}`] : []),
    ...(run.stderr ? [`stderr: ${clean(run.stderr)}`] : []),
    ...(run.logPath ? [`Log completo: ${oneLine(run.logPath)}`] : []),
  ].flatMap(linesOf);
  block('diagnostics', 'Diagnóstico', diagnostics, live ? 4 : 40);
  if (run.previewTruncated) row('Prévia limitada; saída completa no log.', 'warning');
  return rows;
}

export function cardComponent(runs, options, theme, truncate) {
  const isCompact = !options?.expanded && (!options?.sections || options.sections.size === 0);
  return {
    render(width) {
      if (width <= 0) return [];
      const style = (color, text) => theme?.fg ? theme.fg(color, text) : text;
      if (isCompact) {
        return runs.map(run => {
          const rows = cardRows(run, options);
          const r = rows[0] ?? { text: '', color: 'text' };
          return truncate(style(r.color, clean(r.text)), width);
        });
      }
      return runs.flatMap((run, i) => [
        ...(i ? [''] : []),
        truncate(style('dim', '┌─ ACP ─────────────────────────────────────────'), width),
        ...cardRows(run, options).map(r => truncate(style('dim', '│ ') + style(r.color, clean(r.text)), width)),
        truncate(style('dim', '└───────────────────────────────────────────────'), width),
      ]);
    },
    invalidate() {},
  };
}

export function notificationText(run, event, attention) {
  // Keep tool traces out of the result message. Full stream stays available on disk.
  const lines = [runSummary(run), `Harness: ${oneLine(run.harness)}`, `Tarefa: ${oneLine(run.task)}`];
  if (event === 'attention' || event === 'timeout_warning') lines.push(clean(attention));
  else if (run.text) lines.push('Resposta do agente:', clean(run.text));
  if (run.error) lines.push(`Erro: ${clean(run.error)}`);
  if (run.logPath) lines.push(`Log completo: ${oneLine(run.logPath)}`);
  if (run.previewTruncated) lines.push('Prévia limitada; consulte log completo.');
  return lines.join('\n');
}
