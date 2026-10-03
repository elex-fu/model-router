import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RedisProvider, RedisRateLimiterOptions } from '../../../src/saas/runtime/providers.js';
import { createRedisProvider } from '../../../src/saas/runtime/redis-rate-limit-provider.js';
import { decodeRedisResp2, RedisRespError, type RedisRespValue } from '../../../src/saas/runtime/redis-resp-client.js';

// Opt-in only. No configured URL, user Redis, .env, redis.conf, production ACL,
// test retry, server retry, persistence, daemon, gateway, IP or budget limiter.
const required = process.env.MODEL_ROUTER_SAAS_REDIS_LOCAL_REQUIRED;
const binary = '/opt/homebrew/bin/redis-server';
const primaryPrefix = 'model-router:saas';
const otherPrefix = 'run01-other';
type User = 'limiter' | 'denied' | 'observer';
class LocalFailure extends Error {
  constructor(code: string) { super('RUN01_LOCAL/' + code); this.stack = this.message; }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new LocalFailure(code);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Owned {
  readonly child: ChildProcess; readonly pid: number; readonly port: number; readonly directory: string;
  readonly secrets: Record<User, string>; readonly sockets: Set<Socket>;
  readonly providers: RedisProvider[];
  failed: boolean; exited: boolean; closed: boolean; listenerVerified: boolean;
  identityVerified: boolean; probeOpened: number; probeClosed: number; childrenPassed: number;
}
function live(owner: Owned): void {
  check(owner.listenerVerified && !owner.failed && !owner.exited && !owner.closed &&
    owner.child.pid === owner.pid && owner.child.exitCode === null && owner.child.signalCode === null &&
    owner.child.kill(0), 'OWNED_CHILD_NOT_LIVE');
}

async function unusedPort(): Promise<number> {
  const reservation = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', () => reject(new LocalFailure('PORT_RESERVATION_FAILED')));
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    check(address && typeof address !== 'string', 'PORT_RESERVATION_IDENTITY');
    check(address.address === '127.0.0.1' && address.port > 1024 && address.port <= 65535 &&
      ![6379, 6380, 5432, 6432, 53782, 15005, 15006, 56783, 62719, 64756].includes(address.port), 'FORBIDDEN_PORT');
    return address.port;
  } finally {
    if (reservation.listening) await bounded(new Promise<void>((resolve) => reservation.close(() => resolve())),
      2_000, 'PORT_RESERVATION_CLOSE_DEADLINE');
  }
}

async function startOwned(): Promise<Owned> {
  await access(binary, constants.X_OK).catch(() => { throw new LocalFailure('REQUIRED_BINARY_MISSING'); });
  await access('/usr/sbin/lsof', constants.X_OK).catch(() => { throw new LocalFailure('OWNERSHIP_TOOL_MISSING'); });
  const directory = await mkdtemp('/private/tmp/model-router-redis-run01.');
  await chmod(directory, 0o700);
  const port = await unusedPort(); // Exactly once. A bind race is a failure, not another-port retry.
  const secrets: Record<User, string> = {
    limiter: randomBytes(32).toString('hex'), denied: randomBytes(32).toString('hex'), observer: randomBytes(32).toString('hex'),
  };
  const patterns = '~' + primaryPrefix + ':auth-rate-limit:v1:* ~' + otherPrefix + ':auth-rate-limit:v1:*';
  const acl = [
    'user default reset off',
    'user limiter reset on #' + createHash('sha256').update(secrets.limiter).digest('hex') + ' ' + patterns +
      ' +ping +select +eval +pttl +get +set +incr',
    'user denied reset on #' + createHash('sha256').update(secrets.denied).digest('hex') + ' ' + patterns +
      ' +ping +select +eval +pttl +get',
    'user observer reset on #' + createHash('sha256').update(secrets.observer).digest('hex') + ' ' + patterns +
      ' +ping +select +info +get +pttl +pexpiretime +exists +config|get',
  ].join('\n') + '\n';
  const aclPath = join(directory, 'synthetic.acl');
  await writeFile(aclPath, acl, { mode: 0o600, flag: 'wx' });
  await writeFile(join(directory, 'attempt.json'), JSON.stringify({ mode: 'once_RAM_only', port }) + '\n',
    { mode: 0o600, flag: 'wx' });
  await writeFile(join(directory, 'server.log'), '', { mode: 0o600, flag: 'wx' });
  const stdout = openSync(join(directory, 'child.stdout'), 'ax', 0o600);
  let stderr: number | undefined;
  let child: ChildProcess;
  try {
    stderr = openSync(join(directory, 'child.stderr'), 'ax', 0o600);
    child = spawn(binary, [
      '--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
      '--daemonize', 'no', '--dir', directory, '--databases', '2', '--protected-mode', 'yes',
      '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction',
      '--aclfile', aclPath, '--logfile', join(directory, 'server.log'), '--loglevel', 'notice',
      '--pidfile', join(directory, 'owned.pid'), '--dbfilename', 'never-save.rdb',
    ], { cwd: directory, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', TMPDIR: directory },
      stdio: ['ignore', stdout, stderr] });
  } finally { closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
  // spawn errors are captured before any await/connection; no native error is printed.
  const owner: Owned = { child, pid: child.pid ?? -1, port, directory, secrets, sockets: new Set(), providers: [],
    failed: false, exited: false, closed: false, listenerVerified: false, identityVerified: false,
    probeOpened: 0, probeClosed: 0, childrenPassed: 0 };
  child.on('error', () => { owner.failed = true; });
  child.on('exit', () => { owner.exited = true; });
  child.on('close', () => { owner.closed = true; });
  return owner;
}

async function verifyListening(owner: Owned): Promise<void> {
  check(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'SPAWN_PID_REQUIRED');
  const deadline = Date.now() + 8_000;
  let ready = false;
  // Only inspect this fresh child's private log, never TCP-poll another process.
  do {
    check(!owner.failed && !owner.exited && !owner.closed, 'CHILD_EXITED_BEFORE_READY');
    const text = await readFile(join(owner.directory, 'server.log'), 'utf8').catch(() => '');
    check(text.length < 65_536, 'CHILD_LOG_BOUND');
    ready = new RegExp('^' + owner.pid + ':[^\\n]*Ready to accept connections tcp', 'm').test(text);
    if (!ready) await delay(20);
  } while (!ready && Date.now() < deadline);
  check(ready, 'CHILD_READY_DEADLINE');
  const native = spawnSync('/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(owner.pid), '-iTCP:' + owner.port, '-sTCP:LISTEN', '-Fpn'],
    { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, encoding: 'utf8', timeout: 2_000, maxBuffer: 65_536 });
  await writeFile(join(owner.directory, 'listen.stdout'), native.stdout ?? '', { mode: 0o600, flag: 'wx' });
  await writeFile(join(owner.directory, 'listen.stderr'), native.stderr ?? '', { mode: 0o600, flag: 'wx' });
  const fields = (native.stdout ?? '').split('\n');
  check(native.status === 0 && fields.filter((line) => line.startsWith('p')).join() === 'p' + owner.pid &&
    fields.filter((line) => line.startsWith('n')).join() === 'n127.0.0.1:' + owner.port,
  'EXACT_CHILD_LISTEN_OWNERSHIP');
  owner.listenerVerified = true; live(owner);
}

function redisKey(prefix: string, policy: RedisRateLimiterOptions, subject: string): string {
  const digest = createHash('sha256').update('model-router:auth-rate-limit:v1\0')
    .update(prefix).update('\0').update(policy.namespace).update('\0').update(String(policy.limit)).update('\0')
    .update(String(policy.windowMs)).update('\0').update(subject).digest('hex');
  return prefix + ':auth-rate-limit:v1:' + policy.namespace + ':' + policy.limit + ':' + policy.windowMs + ':' + digest;
}

/** Test-private READ-ONLY wire probe; never change the production client's whitelist. */
async function observe(owner: Owned, database: 0 | 1, words: readonly string[]): Promise<RedisRespValue> {
  live(owner);
  const oneKey = /^(?:model-router:saas|run01-other):auth-rate-limit:v1:(?:customer-auth|platform-auth):[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$/;
  check((words.length === 2 && words[0] === 'INFO' && ['server', 'commandstats', 'keyspace'].includes(words[1] ?? '')) ||
    (words.length === 3 && words[0] === 'CONFIG' && words[1] === 'GET' && ['save', 'appendonly'].includes(words[2] ?? '')) ||
    (words.length === 2 && ['GET', 'PTTL', 'PEXPIRETIME', 'EXISTS'].includes(words[0] ?? '') && oneKey.test(words[1] ?? '')),
  'READ_ONLY_PROBE_SHAPE');
  const secret = Buffer.from(owner.secrets.observer);
  const commands: readonly (readonly (string | Buffer)[])[] = [
    ['AUTH', 'observer', secret], ...(database === 0 ? [] : [['SELECT', '1']]), words,
  ];
  return new Promise<RedisRespValue>((resolve, reject) => {
    let input: Buffer = Buffer.alloc(0); let frame: Buffer = Buffer.alloc(0);
    let index = 0; let completed = false; let outcome: { value: RedisRespValue } | undefined;
    let failure: LocalFailure | undefined;
    let socket: Socket;
    try { socket = connect({ host: '127.0.0.1', port: owner.port }); }
    catch { secret.fill(0); reject(new LocalFailure('PROBE_SOCKET_FAILED')); return; }
    owner.sockets.add(socket); owner.probeOpened += 1;
    const timer = setTimeout(() => finish(new LocalFailure('PROBE_DEADLINE')), 1_500);
    const closeTimer = setTimeout(() => {
      finish(new LocalFailure('PROBE_CLOSE_DEADLINE')); reject(new LocalFailure('PROBE_CLOSE_DEADLINE'));
    }, 3_000);
    function finish(error?: LocalFailure, value?: RedisRespValue): void {
      if (completed) return;
      completed = true; failure = error;
      if (value !== undefined) outcome = { value };
      clearTimeout(timer); input.fill(0); frame.fill(0); secret.fill(0); socket.destroy();
    }
    function send(): void {
      const command = commands[index]; check(command, 'PROBE_COMMAND_INDEX');
      const parts: Buffer[] = [Buffer.from('*' + command.length + '\r\n')];
      for (const word of command) {
        const bytes = typeof word === 'string' ? Buffer.from(word) : Buffer.from(word);
        parts.push(Buffer.from('$' + bytes.length + '\r\n'), bytes, Buffer.from('\r\n'));
      }
      frame = Buffer.concat(parts); for (const part of parts) part.fill(0);
      const sent = frame; socket.write(sent, () => sent.fill(0));
    }
    socket.on('error', () => finish(new LocalFailure('PROBE_SOCKET_FAILED')));
    socket.once('connect', () => { try { live(owner); send(); } catch { finish(new LocalFailure('PROBE_OWNER_CHANGED')); } });
    socket.on('data', (chunk: Buffer) => {
      if (completed) { chunk.fill(0); return; }
      if (input.length + chunk.length > 16_384) { chunk.fill(0); finish(new LocalFailure('PROBE_BUFFER_BOUND')); return; }
      const next = Buffer.concat([input, chunk]); input.fill(0); chunk.fill(0); input = next;
      try {
        const reply = decodeRedisResp2(input); if (reply === undefined) return;
        check(reply.bytes === input.length, 'PROBE_FRAME_ALIGNMENT');
        input.fill(0); input = Buffer.alloc(0);
        if (index === commands.length - 1) finish(undefined, reply.value);
        else { check(reply.value === 'OK', 'PROBE_AUTH_SELECT'); index += 1; send(); }
      } catch { finish(new LocalFailure('PROBE_REPLY_FAILED')); }
    });
    socket.once('close', () => {
      owner.sockets.delete(socket); owner.probeClosed += 1;
      clearTimeout(timer); clearTimeout(closeTimer); secret.fill(0); input.fill(0); frame.fill(0);
      if (!completed) failure = new LocalFailure('PROBE_CLOSED_EARLY');
      if (failure !== undefined) reject(failure);
      else if (outcome === undefined) reject(new LocalFailure('PROBE_RESULT_REQUIRED'));
      else resolve(outcome.value);
    });
  });
}
function bulk(value: RedisRespValue): string { check(Buffer.isBuffer(value), 'EXPECTED_BULK_REPLY'); return value.toString('utf8'); }
function number(value: RedisRespValue): number { check(typeof value === 'number' && Number.isSafeInteger(value), 'EXPECTED_INTEGER_REPLY'); return value; }
function fields(value: RedisRespValue): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of bulk(value).split('\r\n')) {
    const colon = line.indexOf(':'); if (colon > 0) result[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return result;
}
async function verifyServer(owner: Owned): Promise<void> {
  const info = fields(await observe(owner, 0, ['INFO', 'server']));
  check(info.process_id === String(owner.pid) && info.tcp_port === String(owner.port) &&
    /^[0-9a-f]{40}$/.test(info.run_id ?? '') && info.config_file === '' &&
    Number((info.redis_version ?? '').split('.')[0]) >= 7, 'NATIVE_SERVER_IDENTITY');
  // PEXPIRETIME is a Redis 7+ read-only fixed-expiry oracle, not a module requirement.
  const settings: ReadonlyArray<readonly [string, string]> = [['save', ''], ['appendonly', 'no']];
  for (const [name, expected] of settings) {
    const reply = await observe(owner, 0, ['CONFIG', 'GET', name]);
    check(Array.isArray(reply) && reply.length === 2 &&
      bulk(reply[0]) === name && bulk(reply[1]) === expected, 'ACTUAL_RAM_ONLY_CONFIGURATION');
  }
  owner.identityVerified = true;
}
function url(owner: Owned, user: User, database: 0 | 1): string {
  live(owner); check(owner.identityVerified, 'SERVER_IDENTITY_NOT_VERIFIED');
  const value = 'redis://' + user + ':' + owner.secrets[user] + '@127.0.0.1:' + owner.port + '/' + database;
  const parsed = new URL(value);
  check(parsed.hostname === '127.0.0.1' && parsed.port === String(owner.port) &&
    parsed.pathname === '/' + database && parsed.search === '' && parsed.hash === '', 'FIXED_QUERYLESS_TARGET');
  return value;
}
async function provider(owner: Owned, user: User = 'limiter', database: 0 | 1 = 0, prefix = primaryPrefix): Promise<RedisProvider> {
  const result = await createRedisProvider({ url: url(owner, user, database), keyPrefix: prefix });
  owner.providers.push(result); await result.checkReady(); return result;
}
async function serverEvalStats(owner: Owned): Promise<{ calls: number; failed: number }> {
  const line = fields(await observe(owner, 0, ['INFO', 'commandstats'])).cmdstat_eval;
  check(typeof line === 'string', 'ACTUAL_EVAL_STATS_REQUIRED');
  const stats = Object.fromEntries(line.split(',').map((field) => field.split('=')));
  const calls = Number(stats.calls); const failed = Number(stats.failed_calls);
  check(Number.isSafeInteger(calls) && calls >= 0 && Number.isSafeInteger(failed) && failed >= 0, 'ACTUAL_EVAL_STATS_SHAPE');
  return { calls, failed };
}
async function denied(work: () => Promise<unknown>, code: string): Promise<void> {
  let rejected = false;
  try { await work(); } catch (error) {
    rejected = true;
    check(error instanceof RedisRespError && error.code === code && error.message === code &&
      error.stack === 'RedisRespError: ' + code && error.cause === undefined, 'REDACTED_NATIVE_DENIAL_REQUIRED');
  }
  check(rejected, 'NATIVE_DENIAL_MISSING');
}
async function bounded(work: Promise<unknown>, ms: number, code: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LocalFailure(code)), ms); })]);
  } finally { clearTimeout(timer); }
}
async function stop(owner: Owned): Promise<void> {
  if (owner.closed) return;
  const closed = new Promise<void>((resolve) => owner.child.once('close', () => resolve()));
  if (owner.child.pid === undefined) {
    // Failed spawn has no process to signal; await its own close event only.
    check(owner.pid === -1, 'FAILED_SPAWN_IDENTITY');
    await bounded(closed, 2_000, 'FAILED_SPAWN_CLOSE_DEADLINE'); return;
  }
  check(owner.child.pid === owner.pid && owner.pid > 0, 'EXACT_STOP_HANDLE_REQUIRED');
  if (!owner.exited) owner.child.kill('SIGTERM');
  try { await bounded(closed, 2_500, 'CHILD_TERM_DEADLINE'); }
  catch {
    if (!owner.exited && owner.child.pid === owner.pid) owner.child.kill('SIGKILL');
    await bounded(closed, 2_000, 'CHILD_KILL_DEADLINE');
  }
  check(owner.closed, 'OWNED_CHILD_CLOSE_REQUIRED');
}
async function cleanup(owner: Owned): Promise<void> {
  let failed = false;
  try {
    let providersClosed = false;
    await bounded(Promise.allSettled(owner.providers.map((value) => value.close())).then((results) => {
      providersClosed = results.every((result) => result.status === 'fulfilled');
    }), 4_000, 'PROVIDERS_CLOSE_DEADLINE');
    check(providersClosed, 'PROVIDERS_CLOSE_REQUIRED');
  } catch { failed = true; }
  // Provider-close failure must never bypass stopping the owned Redis child.
  const closedProbes = Promise.all([...owner.sockets].map((socket) => new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  })));
  for (const socket of owner.sockets) socket.destroy();
  try { await stop(owner); } catch { failed = true; }
  try { await bounded(closedProbes, 2_000, 'PROBE_CLEANUP_DEADLINE'); } catch { failed = true; }
  check(!failed && owner.closed && owner.sockets.size === 0 && owner.probeOpened === owner.probeClosed,
    'ALL_OWNED_RESOURCES_CLOSED');
}
async function proof(t: TestContext, owner: Owned, name: string, work: () => Promise<void>): Promise<void> {
  await t.test(name, async () => {
    try { await work(); owner.childrenPassed += 1; }
    catch (error) {
      throw error instanceof LocalFailure || error instanceof RedisRespError ? error : new LocalFailure('BUSINESS_PROOF_FAILED');
    }
  });
}

test('RUN-01 required owned local Redis executes the original Lua and restricted module', {
  skip: required === undefined ? 'set MODEL_ROUTER_SAAS_REDIS_LOCAL_REQUIRED=1 for owned native Redis; no discovery dial' : false,
  timeout: 60_000,
}, async (t) => {
  check(required === '1', 'EXACT_REQUIRED_FLAG');
  let owner: Owned | undefined; let cleanupSucceeded = false;
  const startedUtc = new Date().toISOString();
  try {
    owner = await startOwned(); await verifyListening(owner); await verifyServer(owner);
    const owned = owner;
    const a = await provider(owned); const b = await provider(owned);
    const base: RedisRateLimiterOptions = { namespace: 'customer-auth', limit: 10, windowMs: 3000 };

    await proof(t, owned, 'real AUTH/SELECT/PING, wrong AUTH denied, and logical DB isolation', async () => {
      const db1 = await provider(owned, 'limiter', 1);
      const policy = { ...base, limit: 1, windowMs: 10_000 }; const subject = 'auth-select-only';
      const key = redisKey(primaryPrefix, policy, subject);
      const limiter = await db1.createRateLimiter(policy);
      check(await limiter.take(subject) === undefined, 'DB1_REAL_TAKE');
      check(number(await observe(owned, 1, ['EXISTS', key])) === 1 &&
        number(await observe(owned, 0, ['EXISTS', key])) === 0, 'REAL_SELECT_ISOLATION');
      await denied(() => createRedisProvider({ url: url(owned, 'limiter', 0).replace(owned.secrets.limiter, 'synthetic-wrong-password'),
        keyPrefix: primaryPrefix }), 'REDIS_REPLY_ERROR');
    });
    await proof(t, owned, 'two real providers concurrently enforce exactly ten accepted requests on one shared key', async () => {
      const first = await a.createRateLimiter(base); const second = await b.createRateLimiter(base);
      const subject = 'concurrent-shared-original-script';
      const result = await Promise.all(Array.from({ length: 32 }, (_value, index) => (index % 2 ? first : second).take(subject)));
      check(result.filter((value) => value === undefined).length === 10 &&
        result.filter((value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 3).length === 22,
      'ATOMIC_SHARED_LIMIT_EXACT');
      const key = redisKey(primaryPrefix, base, subject);
      check(bulk(await observe(owned, 0, ['GET', key])) === '10', 'REAL_COUNTER_BOUNDED_AT_LIMIT');
      check(number(await observe(owned, 0, ['PTTL', key])) > 0, 'REAL_COUNTER_HAS_TTL');
    });
    await proof(t, owned, 'actual PTTL bounds prove Retry-After is rounded-up seconds', async () => {
      const policy = { ...base, limit: 1, windowMs: 5501 }; const subject = 'ceil-seconds';
      const limiter = await a.createRateLimiter(policy); check(await limiter.take(subject) === undefined, 'CEIL_FIRST_ACCEPTED');
      const key = redisKey(primaryPrefix, policy, subject);
      const before = number(await observe(owned, 0, ['PTTL', key]));
      const retry = await limiter.take(subject);
      const after = number(await observe(owned, 0, ['PTTL', key]));
      check(before > 0 && after > 0 && after <= before &&
        Math.ceil(before / 1000) === Math.ceil(after / 1000), 'STABLE_NATIVE_CEIL_BUCKET_REQUIRED');
      check(retry === Math.ceil(after / 1000) && Number.isSafeInteger(retry) &&
        Number(retry) > 0 && Number(retry) < after, 'REAL_RETRY_AFTER_SECONDS_CEIL');
    });
    await proof(t, owned, 'rejection preserves exact expiration and a genuinely expired window resets', async () => {
      const policy = { ...base, limit: 1, windowMs: 1200 }; const subject = 'fixed-expiry-reset';
      const limiter = await a.createRateLimiter(policy); check(await limiter.take(subject) === undefined, 'EXPIRY_FIRST_ACCEPTED');
      const key = redisKey(primaryPrefix, policy, subject);
      const expiry = number(await observe(owned, 0, ['PEXPIRETIME', key]));
      check(expiry > 0, 'FIXED_EXPIRY_REQUIRED');
      for (let index = 0; index < 3; index += 1) {
        const retry = await limiter.take(subject); check(Number.isSafeInteger(retry) && Number(retry) > 0, 'FIXED_WINDOW_DENIED');
        check(number(await observe(owned, 0, ['PEXPIRETIME', key])) === expiry, 'REJECTION_MUST_NOT_EXTEND_EXPIRY');
      }
      const deadline = Date.now() + 4000; let ttl = 0;
      do { ttl = number(await observe(owned, 0, ['PTTL', key])); if (ttl !== -2) await delay(20); }
      while (ttl !== -2 && Date.now() < deadline);
      check(ttl === -2, 'ACTUAL_EXPIRED_KEY_REQUIRED');
      check(await limiter.take(subject) === undefined, 'REAL_EXPIRED_WINDOW_RESET');
      check(bulk(await observe(owned, 0, ['GET', key])) === '1' &&
        number(await observe(owned, 0, ['PEXPIRETIME', key])) > expiry, 'RESET_NEW_TTL_AND_COUNTER');
    });
    await proof(t, owned, 'actual namespace, policy and prefix isolation preserves separate counters and TTLs', async () => {
      const alternative = await provider(owned, 'limiter', 0, otherPrefix); const subject = 'same-isolated-subject';
      const policies: RedisRateLimiterOptions[] = [
        { ...base, limit: 1, windowMs: 10_000 }, { ...base, namespace: 'platform-auth', limit: 1, windowMs: 10_000 },
        { ...base, limit: 2, windowMs: 10_000 }, { ...base, limit: 1, windowMs: 12_000 },
      ];
      const keys: string[] = [];
      for (const policy of policies) {
        const limiter = await a.createRateLimiter(policy);
        for (let index = 0; index < policy.limit; index += 1) check(await limiter.take(subject) === undefined, 'ISOLATED_ALLOWED');
        const retry = await limiter.take(subject);
        check(Number.isSafeInteger(retry) && Number(retry) > 0, 'ISOLATED_DENIED');
        const key = redisKey(primaryPrefix, policy, subject); keys.push(key);
        check(bulk(await observe(owned, 0, ['GET', key])) === String(policy.limit) &&
          number(await observe(owned, 0, ['PTTL', key])) > 0, 'ISOLATED_REAL_FACTS');
      }
      const first = policies[0]; check(first, 'ISOLATION_POLICY');
      const limiter = await alternative.createRateLimiter(first); check(await limiter.take(subject) === undefined, 'PREFIX_SEPARATE_ALLOW');
      const key = redisKey(otherPrefix, first, subject); keys.push(key);
      check(bulk(await observe(owned, 0, ['GET', key])) === '1' && new Set(keys).size === 5, 'PREFIX_REAL_COUNTER_AND_DISTINCT_KEYS');
    });
    await proof(t, owned, 'real ACL script denial creates no immortal key and repeats no uncertain command', async () => {
      const restricted = await provider(owned, 'denied');
      const policy = { ...base, limit: 1, windowMs: 10_000 }; const subject = 'acl-denied-no-set-or-incr';
      const limiter = await restricted.createRateLimiter(policy); const key = redisKey(primaryPrefix, policy, subject);
      const before = await serverEvalStats(owned);
      await denied(() => limiter.take(subject), 'REDIS_REPLY_ERROR');
      await denied(() => limiter.take(subject), 'REDIS_REPLY_ERROR');
      const after = await serverEvalStats(owned);
      check(after.calls === before.calls + 1 && after.failed === before.failed + 1, 'REAL_DENIED_EVAL_ONCE_NO_REPLAY');
      check(number(await observe(owned, 0, ['EXISTS', key])) === 0 &&
        number(await observe(owned, 0, ['PTTL', key])) === -2, 'ACL_DENIAL_NO_KEY_OR_TTL_GAP');
    });
    await proof(t, owned, 'actual keyspace reports every live key expiring in both logical DBs', async () => {
      const keyspace = fields(await observe(owned, 0, ['INFO', 'keyspace']));
      check(Object.keys(keyspace).some((key) => /^db[01]$/.test(key)), 'REAL_LIVE_KEYS_REQUIRED');
      for (const [database, text] of Object.entries(keyspace)) {
        check(/^db[01]$/.test(database), 'ONLY_OWNED_TWO_LOGICAL_DBS');
        const row = Object.fromEntries(text.split(',').map((item) => item.split('=')));
        check(Number.isSafeInteger(Number(row.keys)) && Number(row.keys) > 0 &&
          Number(row.keys) === Number(row.expires), 'EVERY_ACTUAL_LIVE_KEY_HAS_TTL');
      }
    });
    await proof(t, owned, 'stopping only the owned child makes existing providers fail closed', async () => {
      await stop(owned);
      // Actual existing-socket PING observes shutdown; no sleep, reconnect or dial.
      await denied(async () => a.checkReady(), 'REDIS_CONNECTION_FAILED');
      const limiter = await a.createRateLimiter(base);
      await denied(() => limiter.take('after-owned-stop'), 'REDIS_CONNECTION_FAILED');
      await denied(() => limiter.take('after-owned-stop'), 'REDIS_CONNECTION_FAILED');
    });
    check(owned.childrenPassed === 8, 'ALL_EIGHT_NATIVE_PROOFS_REQUIRED');
  } catch (error) {
    throw error instanceof LocalFailure || error instanceof RedisRespError ? error : new LocalFailure('LOCAL_NATIVE_OPERATION_FAILED');
  } finally {
    if (owner !== undefined) {
      let cleanupFailure: LocalFailure | undefined;
      try {
        await cleanup(owner);
        cleanupSucceeded = true;
      } catch { cleanupFailure = new LocalFailure('BOUNDED_CLEANUP_FAILED'); }
      finally {
        owner.secrets.limiter = ''; owner.secrets.denied = ''; owner.secrets.observer = '';
        try {
          await writeFile(join(owner.directory, 'safe-summary.json'), JSON.stringify({
            mode: 'owned_RAM_only_no_retry', startedUtc, finishedUtc: new Date().toISOString(),
            pid: owner.pid, port: owner.port, listenerVerified: owner.listenerVerified, identityVerified: owner.identityVerified,
            childrenPassed: owner.childrenPassed, providerCount: owner.providers.length,
            probeOpened: owner.probeOpened, probeClosed: owner.probeClosed,
            childClosed: owner.closed, cleanupSucceeded, artifactsRetained: true,
          }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        } catch { cleanupFailure ??= new LocalFailure('PRIVATE_SUMMARY_WRITE_FAILED'); }
        t.diagnostic(JSON.stringify({ artifactDirectory: owner.directory, cleanupSucceeded, artifactsRetained: true }));
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
    }
  }
});
