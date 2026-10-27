import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

test('installed pi discovers global ACP extension and skill', { skip: !process.env.PI_TEST_BINARY, timeout: 30000 }, async () => {
  const child = spawn(process.env.PI_TEST_BINARY, ['--offline', '--mode', 'rpc', '--no-session', '--no-themes'], {
    cwd: tmpdir(), env: { ...process.env, PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  try {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC startup timeout: ${stderr}`)), 20000);
      child.stdout.on('data', data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'response' && event.id === 'commands') { clearTimeout(timer); resolve(event); }
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`pi exited: ${stderr}`)); });
    });
    child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
    const response = await result;
    assert.equal(response.success, true);
    assert.equal(response.data.commands.filter(c => c.name === 'acp' && c.source === 'extension').length, 1);
    assert.ok(response.data.commands.some(c => c.name === 'skill:acp-subagents' && c.source === 'skill'));
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
});
