import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

// Deliberately not a Redis SDK: one connection, one in-flight request, RESP2,
// AUTH/SELECT/PING and single-key EVAL only. Never reconnect, redirect or retry.
export const REDIS_RESP_BOUNDS = Object.freeze({
  connectMs: 2_000, commandMs: 2_000, closeMs: 1_000,
  pending: 64, bufferBytes: 16_384, bulkBytes: 8_192,
  lineBytes: 1_024, arrayElements: 32, nodes: 128, depth: 4,
});
export type RedisRespErrorCode =
  | 'REDIS_INVALID_URL' | 'REDIS_INVALID_COMMAND' | 'REDIS_CONNECTION_FAILED'
  | 'REDIS_TLS_FAILED' | 'REDIS_TIMEOUT' | 'REDIS_CLOSED'
  | 'REDIS_QUEUE_FULL' | 'REDIS_PROTOCOL_ERROR' | 'REDIS_REPLY_ERROR'
  | 'REDIS_CLOSE_TIMEOUT' | 'REDIS_INVALID_OPTIONS' | 'REDIS_INVALID_LIMITER'
  | 'REDIS_INVALID_KEY';

/** No driver message, remote reply, URL, arguments, cause or raw stack escapes. */
export class RedisRespError extends Error {
  constructor(readonly code: RedisRespErrorCode) {
    super(code);
    this.name = 'RedisRespError';
    this.stack = 'RedisRespError: ' + code;
  }
}
export type RedisRespValue = string | Buffer | number | null | readonly RedisRespValue[];
interface Parsed { readonly value: RedisRespValue; readonly bytes: number }

/** Bounded pure RESP2 decoder; undefined means an incomplete fragmented frame. */
export function decodeRedisResp2(buffer: Buffer): Parsed | undefined {
  if (buffer.length > REDIS_RESP_BOUNDS.bufferBytes) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
  let nodes = 0;
  function parse(offset: number, depth: number): Parsed | undefined {
    if (depth > REDIS_RESP_BOUNDS.depth || ++nodes > REDIS_RESP_BOUNDS.nodes) {
      throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    }
    if (offset >= buffer.length) return undefined;
    const type = buffer[offset];
    if (![43, 45, 58, 36, 42].includes(type ?? -1)) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    const end = buffer.indexOf('\r\n', offset + 1);
    if (end < 0) {
      if (buffer.length - offset > REDIS_RESP_BOUNDS.lineBytes) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
      return undefined;
    }
    if (end - offset > REDIS_RESP_BOUNDS.lineBytes) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    const line = buffer.toString('utf8', offset + 1, end);
    if (/[\r\n\0]/.test(line)) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    const start = end + 2;
    if (type === 45) throw new RedisRespError('REDIS_REPLY_ERROR');
    if (type === 43) return { value: line, bytes: start - offset };
    const integer = type === 58 ? /^[+-]?[0-9]+$/ : /^(?:[0-9]+|-1)$/;
    if (!integer.test(line)) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    const size = Number(line);
    if (!Number.isSafeInteger(size)) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    if (type === 58) return { value: size, bytes: start - offset };
    if (size === -1) return { value: null, bytes: start - offset };
    if (type === 36) {
      if (size > REDIS_RESP_BOUNDS.bulkBytes) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
      if (buffer.length < start + size + 2) return undefined;
      if (buffer[start + size] !== 13 || buffer[start + size + 1] !== 10) {
        throw new RedisRespError('REDIS_PROTOCOL_ERROR');
      }
      return { value: Buffer.from(buffer.subarray(start, start + size)), bytes: start + size + 2 - offset };
    }
    if (size > REDIS_RESP_BOUNDS.arrayElements) throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    const values: RedisRespValue[] = [];
    let cursor = start;
    for (let index = 0; index < size; index += 1) {
      const child = parse(cursor, depth + 1);
      if (child === undefined) return undefined;
      values.push(child.value);
      cursor += child.bytes;
    }
    return { value: values, bytes: cursor - offset };
  }
  return parse(0, 0);
}

interface Endpoint {
  readonly host: string; readonly port: number; readonly tls: boolean; readonly database: number;
  username: Buffer | undefined; password: Buffer | undefined;
}
function endpoint(value: string): Endpoint {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 ||
        /[\s\u0000-\u001f\u007f?#\\]/.test(value) || value.split('@').length > 2) throw new Error();
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol) || url.search !== '' || url.hash !== '') throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) === 0 && (host.length > 253 || !host.split('.').every(
      (label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
    ))) throw new Error();
    const port = url.port === '' ? 6379 : Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error();
    // Only explicit canonical numeric logical DBs, never paths/socket/query options.
    if (!/^(?:|\/(?:0|[1-9][0-9]*)?)$/.test(url.pathname)) throw new Error();
    const database = url.pathname === '' || url.pathname === '/' ? 0 : Number(url.pathname.slice(1));
    if (!Number.isSafeInteger(database) || database > 15) throw new Error();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    for (const secret of [username, password]) {
      if (/[\u0000-\u001f\u007f]/.test(secret)) throw new Error();
      const bytes = Buffer.from(secret);
      const valid = bytes.toString('utf8') === secret;
      bytes.fill(0);
      if (!valid) throw new Error();
    }
    if (Buffer.byteLength(username) > 128 || Buffer.byteLength(password) > 1_024 ||
        (value.includes('@') && password === '')) throw new Error();
    return { host, port, tls: url.protocol === 'rediss:', database,
      username: username === '' ? undefined : Buffer.from(username),
      password: password === '' ? undefined : Buffer.from(password) };
  } catch { throw new RedisRespError('REDIS_INVALID_URL'); }
}

interface Pending {
  readonly frame: Buffer;
  readonly resolve: (value: RedisRespValue) => void;
  readonly reject: (error: RedisRespError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RedisRespClient {
  private socket: Socket | TLSSocket | undefined;
  private transportClosed = false;
  private connected = false;
  private failure: RedisRespError | undefined;
  private connectingReject: ((error: RedisRespError) => void) | undefined;
  private connectingTimer: ReturnType<typeof setTimeout> | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private active: Pending | undefined;
  private readonly queue: Pending[] = [];
  private closePromise: Promise<void> | undefined;

  private constructor() {}

  static async connect(url: string): Promise<RedisRespClient> {
    const address = endpoint(url);
    const client = new RedisRespClient();
    try {
      await client.dial(address);
      if (address.password !== undefined) {
        const auth = address.username === undefined
          ? ['AUTH', address.password] : ['AUTH', address.username, address.password];
        if (await client.command(auth) !== 'OK') client.invalidate('REDIS_PROTOCOL_ERROR');
      }
      // DB zero is the new-connection default; omit SELECT 0 for Redis Cluster.
      if (address.database !== 0 &&
          await client.command(['SELECT', String(address.database)]) !== 'OK') client.invalidate('REDIS_PROTOCOL_ERROR');
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error instanceof RedisRespError ? error : new RedisRespError('REDIS_CONNECTION_FAILED');
    } finally {
      address.username?.fill(0); address.password?.fill(0);
      address.username = undefined; address.password = undefined;
    }
  }

  private dial(address: Endpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectingReject = reject;
      this.connectingTimer = setTimeout(() => this.fail('REDIS_TIMEOUT'), REDIS_RESP_BOUNDS.connectMs);
      try {
        const socket = address.tls ? connectTls({
          host: address.host, port: address.port, rejectUnauthorized: true, minVersion: 'TLSv1.2',
          ...(isIP(address.host) === 0 ? { servername: address.host } : {}),
        }) : connectTcp({ host: address.host, port: address.port });
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (data: Buffer) => this.receive(data));
        socket.on('error', () => this.fail(address.tls && !this.connected ? 'REDIS_TLS_FAILED' : 'REDIS_CONNECTION_FAILED'));
        socket.on('end', () => this.fail('REDIS_CONNECTION_FAILED'));
        socket.on('close', () => { this.transportClosed = true; this.fail('REDIS_CONNECTION_FAILED'); });
        socket.once(address.tls ? 'secureConnect' : 'connect', () => {
          if (this.failure !== undefined) return;
          if (address.tls && (!('authorized' in socket) || socket.authorized !== true)) {
            this.fail('REDIS_TLS_FAILED'); return;
          }
          clearTimeout(this.connectingTimer); this.connectingTimer = undefined; this.connectingReject = undefined;
          this.connected = true; resolve();
        });
      } catch { this.fail('REDIS_CONNECTION_FAILED'); }
    });
  }

  command(parts: readonly (string | Buffer)[]): Promise<RedisRespValue> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (!this.connected) return Promise.reject(new RedisRespError('REDIS_CONNECTION_FAILED'));
    if (!Array.isArray(parts)) return Promise.reject(new RedisRespError('REDIS_INVALID_COMMAND'));
    if (this.queue.length + (this.active === undefined ? 0 : 1) >= REDIS_RESP_BOUNDS.pending) {
      return Promise.reject(new RedisRespError('REDIS_QUEUE_FULL'));
    }
    const name = parts[0];
    if (!((name === 'PING' && parts.length === 1) || (name === 'AUTH' && [2, 3].includes(parts.length)) ||
        (name === 'SELECT' && parts.length === 2) || (name === 'EVAL' && parts.length === 6 && parts[2] === '1'))) {
      return Promise.reject(new RedisRespError('REDIS_INVALID_COMMAND'));
    }
    const chunks: Buffer[] = [Buffer.from('*' + parts.length + '\r\n')];
    let size = chunks[0]?.length ?? 0;
    for (const part of parts) {
      if ((typeof part !== 'string' && !Buffer.isBuffer(part)) ||
          (typeof part === 'string' ? Buffer.byteLength(part) : part.length) > REDIS_RESP_BOUNDS.bufferBytes - size) {
        for (const chunk of chunks) chunk.fill(0);
        return Promise.reject(new RedisRespError('REDIS_INVALID_COMMAND'));
      }
      const bytes = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part);
      const head = Buffer.from('$' + bytes.length + '\r\n');
      chunks.push(head, bytes, Buffer.from('\r\n'));
      size += head.length + bytes.length + 2;
      if (size > REDIS_RESP_BOUNDS.bufferBytes) {
        for (const chunk of chunks) chunk.fill(0);
        return Promise.reject(new RedisRespError('REDIS_INVALID_COMMAND'));
      }
    }
    const frame = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    return new Promise((resolve, reject) => {
      const pending: Pending = { frame, resolve, reject,
        timer: setTimeout(() => this.fail('REDIS_TIMEOUT'), REDIS_RESP_BOUNDS.commandMs) };
      this.queue.push(pending); this.pump();
    });
  }

  private pump(): void {
    if (this.failure !== undefined || this.active !== undefined) return;
    const pending = this.queue.shift();
    if (pending === undefined) return;
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) { this.queue.unshift(pending); this.fail('REDIS_CONNECTION_FAILED'); return; }
    this.active = pending;
    try { socket.write(pending.frame, () => pending.frame.fill(0)); }
    catch { this.fail('REDIS_CONNECTION_FAILED'); }
  }

  private receive(data: Buffer): void {
    if (this.failure !== undefined) { data.fill(0); return; }
    if (this.active === undefined || this.buffer.length + data.length > REDIS_RESP_BOUNDS.bufferBytes) {
      data.fill(0); this.fail('REDIS_PROTOCOL_ERROR'); return;
    }
    const next = Buffer.concat([this.buffer, data]);
    this.buffer.fill(0); data.fill(0); this.buffer = next;
    try {
      const reply = decodeRedisResp2(this.buffer);
      if (reply === undefined) return;
      if (reply.bytes !== this.buffer.length) { this.fail('REDIS_PROTOCOL_ERROR'); return; }
      const pending = this.active;
      this.active = undefined; clearTimeout(pending.timer);
      this.buffer.fill(0); this.buffer = Buffer.alloc(0);
      pending.resolve(reply.value);
      // Let the purpose caller validate its reply before dispatching queued work.
      queueMicrotask(() => this.pump());
    } catch (error) {
      this.fail(error instanceof RedisRespError ? error.code : 'REDIS_PROTOCOL_ERROR');
    }
  }

  invalidate(code: RedisRespErrorCode): never {
    this.fail(code);
    throw this.failure ?? new RedisRespError(code);
  }

  private fail(code: RedisRespErrorCode): void {
    if (this.failure !== undefined) return;
    this.failure = new RedisRespError(code); this.connected = false;
    clearTimeout(this.connectingTimer); this.connectingTimer = undefined;
    this.connectingReject?.(this.failure); this.connectingReject = undefined;
    this.socket?.destroy();
    this.buffer.fill(0); this.buffer = Buffer.alloc(0);
    const pending = [...(this.active === undefined ? [] : [this.active]), ...this.queue];
    this.active = undefined; this.queue.length = 0;
    for (const item of pending) { clearTimeout(item.timer); item.frame.fill(0); item.reject(this.failure); }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.fail('REDIS_CLOSED');
    const socket = this.socket;
    this.closePromise = socket === undefined || this.transportClosed ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeListener('close', done); reject(new RedisRespError('REDIS_CLOSE_TIMEOUT')); },
        REDIS_RESP_BOUNDS.closeMs);
      const done = () => { clearTimeout(timer); resolve(); };
      socket.once('close', done);
    });
    return this.closePromise;
  }
}
