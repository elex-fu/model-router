import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { LookupFunction, TcpSocketConnectOpts } from 'node:net';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import type { RedisRespClient as Client } from '../../../src/saas/runtime/redis-resp-client.js';

// Test-only isolated process. This observes real tls.connect/socket.write;
// certificate verification and the production client remain unchanged.
type Mode = 'verified' | 'wrong-san' | 'unknown-ca' | 'uncertain-eval';
interface Input { mode: Mode; port: number; username: string; password: string }
function check(value: unknown): asserts value {
  if (!value) throw new Error('RUN01_TLS_CHILD_ASSERTION');
}
const sockets = new Set<TLSSocket>();
const watchdog = setTimeout(() => {
  for (const socket of sockets) socket.destroy();
  process.exit(1);
}, 8_000);
process.once('message', (message: unknown) => {
  void run(message).then(
    (report) => finish(report, 0),
    () => finish({ status: 'failed' }, 1),
  );
});
function finish(report: object, code: number): void {
  process.exitCode = code;
  if (!process.send || !process.connected) { clearTimeout(watchdog); return; }
  process.send(report, () => {
    clearTimeout(watchdog);
    if (process.connected) process.disconnect();
  });
}
async function run(message: unknown) {
  check(message !== null && typeof message === 'object' && !Array.isArray(message));
  const input = message as Input;
  check(['verified', 'wrong-san', 'unknown-ca', 'uncertain-eval'].includes(input.mode));
  check(Number.isInteger(input.port) && input.port > 1024 && input.port <= 65535 &&
    input.port !== 6379 && input.port !== 6380);
  check(input.username === 'owned-user' && typeof input.password === 'string' &&
    /^[0-9a-f]{64}$/.test(input.password));
  const tls = createRequire(__filename)('node:tls') as typeof import('node:tls');
  const originalConnect = tls.connect;
  let dials = 0; let secureConnects = 0; let applicationWrites = 0; let beforeSecureWrites = 0;
  let client: Client | undefined;
  tls.connect = ((options: ConnectionOptions) => {
    check(options.host === 'localhost' && options.port === input.port &&
      options.servername === 'localhost' && options.rejectUnauthorized === true &&
      options.minVersion === 'TLSv1.2');
    dials += 1;
    const ownedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
      if (hostname !== 'localhost' || lookupOptions.family === 6 || lookupOptions.family === 'IPv6') {
        callback(new Error('RUN01_TLS_LOOKUP_REFUSED'), '', 4); return;
      }
      if (lookupOptions.all) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      } else {
        callback(null, '127.0.0.1', 4);
      }
    };
    const pinnedOptions: ConnectionOptions & Pick<TcpSocketConnectOpts, 'autoSelectFamily'> = {
      ...options,
      // Preserve host/SNI/hostname validation, but pin only this child's DNS
      // lookup to its parent's owned IPv4 loopback listener.
      autoSelectFamily: false,
      lookup: ownedLookup,
    };
    const socket = originalConnect(pinnedOptions);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let verified = false;
    socket.once('secureConnect', () => {
      verified = socket.authorized === true;
      if (verified) secureConnects += 1;
    });
    const originalWrite = socket.write;
    socket.write = function (...args: unknown[]): boolean {
      if (!verified) beforeSecureWrites += 1;
      applicationWrites += 1;
      return Reflect.apply(originalWrite, socket, args) as boolean;
    } as typeof socket.write;
    return socket;
  }) as typeof tls.connect;
  syncBuiltinESMExports();
  try {
    const { RedisRespClient, RedisRespError } = await import('../../../src/saas/runtime/redis-resp-client.js');
    const safe = (code: string) => (error: unknown): boolean => {
      check(error instanceof RedisRespError && error.code === code && error.message === code &&
        error.stack === 'RedisRespError: ' + code && error.cause === undefined &&
        !error.message.includes(input.password) && !error.stack.includes('rediss:'));
      return true;
    };
    const rejected = async (work: Promise<unknown>, code: string) => {
      let denied = false;
      try { await work; } catch (error) { denied = safe(code)(error); }
      check(denied);
    };
    const url = 'rediss://' + input.username + ':' + input.password + '@localhost:' + input.port + '/2';
    let failureCode: string | null = null;
    if (input.mode === 'wrong-san' || input.mode === 'unknown-ca') {
      failureCode = 'REDIS_TLS_FAILED';
      await rejected(RedisRespClient.connect(url), failureCode);
      check(dials === 1 && secureConnects === 0 && applicationWrites === 0);
    } else {
      client = await RedisRespClient.connect(url);
      check(await client.command(['PING']) === 'PONG');
      const evalCommand = ['EVAL', 'return {1, 10}', '1', 'owned-tls-key', '1', '10'];
      if (input.mode === 'uncertain-eval') {
        failureCode = 'REDIS_TIMEOUT';
        await rejected(client.command(evalCommand), failureCode);
        await rejected(client.command(evalCommand), failureCode);
        await rejected(client.command(['PING']), failureCode);
      } else {
        const reply = await client.command(evalCommand);
        check(Array.isArray(reply) && reply.length === 2 && reply[0] === 1 && reply[1] === 10);
      }
      await client.close();
      if (input.mode === 'verified') await rejected(client.command(['PING']), 'REDIS_CLOSED');
      check(dials === 1 && secureConnects === 1 && applicationWrites === 4);
    }
    check(beforeSecureWrites === 0);
    return { status: 'passed', mode: input.mode, dials, secureConnects,
      applicationWrites, beforeSecureWrites, failureCode };
  } finally {
    tls.connect = originalConnect; syncBuiltinESMExports();
    try { await client?.close(); } finally {
      for (const socket of sockets) socket.destroy();
      input.password = '';
    }
  }
}
