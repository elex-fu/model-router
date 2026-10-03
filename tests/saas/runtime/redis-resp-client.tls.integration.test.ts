import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer, type TLSSocket } from 'node:tls';
import { decodeRedisResp2, REDIS_RESP_BOUNDS } from '../../../src/saas/runtime/redis-resp-client.js';

// Real verified TLS transport to synthetic RESP only. No Redis executable,
// Redis Lua/ACL claim, cloud/provider, trust-store change or configured URL.
type Mode = 'verified' | 'wrong-san' | 'unknown-ca' | 'uncertain-eval';
class ProofFailure extends Error {
  constructor(code: string) { super('RUN01_TLS/' + code); this.stack = this.message; }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProofFailure(code);
}
async function bounded<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProofFailure(code)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const sourceRoot = resolve(__dirname, '../../..');
const sourceMode = __filename.endsWith('.ts');
const childPath = join(__dirname,
  'redis-resp-tls-child.fixture.' + (sourceMode ? 'ts' : 'js'));
const cleanEnv = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C', TZ: 'UTC' };
function openssl(directory: string, args: string[]): void {
  const result = spawnSync('openssl', args, {
    cwd: directory, env: { ...cleanEnv, TMPDIR: directory },
    stdio: 'ignore', timeout: 4_000,
  });
  check(result.status === 0 && result.error === undefined, 'CERT_GENERATION_REQUIRED');
}
async function certificates(directory: string): Promise<void> {
  openssl(directory, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-sha256', '-nodes', '-days', '1', '-subj', '/CN=RUN01 owned CA', '-config', '/dev/null',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', 'ca.key', '-out', 'ca.crt']);
  for (const [name, san, serial] of [
    ['matching', 'DNS:localhost,IP:127.0.0.1', '1'],
    ['wrong-san', 'DNS:wrong.test.invalid,IP:127.0.0.2', '2'],
  ] as const) {
    const extension = join(directory, name + '.ext');
    await writeFile(extension, '[leaf]\nbasicConstraints=critical,CA:FALSE\n' +
      'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=' + san + '\n',
    { mode: 0o600, flag: 'wx' });
    openssl(directory, ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-subj', '/CN=localhost', '-config', '/dev/null',
      '-keyout', name + '.key', '-out', name + '.csr']);
    openssl(directory, ['x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-set_serial', serial, '-sha256', '-days', '1', '-extfile', extension,
      '-extensions', 'leaf', '-out', name + '.crt']);
    await chmod(join(directory, name + '.key'), 0o600);
  }
  await chmod(join(directory, 'ca.key'), 0o600);
}
async function peer(directory: string, mode: Mode, password: string) {
  const name = mode === 'wrong-san' ? 'wrong-san' : 'matching';
  const sockets = new Set<Socket>();
  const receipts: string[] = [];
  let connections = 0; let applicationBytes = 0; let invalid = false;
  const server = createServer({
    key: await readFile(join(directory, name + '.key')),
    cert: await readFile(join(directory, name + '.crt')), minVersion: 'TLSv1.2',
  }, (socket: TLSSocket) => {
    track(socket);
    let input: Buffer = Buffer.alloc(0);
    socket.once('close', () => { input.fill(0); });
    socket.on('data', (chunk: Buffer) => {
      applicationBytes += chunk.length;
      if (input.length + chunk.length > REDIS_RESP_BOUNDS.bufferBytes) {
        invalid = true; chunk.fill(0); socket.destroy(); return;
      }
      const next = Buffer.concat([input, chunk]); input.fill(0); chunk.fill(0); input = next;
      try {
        while (input.length > 0) {
          const parsed = decodeRedisResp2(input);
          if (parsed === undefined) return;
          check(Array.isArray(parsed.value), 'SYNTHETIC_COMMAND_SHAPE');
          const parts = parsed.value;
          const words = parts.map((part) => {
            check(Buffer.isBuffer(part), 'SYNTHETIC_BULK_REQUIRED'); return part.toString('utf8');
          });
          try {
            const command = words[0];
            check(['AUTH', 'SELECT', 'PING', 'EVAL'].includes(command ?? ''), 'SYNTHETIC_COMMAND_NAME');
            const expected = ['AUTH', 'SELECT', 'PING', 'EVAL'][receipts.length];
            check(command === expected, 'SYNTHETIC_COMMAND_ORDER');
            receipts.push(command!);
            if (command === 'AUTH') {
              check(words.length === 3 && words[1] === 'owned-user' && words[2] === password, 'AUTH_ARGUMENTS');
              socket.write('+OK\r\n');
            } else if (command === 'SELECT') {
              check(words.length === 2 && words[1] === '2', 'SELECT_ARGUMENTS'); socket.write('+OK\r\n');
            } else if (command === 'PING') {
              check(words.length === 1, 'PING_ARGUMENTS'); socket.write('+PONG\r\n');
            } else {
              check(words.length === 6 && words[1] === 'return {1, 10}' && words[2] === '1' &&
                words[3] === 'owned-tls-key' && words[4] === '1' && words[5] === '10', 'EVAL_ARGUMENTS');
              // This is a fixed RESP reply, not executing Lua.
              if (mode !== 'uncertain-eval') socket.write('*2\r\n:1\r\n:10\r\n');
            }
          } finally { for (const part of parts) if (Buffer.isBuffer(part)) part.fill(0); }
          const remaining = Buffer.from(input.subarray(parsed.bytes)); input.fill(0); input = remaining;
        }
      } catch { invalid = true; input.fill(0); socket.destroy(); }
    });
  });
  function track(socket: Socket): void {
    sockets.add(socket); socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  }
  server.on('connection', (socket: Socket) => { connections += 1; track(socket); });
  server.on('tlsClientError', () => undefined);
  server.on('error', () => { invalid = true; });
  const close = async () => {
    const closed = Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => {
      socket.once('close', () => resolve()); socket.destroy();
    })));
    let failed = false;
    try { await bounded(closed, 2_000, 'SOCKET_CLEANUP_DEADLINE'); } catch { failed = true; }
    try {
      if (server.listening) await bounded(new Promise<void>((resolve) => server.close(() => resolve())),
        2_000, 'LISTENER_CLEANUP_DEADLINE');
    } catch { failed = true; }
    check(!failed && !server.listening && sockets.size === 0, 'OWNED_PEER_CLOSED');
  };
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new ProofFailure('OWNED_BIND_FAILED')));
      server.listen(0, '127.0.0.1', resolve);
    }), 2_000, 'OWNED_BIND_DEADLINE');
    const address = server.address();
    check(address && typeof address !== 'string' && address.address === '127.0.0.1' &&
      address.port > 1024 && ![6379, 6380].includes(address.port), 'OWNED_LOOPBACK_PORT_ZERO');
    return { port: address.port, receipts, close,
      state: () => ({ connections, applicationBytes, invalid }) };
  } catch { await close(); throw new ProofFailure('OWNED_PEER_SETUP_FAILED'); }
}
async function child(directory: string, mode: Mode, port: number, password: string) {
  const env = { ...cleanEnv, TMPDIR: directory,
    ...(mode === 'unknown-ca' ? {} : { NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt') }) };
  // No inherited NODE_OPTIONS/TLS switches/trust path, no credentials in argv/env,
  // no parent/global env mutation. Only this owned child loads the owned CA.
  const args = [...(sourceMode ? ['--import', 'tsx'] : []), childPath];
  const processHandle = spawn(process.execPath, args, {
    cwd: sourceRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false; let spawnFailed = false; let outputBytes = 0; let report: unknown;
  const finished = new Promise<void>((resolve) => processHandle.once('close', () => { closed = true; resolve(); }));
  processHandle.on('error', () => { spawnFailed = true; });
  const discard = (chunk: Buffer) => { outputBytes += chunk.length; chunk.fill(0); };
  processHandle.stdout?.on('data', discard); processHandle.stderr?.on('data', discard);
  processHandle.on('message', (message: unknown) => {
    if (report !== undefined) spawnFailed = true;
    else report = message;
  });
  try {
    processHandle.send({ mode, port, username: 'owned-user', password }, (error) => {
      if (error) spawnFailed = true;
    });
    await bounded(finished, 10_000, 'OWNED_CHILD_DEADLINE');
    check(!spawnFailed && processHandle.exitCode === 0 && processHandle.signalCode === null &&
      outputBytes === 0 && report !== null && typeof report === 'object', 'SAFE_CHILD_RESULT');
    const result = report as Record<string, unknown>;
    check(Object.keys(result).sort().join(',') ===
      'applicationWrites,beforeSecureWrites,dials,failureCode,mode,secureConnects,status', 'SAFE_REPORT_FIELDS');
    const negative = mode === 'wrong-san' || mode === 'unknown-ca';
    check(result.status === 'passed' && result.mode === mode && result.dials === 1 &&
      result.beforeSecureWrites === 0 && result.secureConnects === (negative ? 0 : 1) &&
      result.applicationWrites === (negative ? 0 : 4) &&
      result.failureCode === (negative ? 'REDIS_TLS_FAILED' : mode === 'uncertain-eval' ? 'REDIS_TIMEOUT' : null),
    'VERIFIED_CHILD_FACTS');
  } finally {
    if (!closed) {
      if (processHandle.pid !== undefined) processHandle.kill('SIGTERM');
      try { await bounded(finished, 1_000, 'CHILD_TERM_DEADLINE'); }
      catch {
        if (!closed && processHandle.pid !== undefined) processHandle.kill('SIGKILL');
        await bounded(finished, 2_000, 'CHILD_KILL_DEADLINE');
      }
    }
    check(closed, 'OWNED_CHILD_CLOSED');
  }
}
test('RUN-01 owned verified TLS and hostname checks with synthetic RESP only', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'redis-resp-owned-ca-')).catch(() => {
    throw new ProofFailure('OWNED_DIRECTORY_REQUIRED');
  });
  try {
    await chmod(directory, 0o700);
    await certificates(directory);
    for (const mode of ['verified', 'wrong-san', 'unknown-ca', 'uncertain-eval'] as const) {
      await t.test(mode, { timeout: 16_000 }, async () => {
        let password = randomBytes(32).toString('hex');
        const owned = await peer(directory, mode, password).catch(() => {
          throw new ProofFailure('OWNED_PEER_SETUP_FAILED');
        });
        try { await child(directory, mode, owned.port, password); }
        catch (error) { throw error instanceof ProofFailure ? error : new ProofFailure('CHILD_PROOF_FAILED'); }
        finally { try { await owned.close(); } finally { password = ''; } }
        const state = owned.state();
        check(!state.invalid && state.connections === 1, 'SINGLE_CONNECTION_NO_RECONNECT');
        if (mode === 'wrong-san' || mode === 'unknown-ca') {
          check(owned.receipts.length === 0 && state.applicationBytes === 0, 'TLS_REJECTION_AUTH_ZERO');
        } else {
          check(owned.receipts.join(',') === 'AUTH,SELECT,PING,EVAL', 'SINGLE_EVAL_NO_REPLAY');
        }
      });
    }
  } catch (error) {
    throw error instanceof ProofFailure ? error : new ProofFailure('OWNED_TLS_PROOF_FAILED');
  } finally {
    // Exact path returned by this test's mkdtemp, not a user directory or trust store.
    try { await bounded(rm(directory, { recursive: true, force: true }), 2_000, 'CERT_CLEANUP_DEADLINE'); }
    catch { throw new ProofFailure('OWNED_CERT_CLEANUP_FAILED'); }
  }
});
