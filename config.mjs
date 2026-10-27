import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const extensionDir = dirname(fileURLToPath(import.meta.url));
export const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent');
export const configPath = process.env.PI_ACP_CONFIG || resolve(agentDir, 'acp-agents.json');
export const runsDir = process.env.PI_ACP_RUNS_DIR || resolve(agentDir, 'acp-runs');
const executable = name => resolve(extensionDir, 'node_modules/.bin', name);

export const defaults = {
  harnesses: {
    codex: { command: executable('codex-acp'), args: [] },
    opencode: { command: 'opencode', args: ['acp'] },
    claude: { command: executable('claude-agent-acp'), args: [] },
    mcode: { command: 'mcode', args: ['acp'] },
  },
  agents: {
    codex: { harness: 'codex', description: 'General coding with Codex' },
    opencode: { harness: 'opencode', description: 'General coding with OpenCode' },
    claude: { harness: 'claude', description: 'General coding with Claude Code' },
    mcode: { harness: 'mcode', description: 'General coding with MiniMax Code' },
  },
};

function check(condition, message) { if (!condition) throw new Error(`ACP config: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function strings(value) { return object(value) && Object.values(value).every(v => typeof v === 'string'); }

export async function loadConfig(path = configPath) {
  let custom = {};
  try { custom = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`ACP config ${path}: ${error.message}`); }
  check(object(custom), 'expected an object');
  for (const key of Object.keys(custom)) check(['harnesses', 'agents'].includes(key), `unknown field ${key}`);
  for (const key of ['harnesses', 'agents']) check(custom[key] === undefined || object(custom[key]), `${key} must be an object`);
  const harnesses = { ...defaults.harnesses };
  for (const [name, value] of Object.entries(custom.harnesses ?? {})) {
    check(object(value), `harness ${name} must be an object`);
    harnesses[name] = { ...harnesses[name], ...value };
  }
  const agents = { ...defaults.agents, ...custom.agents };
  for (const [name, h] of Object.entries(harnesses)) {
    check(/^[a-z0-9][a-z0-9_-]*$/.test(name), `invalid harness name ${name}`);
    check(Object.keys(h).every(k => ['command', 'args', 'env'].includes(k)), `unknown field in harness ${name}`);
    check(typeof h.command === 'string' && h.command.length > 0, `${name}.command required`);
    check(Array.isArray(h.args) && h.args.every(v => typeof v === 'string'), `${name}.args must be strings`);
    check(h.env === undefined || strings(h.env), `${name}.env must contain strings`);
  }
  for (const [name, a] of Object.entries(agents)) {
    check(/^[a-z0-9][a-z0-9_-]*$/.test(name) && object(a), `invalid agent ${name}`);
    check(Object.keys(a).every(k => ['harness', 'description', 'instructions', 'model', 'mode', 'config', 'cwd', 'timeoutSeconds', 'permissions'].includes(k)), `unknown field in agent ${name}`);
    check(Object.hasOwn(harnesses, a.harness), `unknown harness for ${name}: ${a.harness}`);
    for (const key of ['description', 'instructions', 'model', 'mode', 'cwd']) check(a[key] === undefined || typeof a[key] === 'string', `${name}.${key} must be a string`);
    check(a.config === undefined || (object(a.config) && Object.values(a.config).every(v => typeof v === 'string' || typeof v === 'boolean')), `${name}.config must contain strings or booleans`);
    check(a.cwd === undefined || isAbsolute(a.cwd), `${name}.cwd must be absolute`);
    check(a.permissions === undefined || ['ask', 'deny', 'allow'].includes(a.permissions), `${name}.permissions: ask, deny, or allow`);
    check(a.timeoutSeconds === undefined || (Number.isInteger(a.timeoutSeconds) && a.timeoutSeconds >= 1 && a.timeoutSeconds <= 86400), `${name}.timeoutSeconds must be 1–86400`);
  }
  return { harnesses, agents };
}

export function resolveAgent(config, name) {
  if (!Object.hasOwn(config.agents, name)) throw new Error(`Unknown ACP agent: ${name}. Use acp_agents or /acp list.`);
  const agent = config.agents[name];
  return { name, ...agent, ...config.harnesses[agent.harness] };
}
