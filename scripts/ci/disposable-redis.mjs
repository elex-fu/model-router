import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function startDisposableRedis({ binary, directory, port }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [6379, 6380].includes(port)) throw new Error('disposable Redis requires a nondefault port');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'redis.log'), 'wx', 0o600);
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--dir', directory, '--daemonize', 'no'], { stdio: ['ignore', log.fd, log.fd], env: { PATH: process.env.PATH } });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill('SIGTERM');
      await closed;
      clearTimeout(timeout);
    }
    await log.close();
    return true;
  })();
  try {
    for (let index = 0; index < 100; index++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Redis exited before readiness');
      if (!(await readFile(join(directory, 'redis.log'), 'utf8')).includes('Ready to accept connections')) {
        await delay(50);
        continue;
      }
      const ready = await new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(200, () => done(false));
        socket.once('error', () => done(false));
        socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
        socket.once('data', (bytes) => done(bytes.toString('utf8').startsWith('+PONG\r\n')));
      });
      if (ready) return { url: `redis://127.0.0.1:${port}`, stop };
      await delay(50);
    }
    throw new Error('owned Redis did not become ready');
  } catch (error) { await stop(); throw error; }
}
