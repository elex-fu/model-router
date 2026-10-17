/**
 * Batch-5 §5.1 plugin runtime (sub2api internal/service/plugin_runtime.go
 * port; the hashicorp go-plugin gRPC transport is replaced by the stdio
 * JSON-RPC protocol in protocol.ts).
 *
 * One PluginRuntime owns one plugin child process. The handshake closes the
 * TOCTOU window the way go-plugin's SecureConfig does for sub2api: the host
 * re-hashes the entrypoint bytes immediately before spawn, and the child
 * must echo the SHA-256 of its own running entrypoint in `initialize` —
 * both must equal the manifest `files` hash or the process is killed before
 * it can serve traffic.
 *
 * The forward path is a full HTTP roundtrip through the plugin: request
 * frames host→plugin (begin → body → end), response frames plugin→host
 * (start → body → end | error). The response is surfaced as a status +
 * header map + a one-reader body stream so the gateway's existing
 * usage-observation / settlement chain can consume it unchanged.
 */

import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PLUGIN_BODY_CHUNK_MAX_BYTES,
  PLUGIN_MAX_WIRE_LINE_BYTES,
  PLUGIN_STDERR_RING_BYTES,
  type ForwardAccountContext,
  type InitializeParams,
  type PluginHostServices,
  type PluginRpcId,
  type PluginRpcNotification,
  type PluginRpcRequest,
  type SessionWrappedCredential,
} from './protocol.js';
import {
  PluginTransportError,
  PLUGIN_HOST_VERSION,
  PLUGIN_MAGIC_COOKIE_VALUE,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TRANSPORT_API_VERSION,
} from './types.js';

export class PluginRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginRuntimeError';
  }
}

/** Raw SPKI prefix for a 32-byte X25519 public key (OID 1.3.101.110). */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_RAW_KEY_BYTES = 32;
const SESSION_NONCE_BYTES = 12;
const SESSION_KEY_BYTES = 32;
const SESSION_HKDF_SALT = 'model-router-plugin-session:v1';

export function rawX25519PublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return Buffer.from(der.subarray(der.length - X25519_RAW_KEY_BYTES));
}

/**
 * The per-runtime session key: X25519(host ephemeral, plugin ephemeral)
 * through HKDF-SHA256. The host's public half travels in `initialize`
 * params; the plugin's public half comes back in the result. Neither side
 * ever transmits the shared secret, and the plaintext credential sealed
 * under this key never appears on any wire.
 */
export function derivePluginSessionKey(
  hostPrivateKey: KeyObject,
  pluginPublicKeyRaw: Buffer,
  pluginKey: string,
): Buffer {
  const pluginPublic = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, pluginPublicKeyRaw]),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: hostPrivateKey, publicKey: pluginPublic });
  return Buffer.from(hkdfSync('sha256', shared, SESSION_HKDF_SALT, pluginKey, SESSION_KEY_BYTES));
}

export interface PluginForwardStreamResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  /** One-reader stream; closes on `response.end`, errors on `response.error`. */
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface PluginForwardInput {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: Uint8Array | null;
  readonly account: ForwardAccountContext;
  readonly credentialEnvelope: SessionWrappedCredential | null;
  readonly signal: AbortSignal;
}

interface PendingRpc {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ForwardState {
  readonly requestId: string;
  beginAccepted: boolean;
  startDeferred: {
    resolve(value: PluginForwardStreamResult): void;
    reject(error: PluginTransportError): void;
  } | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  bodyClosed: boolean;
  finish: () => void;
}

export interface PluginRuntimeOptions {
  readonly pluginKey: string;
  readonly version: string;
  readonly entryPath: string;
  /** Expected entrypoint SHA-256 (manifest `files` hash of the entrypoint). */
  readonly binarySha256: string;
  readonly config: Readonly<Record<string, unknown>> | null;
  readonly hostServices: PluginHostServices;
  readonly startTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
  readonly configTimeoutMs?: number;
  readonly beginTimeoutMs?: number;
  /** Injectable child launcher (tests substitute scripted children). */
  readonly launch?: (entryPath: string, env: Readonly<Record<string, string>>) => ChildProcess;
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 15_000;
const DEFAULT_BEGIN_TIMEOUT_MS = 15_000;

export class PluginRuntime {
  private readonly options: PluginRuntimeOptions & {
    readonly startTimeoutMs: number;
    readonly healthTimeoutMs: number;
    readonly configTimeoutMs: number;
    readonly beginTimeoutMs: number;
  };
  private child: ChildProcess | null = null;
  private nextRpcId = 1;
  private readonly pending = new Map<PluginRpcId, PendingRpc>();
  private readonly forwards = new Map<string, ForwardState>();
  private outBuffer = '';
  private writeChain: Promise<void> = Promise.resolve();
  private stderrRing = '';
  private exited = false;
  private inflightRequests = 0;
  private draining = false;
  private drainWaiters: (() => void)[] = [];
  private sessionKey: Buffer | null = null;

  constructor(options: PluginRuntimeOptions) {
    this.options = {
      ...options,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      healthTimeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      configTimeoutMs: options.configTimeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
      beginTimeoutMs: options.beginTimeoutMs ?? DEFAULT_BEGIN_TIMEOUT_MS,
    };
  }

  get pluginKey(): string {
    return this.options.pluginKey;
  }

  get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  get lastStderr(): string {
    return this.stderrRing;
  }

  /** The pre-spawn half of the TOCTOU gate: re-hash the entrypoint bytes now. */
  private async verifyEntrypointBytes(): Promise<void> {
    const bytes = await readFile(this.options.entryPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== this.options.binarySha256) {
      throw new PluginRuntimeError('BINARY_HASH_MISMATCH', 'plugin entrypoint no longer matches its verified hash');
    }
  }

  /**
   * Spawn + handshake. Throws PluginRuntimeError on any gate failure; the
   * child is killed before this method throws.
   */
  async start(): Promise<void> {
    await this.verifyEntrypointBytes();
    const env: Record<string, string> = {
      // Minimal environment (the go-plugin SkipHostEnv discipline): the magic
      // cookie prevents a non-plugin binary from being usable as a plugin,
      // PATH lets shebang entrypoints resolve their interpreter.
      MR_PLUGIN_MAGIC_COOKIE: PLUGIN_MAGIC_COOKIE_VALUE,
      MR_PLUGIN_PROTOCOL_VERSION: String(PLUGIN_PROTOCOL_VERSION),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    };
    const launch =
      this.options.launch ??
      ((entryPath: string, childEnv: Readonly<Record<string, string>>) =>
        spawn(entryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd: dirname(entryPath) }));
    const child = launch(this.options.entryPath, env);
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill('SIGKILL');
      throw new PluginRuntimeError('SPAWN_FAILED', 'plugin child did not expose piped stdio');
    }
    this.child = child;
    this.exited = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrRing = (this.stderrRing + chunk).slice(-PLUGIN_STDERR_RING_BYTES);
    });
    child.on('exit', () => this.handleExit());

    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const initializeResult = await this.rpcCall(
      'initialize',
      {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        host_version: PLUGIN_HOST_VERSION,
        plugin_key: this.options.pluginKey,
        host_session_public_key: rawX25519PublicKey(publicKey).toString('base64'),
      } satisfies InitializeParams,
      this.options.startTimeoutMs,
    );
    if (!isRecord(initializeResult)) throw this.fatal('HANDSHAKE_FAILED', 'initialize result is not an object');
    if (initializeResult.protocol_version !== PLUGIN_PROTOCOL_VERSION) {
      throw this.fatal('HANDSHAKE_FAILED', 'plugin protocol version mismatch');
    }
    if (initializeResult.entrypoint_sha256 !== this.options.binarySha256) {
      throw this.fatal('BINARY_HASH_MISMATCH', 'plugin entrypoint hash does not match the verified manifest');
    }
    const sessionPublic = decodeBase64Bytes(initializeResult.session_public_key, X25519_RAW_KEY_BYTES);
    if (sessionPublic === null) {
      throw this.fatal('HANDSHAKE_FAILED', 'plugin session public key is malformed');
    }
    this.sessionKey = derivePluginSessionKey(privateKey, sessionPublic, this.options.pluginKey);

    const info = await this.rpcCall('getInfo', {}, this.options.startTimeoutMs);
    if (
      !isRecord(info) ||
      info.plugin_id !== this.options.pluginKey ||
      info.plugin_version !== this.options.version ||
      info.protocol_version !== PLUGIN_PROTOCOL_VERSION ||
      info.transport_api_version !== PLUGIN_TRANSPORT_API_VERSION
    ) {
      throw this.fatal('INFO_MISMATCH', 'plugin runtime info does not match the verified manifest');
    }

    const health = await this.rpcCall('health', {}, this.options.healthTimeoutMs);
    if (!isRecord(health) || health.healthy !== true) {
      throw this.fatal('HEALTH_FAILED', 'plugin reported unhealthy at startup');
    }

    if (this.options.config !== null) {
      await this.applyConfig(this.options.config);
    }
  }

  /** Validate + apply with the plugin's own atomic-swap contract. */
  private async applyConfig(config: Readonly<Record<string, unknown>>): Promise<void> {
    const validated = await this.rpcCall('validateConfig', { config_json: config }, this.options.configTimeoutMs);
    if (!isRecord(validated) || validated.valid !== true) {
      throw new PluginRuntimeError('CONFIG_REJECTED', 'plugin rejected its configuration');
    }
    const normalized = isRecord(validated.normalized_config_json) ? validated.normalized_config_json : config;
    const applied = await this.rpcCall('applyConfig', { config_json: normalized }, this.options.configTimeoutMs);
    if (!isRecord(applied) || applied.applied !== true) {
      throw new PluginRuntimeError('CONFIG_APPLY_FAILED', 'plugin failed to apply its configuration');
    }
  }

  /** Reconcile-loop health probe (sub2api pluginHealthTimeout = 5s). */
  async checkHealth(timeoutMs: number): Promise<boolean> {
    if (!this.alive) return false;
    try {
      const health = await this.rpcCall('health', {}, timeoutMs);
      return isRecord(health) && health.healthy === true;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt credential plaintext under the per-runtime session key. The AAD
   * binds the value to (pluginKey, requestId) so an envelope cannot be
   * replayed against a different request or plugin.
   */
  wrapCredential(plaintext: Uint8Array, requestId: string): SessionWrappedCredential {
    if (this.sessionKey === null) throw new PluginRuntimeError('NO_SESSION', 'runtime has no session key');
    const nonce = randomBytes(SESSION_NONCE_BYTES);
    const aad = `${this.options.pluginKey}\0${requestId}`;
    const cipher = createCipheriv('aes-256-gcm', this.sessionKey, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), aad };
  }

  /**
   * Forward one HTTP roundtrip through the plugin. Resolves when
   * `response.start` arrives; the returned stream then carries the body.
   *
   * REQUEST_SENT rule: any failure at or after acceptance of `forward.begin`
   * is reported with requestSent=true (the plugin may already have dialed
   * upstream). Only pre-acceptance failures carry requestSent=false.
   */
  forward(input: PluginForwardInput): Promise<PluginForwardStreamResult> {
    if (this.draining || !this.alive) {
      return Promise.reject(
        new PluginTransportError('PLUGIN_STOPPING', 'plugin runtime is stopping or unavailable', false),
      );
    }
    const stateRef: ForwardState = {
      requestId: input.requestId,
      beginAccepted: false,
      startDeferred: null,
      controller: null,
      bodyClosed: false,
      finish: () => undefined,
    };
    const promise = new Promise<PluginForwardStreamResult>((resolve, reject) => {
      stateRef.startDeferred = { resolve, reject };
    });
    const finalize = once(() => {
      input.signal.removeEventListener('abort', onAbort);
      this.forwards.delete(input.requestId);
      this.inflightRequests -= 1;
      if (this.draining && this.inflightRequests === 0) {
        for (const waiter of this.drainWaiters.splice(0)) waiter();
      }
    });
    stateRef.finish = finalize;
    const onAbort = () => {
      void this.sendNotification('forward.abort', { request_id: input.requestId, reason: 'client_abort' }).catch(
        () => undefined,
      );
      this.failForward(
        stateRef,
        new PluginTransportError('CLIENT_ABORTED', 'client aborted the plugin forward', true),
        { closeBody: true },
      );
      finalize();
    };
    this.forwards.set(input.requestId, stateRef);
    this.inflightRequests += 1;
    input.signal.addEventListener('abort', onAbort, { once: true });

    void (async () => {
      try {
        await this.rpcCall(
          'forward.begin',
          {
            request_id: input.requestId,
            method: input.method,
            url: input.url,
            headers: input.headers,
            content_length: input.body === null ? null : input.body.length,
            has_body: input.body !== null,
            account: input.account,
            credential_envelope: input.credentialEnvelope,
          },
          this.options.beginTimeoutMs,
        );
        stateRef.beginAccepted = true;
        if (input.body !== null) {
          for (let offset = 0; offset < input.body.length; offset += PLUGIN_BODY_CHUNK_MAX_BYTES) {
            const slice = input.body.subarray(
              offset,
              Math.min(offset + PLUGIN_BODY_CHUNK_MAX_BYTES, input.body.length),
            );
            await this.sendNotification('forward.body', {
              request_id: input.requestId,
              data: Buffer.from(slice).toString('base64'),
            });
          }
        }
        await this.sendNotification('forward.end', { request_id: input.requestId });
      } catch (error) {
        // Before acceptance an explicit plugin rejection may prove
        // request_sent=false; transport-level failures cannot prove anything.
        const requestSent = stateRef.beginAccepted || !(error instanceof PluginRpcRejection);
        this.failForward(
          stateRef,
          new PluginTransportError(
            'PLUGIN_RPC_ERROR',
            error instanceof Error ? error.message : 'plugin forward failed',
            requestSent,
          ),
          { closeBody: true },
        );
        finalize();
      }
    })();

    return promise.then(
      (result) => result,
      (error) => {
        finalize();
        throw error;
      },
    );
  }

  /** Mark draining; in-flight forwards keep running until drain(timeoutMs) kills. */
  beginDrain(): void {
    this.draining = true;
    if (this.inflightRequests === 0) {
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
  }

  async drain(timeoutMs: number): Promise<void> {
    this.beginDrain();
    if (this.inflightRequests > 0) {
      await new Promise<void>((resolve) => {
        let waiter: () => void;
        const timer = setTimeout(() => {
          const index = this.drainWaiters.indexOf(waiter);
          if (index >= 0) this.drainWaiters.splice(index, 1);
          resolve();
        }, timeoutMs);
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        this.drainWaiters.push(waiter);
      });
    }
    this.kill();
  }

  kill(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    child.kill('SIGKILL');
  }

  // -----------------------------------------------------------------------
  // wire plumbing
  // -----------------------------------------------------------------------

  private consumeStdout(chunk: string): void {
    this.outBuffer += chunk;
    if (this.outBuffer.length > PLUGIN_MAX_WIRE_LINE_BYTES * 2) {
      this.handleProtocolViolation('plugin stdout line exceeds the wire limit');
      return;
    }
    for (;;) {
      const newline = this.outBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.outBuffer.slice(0, newline);
      this.outBuffer = this.outBuffer.slice(newline + 1);
      if (line.trim() === '') continue;
      if (Buffer.byteLength(line, 'utf8') > PLUGIN_MAX_WIRE_LINE_BYTES) {
        this.handleProtocolViolation('plugin wire line exceeds the byte limit');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.handleProtocolViolation('plugin emitted a non-JSON line');
        return;
      }
      this.dispatchMessage(message);
    }
  }

  private dispatchMessage(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      this.handleProtocolViolation('plugin emitted a non-JSON-RPC message');
      return;
    }
    if (typeof message.id === 'number' && hasOwn(message, 'result') !== hasOwn(message, 'error')) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (hasOwn(message, 'error')) {
        pending.reject(new PluginRpcRejection(message.error as { code: number; message: string; data?: unknown }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') {
        void this.handleHostServiceCall(message.id, message.method, message.params);
        return;
      }
      this.handlePluginNotification(message.method, message.params);
    }
  }

  private handlePluginNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    const requestId = typeof params.request_id === 'string' ? params.request_id : null;
    if (requestId === null) return;
    const state = this.forwards.get(requestId);
    if (state === undefined) return; // late frame after finish — ignore
    switch (method) {
      case 'response.start': {
        if (state.startDeferred === null) return;
        const status = params.status;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
          this.failForward(
            state,
            new PluginTransportError('PLUGIN_INVALID_RESPONSE', 'plugin response start carried an invalid status', true),
            { closeBody: true },
          );
          state.finish();
          return;
        }
        const headers = parseHeaderMap(params.headers);
        if (headers === null) {
          this.failForward(
            state,
            new PluginTransportError('PLUGIN_INVALID_RESPONSE', 'plugin response start carried invalid headers', true),
            { closeBody: true },
          );
          state.finish();
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            state.controller = controller;
          },
          cancel: () => {
            void this.sendNotification('forward.abort', {
              request_id: state.requestId,
              reason: 'client_abort',
            }).catch(() => undefined);
          },
        });
        const deferred = state.startDeferred;
        state.startDeferred = null;
        deferred.resolve({ status, headers, body });
        return;
      }
      case 'response.body': {
        if (state.controller === null || state.bodyClosed) return;
        if (typeof params.data !== 'string') return;
        const bytes = Buffer.from(params.data, 'base64');
        if (bytes.length === 0 || bytes.length > PLUGIN_MAX_WIRE_LINE_BYTES) return;
        state.controller.enqueue(new Uint8Array(bytes));
        return;
      }
      case 'response.end': {
        if (state.controller !== null && !state.bodyClosed) {
          state.bodyClosed = true;
          state.controller.close();
        }
        state.finish();
        return;
      }
      case 'response.error': {
        const code = typeof params.code === 'string' ? params.code : 'PLUGIN_ERROR';
        const message = typeof params.message === 'string' ? params.message : 'plugin reported a forward error';
        const requestSent = params.request_sent !== false; // absent = conservative true
        this.failForward(state, new PluginTransportError(code, message, requestSent), { closeBody: true });
        state.finish();
        return;
      }
      default:
        return; // unknown notification — ignore
    }
  }

  private failForward(
    state: ForwardState | undefined,
    error: PluginTransportError,
    options: { closeBody: boolean },
  ): void {
    if (state === undefined) return;
    if (state.startDeferred !== null) {
      const deferred = state.startDeferred;
      state.startDeferred = null;
      deferred.reject(error);
    }
    if (options.closeBody && state.controller !== null && !state.bodyClosed) {
      state.bodyClosed = true;
      state.controller.error(error);
    }
  }

  private async handleHostServiceCall(id: PluginRpcId, method: string, params: unknown): Promise<void> {
    const handler = (
      this.options.hostServices as unknown as Record<string, ((params: unknown) => Promise<unknown>) | undefined>
    )[method];
    if (handler === undefined) {
      this.replyError(id, -32601, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      this.replyResult(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'host service failure';
      this.replyError(id, -32000, message.slice(0, 512));
    }
  }

  private rpcCall(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new PluginRuntimeError('RUNTIME_DEAD', 'plugin child is not running'));
        return;
      }
      const id = this.nextRpcId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginRuntimeError('RPC_TIMEOUT', `plugin rpc ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result),
        reject: (error) => reject(error),
        timer,
      });
      this.writeMessage({ jsonrpc: '2.0', id, method, params } satisfies PluginRpcRequest).catch((error) => {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new PluginRuntimeError('WRITE_FAILED', error instanceof Error ? error.message : 'write failed'),
          );
        }
      });
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    return this.writeMessage({ jsonrpc: '2.0', method, params } satisfies PluginRpcNotification);
  }

  private writeMessage(message: unknown): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = this.child;
          if (child === null || child.stdin === null || child.stdin.destroyed) {
            reject(new PluginRuntimeError('RUNTIME_DEAD', 'plugin stdin is closed'));
            return;
          }
          child.stdin.write(line, (error) => {
            if (error === undefined || error === null) resolve();
            else reject(new PluginRuntimeError('WRITE_FAILED', 'plugin stdin write failed'));
          });
        }),
    );
    return this.writeChain;
  }

  private replyResult(id: PluginRpcId, result: unknown): void {
    void this.writeMessage({ jsonrpc: '2.0', id, result }).catch(() => undefined);
  }

  private replyError(id: PluginRpcId, code: number, message: string): void {
    void this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } }).catch(() => undefined);
  }

  private handleExit(): void {
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PluginRuntimeError('RUNTIME_DEAD', 'plugin child exited'));
    }
    this.pending.clear();
    // A crash mid-forward cannot prove the request never reached upstream:
    // every begin-accepted forward fails closed with requestSent=true.
    for (const state of this.forwards.values()) {
      const requestSent = state.beginAccepted;
      this.failForward(
        state,
        new PluginTransportError('PLUGIN_PROCESS_EXITED', 'plugin child exited during the forward', requestSent),
        { closeBody: true },
      );
      state.finish();
    }
    this.forwards.clear();
    this.inflightRequests = 0;
    if (this.draining) {
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
  }

  private handleProtocolViolation(reason: string): void {
    for (const state of this.forwards.values()) {
      this.failForward(
        state,
        new PluginTransportError('PLUGIN_PROTOCOL_ERROR', reason, state.beginAccepted),
        { closeBody: true },
      );
      state.finish();
    }
    this.forwards.clear();
    this.kill();
  }

  /** Kill the child and return the mapped error (handshake helper). */
  private fatal(code: string, message: string): PluginRuntimeError {
    this.kill();
    return new PluginRuntimeError(code, message);
  }
}

/** Distinguishes an explicit plugin JSON-RPC error from transport failure. */
export class PluginRpcRejection extends Error {
  constructor(
    readonly wire: { readonly code: number; readonly message: string; readonly data?: unknown },
  ) {
    super(wire.message);
    this.name = 'PluginRpcRejection';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeBase64Bytes(value: unknown, expectedLength: number): Buffer | null {
  if (typeof value !== 'string') return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  return bytes.length === expectedLength ? bytes : null;
}

function parseHeaderMap(value: unknown): Record<string, readonly string[]> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, readonly string[]> = {};
  for (const [name, headerValues] of Object.entries(value)) {
    if (!Array.isArray(headerValues) || headerValues.some((entry) => typeof entry !== 'string')) return null;
    result[name] = headerValues as readonly string[];
  }
  return result;
}
