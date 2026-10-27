// Deterministic ACP agent: no provider credentials, network, or model calls.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const scenario = process.argv[2] ?? 'normal';
const sessionId = 'fixture-session';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const configOptions = [
  { id: 'chosen-model', category: 'model', type: 'select', currentValue: 'default', options: [{ group: 'test', options: [{ value: 'test-model' }, { value: 'default' }] }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask' }] },
  { id: 'reasoning', type: 'select', currentValue: 'high', options: [{ value: 'high' }] },
  { id: 'flag', type: 'boolean', currentValue: false },
];
let promptId, promptTimer;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (id === 'permission') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission=${JSON.stringify(message.result)}\n` } });
    reply(promptId, { stopReason: 'end_turn' }); continue;
  }
  if (method === 'initialize') {
    if (scenario === 'bad-stdout') { process.stdout.write('debug on stdout\n'); continue; }
    if (scenario === 'crash') { process.stderr.write('fixture crash'); process.exit(3); }
    if (scenario === 'hang-init') continue;
    reply(id, { protocolVersion: scenario === 'v2' ? 2 : 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } });
  } else if (method === 'session/new') {
    if (scenario === 'auth') { send({ id, error: { code: -32000, message: 'Authentication required' } }); continue; }
    reply(id, { sessionId, configOptions: scenario === 'legacy' ? undefined : configOptions,
      ...(scenario === 'legacy' ? { modes: { availableModes: [{ id: 'ask' }] }, models: { availableModels: [{ modelId: 'test-model' }] } } : {}) });
  } else if (['session/set_config_option', 'session/set_mode', 'session/set_model'].includes(method)) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${method}:${JSON.stringify(params)}\n` } });
    reply(id, { configOptions: scenario === 'legacy' ? undefined : configOptions });
  } else if (method === 'session/prompt') {
    promptId = id;
    if (scenario === 'grandchild') {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(params.prompt[0].text, String(child.pid));
    }
    if (['permission', 'permission-hang'].includes(scenario)) {
      send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call', title: 'Read fixture' }, options: [
        { optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Reject once' },
      ] } }); continue;
    }
    if (scenario === 'unsupported-request') send({ id: 'unsupported', method: 'fs/read_text_file', params: { sessionId, path: '/does-not-exist' } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking fixture' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read fixture', status: 'pending' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call', title: null, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture tool result' } }] });
    update({ sessionUpdate: 'plan', entries: [{ content: 'Read fixture', status: 'completed', priority: 'medium' }] });
    update({ sessionUpdate: 'usage_update', used: 42, size: 1000, cost: { amount: 0.01, currency: 'USD' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } });
    send({ method: 'session/update', params: { sessionId: 'different-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG SESSION' } } } });
    // Intentionally split a multibyte UTF-8 character across writes.
    const utf = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ação' } } } }) + '\n');
    const cut = utf.indexOf(Buffer.from('ç')) + 1;
    process.stdout.write(utf.subarray(0, cut));
    setTimeout(() => process.stdout.write(utf.subarray(cut)), 20);
    if (['ignore-cancel', 'grandchild'].includes(scenario)) continue;
    promptTimer = setTimeout(() => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\nfinal: ${params.prompt[0].text}` } });
      reply(id, { stopReason: scenario === 'max-tokens' ? 'max_tokens' : 'end_turn' });
    }, 220);
  } else if (method === 'session/cancel' && !['ignore-cancel', 'grandchild'].includes(scenario)) {
    clearTimeout(promptTimer); reply(promptId, { stopReason: 'cancelled' });
  }
}
