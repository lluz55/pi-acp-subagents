import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { configPath, loadConfig, resolveAgent } from './config.mjs';

let modelWrites = Promise.resolve();
export function setDefaultModel(name, model, path = configPath) {
const save = modelWrites.then(async () => {
const config = await loadConfig(path);
resolveAgent(config, name);
if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('ACP config: model must be non-empty');
let custom = {};
try { custom = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
custom.agents ??= {};
const agent = { ...config.agents[name] };
if (model === undefined) delete agent.model;
else agent.model = model;
custom.agents[name] = agent;
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const temporary = `${path}.${randomUUID()}.tmp`;
try {
await writeFile(temporary, JSON.stringify(custom, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await loadConfig(temporary);
await rename(temporary, path);
} finally { await rm(temporary, { force: true }); }
});
modelWrites = save.catch(() => {});
return save;
}
