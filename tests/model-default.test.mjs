import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.mjs';
import { setDefaultModel } from '../model-default.mjs';

test('persist model defaults, preserve settings, serialize changes and reject invalid writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-model-'));
  const path = join(dir, 'nested', 'agents.json');
  try {
    await setDefaultModel('codex', 'chosen', path);
    assert.equal((await loadConfig(path)).agents.codex.model, 'chosen');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await Promise.all([setDefaultModel('claude', 'model-c', path), setDefaultModel('mcode', 'model-m', path)]);
    const config = await loadConfig(path);
    assert.equal(config.agents.claude.model, 'model-c');
    assert.equal(config.agents.mcode.model, 'model-m');
    const custom = JSON.parse(await readFile(path, 'utf8'));
    custom.agents.codex.permissions = 'deny';
    custom.agents.codex.instructions = 'Keep instructions';
    await writeFile(path, JSON.stringify(custom));
    await setDefaultModel('codex', undefined, path);
    const cleared = (await loadConfig(path)).agents.codex;
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.permissions, 'deny');
    assert.equal(cleared.instructions, 'Keep instructions');
    const before = await readFile(path, 'utf8');
    await assert.rejects(setDefaultModel('missing', 'x', path), /Unknown ACP agent/);
    await assert.rejects(setDefaultModel('codex', ' ', path), /non-empty/);
    assert.equal(await readFile(path, 'utf8'), before);
    await writeFile(path, '{invalid');
    await assert.rejects(setDefaultModel('codex', 'x', path), /ACP config/);
    assert.equal(await readFile(path, 'utf8'), '{invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
