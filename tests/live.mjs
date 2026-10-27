// Opt-in: sends a tiny real prompt to each selected harness/provider.
// Not included in npm test. No editing or tool use is requested.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveAgent } from '../config.mjs';
import { executeRun, newRun } from '../run.mjs';
const directory = await mkdtemp(join(tmpdir(), 'pi-acp-live-'));
const config = await loadConfig();
const models = { opencode: 'opencode/deepseek-v4.1-flash-free', ...JSON.parse(process.env.PI_ACP_SMOKE_MODELS || '{}') };
let failures = 0;
try {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'opencode', 'claude', 'mcode']) {
    const agent = { ...resolveAgent(config, name), timeoutSeconds: 60, permissions: 'deny' };
    if (models[name]) agent.model = models[name];
    const run = newRun(agent, 'Reply with exactly ACP_OK. Do not use any tools, read files, or modify files.', directory);
    let updatesBeforeFinish = 0;
    await executeRun(run, agent, { onChange: r => { if (r.text && !r.finishedAt) updatesBeforeFinish++; } });
    const ok = run.status === 'completed' && run.text.trim() === 'ACP_OK';
    if (!ok) failures++;
    console.log(JSON.stringify({ harness: name, ok, status: run.status, text: run.text, error: run.error, stderr: run.status === 'failed' ? run.stderr : undefined, updatesBeforeFinish, usage: run.usage, logPath: run.logPath }));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
