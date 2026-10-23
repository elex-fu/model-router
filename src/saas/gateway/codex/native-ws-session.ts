import { randomUUID } from 'node:crypto';

declare const sessionBrand: unique symbol;
/** Authority lives in the private WeakMap, never in JSON or client headers. */
export interface CodexNativeWsSessionHandle { readonly [sessionBrand]: true }
export interface CodexNativeWsSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
}
export interface CodexNativeWsConnection {
  readonly socket: CodexNativeWsSocket;
  close(): Promise<void>;
}
export interface CodexNativeWsIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly credentialAuthzVersion: string;
  readonly publicModel: string;
  readonly model: string;
  readonly endpoint: string;
  readonly egressIdentity: string;
}
export class CodexNativeWsSessionError extends Error {
  constructor(readonly code: 'full_context_required' | 'native_ws_busy' | 'native_ws_session_closed') { super(code === 'full_context_required' ? 'resend full context on a new connection' : 'the native response connection is unavailable'); }
}
export class CodexNativeWsSession {
  readonly generation = randomUUID();
  private identity: CodexNativeWsIdentity | null = null;
  private connection: CodexNativeWsConnection | null = null;
  private completed = new Set<string>();
  private active = false;
  private closed = false;
  private readonly closedListeners = new Set<() => void>();
  private detachClosed: (() => void) | null = null;
  async begin(identity: CodexNativeWsIdentity, previousId: string | null, connect: () => Promise<CodexNativeWsConnection>): Promise<CodexNativeWsSocket> {
    if (this.closed) throw new CodexNativeWsSessionError('native_ws_session_closed');
    if (this.active) throw new CodexNativeWsSessionError('native_ws_busy');
    if (this.identity && Object.entries(identity).some(([key, value]) => this.identity?.[key as keyof CodexNativeWsIdentity] !== value)) throw new CodexNativeWsSessionError('full_context_required');
    if (previousId !== null && !this.completed.has(previousId)) throw new CodexNativeWsSessionError('full_context_required');
    this.active = true;
    try {
      if (!this.connection) {
        this.connection = await connect();
        if (this.closed) { await this.connection.close(); this.connection = null; throw new CodexNativeWsSessionError('native_ws_session_closed'); }
        this.identity = { ...identity };
        this.detachClosed = this.connection.socket.onClose(() => { void this.close(); });
      }
      return this.connection.socket;
    } catch (error) { this.active = false; throw error; }
  }
  onClosed(listener: () => void): () => void { if (this.closed) { listener(); return () => {}; } this.closedListeners.add(listener); return () => this.closedListeners.delete(listener); }
  hasCompleted(responseId: string): boolean { return this.completed.has(responseId); }
  finish(responseId: string | null): void {
    this.active = false;
    if (responseId !== null) {
      if (this.completed.size >= 256) this.completed.delete(this.completed.values().next().value ?? '');
      this.completed.add(responseId);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.completed.clear();
    for (const listener of this.closedListeners) listener();
    this.closedListeners.clear();
    this.detachClosed?.();
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }
}
const sessions = new WeakMap<object, CodexNativeWsSession>();
export function createCodexNativeWsSessionHandle(): CodexNativeWsSessionHandle {
  const handle = Object.freeze({}) as CodexNativeWsSessionHandle;
  sessions.set(handle, new CodexNativeWsSession());
  return handle;
}
export function isCodexNativeWsSessionHandle(value: unknown): value is CodexNativeWsSessionHandle { return value !== null && typeof value === 'object' && sessions.has(value); }
export function codexNativeWsSession(handle: CodexNativeWsSessionHandle): CodexNativeWsSession {
  const session = sessions.get(handle);
  if (!session) throw new CodexNativeWsSessionError('native_ws_session_closed');
  return session;
}
export async function closeCodexNativeWsSessionHandle(handle: CodexNativeWsSessionHandle): Promise<void> { await sessions.get(handle)?.close(); }
