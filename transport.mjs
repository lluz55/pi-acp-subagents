import { spawn } from 'node:child_process';

/** ACP v1: newline-delimited JSON-RPC, with bidirectional requests. */
export class AcpConnection {
  constructor(command, args, { cwd, env, onNotification, onRequest, onStderr }) {
    this.pending = new Map();
    this.serial = 0;
    this.buffer = '';
    this.child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: false,
    });
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => onStderr?.(data));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => {
      this.fail(new Error(`Cannot start ${command}: ${error.message}`));
      this.resolveClosed();
    });
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`ACP process exited (${signal ?? code})`));
      this.resolveClosed();
    });
    this.child.stdout.on('data', data => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.length > 8 * 1024 * 1024) { this.fail(new Error('ACP message exceeds 8 MiB')); return; }
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
          if (!message || message.jsonrpc !== '2.0') throw new Error('Not JSON-RPC 2.0');
        } catch {
          this.fail(new Error('Invalid ACP stdout: expected newline-delimited JSON-RPC 2.0'));
          return;
        }
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            Promise.resolve().then(() => onRequest?.(message.method, message.params))
              .then(result => this.send({ id: message.id, result: result ?? null }))
              .catch(error => {
                this.send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
              });
          } else {
            try { onNotification?.(message.method, message.params); }
            catch (error) { this.fail(error); }
          }
        } else if (message.id !== undefined) {
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) {
            const error = new Error(`ACP ${waiter.method}: ${message.error.message} (${message.error.code})`);
            error.code = message.error.code;
            waiter.reject(error);
          } else waiter.resolve(message.result);
        }
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.fail(new Error('ACP message exceeds 8 MiB'));
    });
  }

  send(message) {
    if (!this.failure && !this.child.stdin.destroyed) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    }
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP timeout: ${method}`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params) { this.send({ method, params }); }

  fail(error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.pending.clear();
  }

  kill(signal) {
    // Kill the process group too: adapters may launch a harness child process.
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async close() {
    this.fail(new Error('ACP connection closed'));
    this.child.stdin.end();
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill('SIGKILL'), 800);
    // Always signal the group after exit as well, so grandchildren cannot outlive us.
    await this.closed;
    this.kill('SIGKILL');
    clearTimeout(timer);
  }
}
