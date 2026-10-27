// Real harness smoke test; initialize/session/new only, no model prompts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveAgent } from '../config.mjs';
import { AcpConnection } from '../transport.mjs';
const directory = await mkdtemp(join(tmpdir(), 'pi-acp-handshake-'));
const config = await loadConfig();
let failures = 0;
try {
  for (const name of ['codex', 'opencode', 'claude', 'mcode']) {
    const agent = resolveAgent(config, name);
    let stderr = '';
    const connection = new AcpConnection(agent.command, agent.args, {
      cwd: directory, env: agent.env, onStderr: text => { stderr = (stderr + text).slice(-2000); },
      onRequest: () => ({ outcome: { outcome: 'cancelled' } }),
    });
    try {
      const init = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } }, clientInfo: { name: 'pi-acp-smoke', version: '1.0.0' } });
      if (init.protocolVersion !== 1) throw new Error(`Unsupported protocol: ${init.protocolVersion}`);
      const session = await connection.request('session/new', { cwd: directory, mcpServers: [] });
      if (!session.sessionId) throw new Error('Missing sessionId');
      console.log(JSON.stringify({ harness: name, ok: true, agentInfo: init.agentInfo, configOptions: session.configOptions?.map(o => ({ id: o.id, category: o.category, currentValue: o.currentValue })), modes: session.modes?.availableModes?.map(m => m.id) }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ harness: name, ok: false, error: error.message, stderr }));
    } finally { await connection.close(); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
