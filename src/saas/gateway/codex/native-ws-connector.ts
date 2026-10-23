import { createHash } from 'node:crypto';
import { WebSocket } from 'undici';
import { createPinnedProviderHttpConnector, resolveProviderHttpAddresses, resolveEgressProxyTarget, selectPinnedProviderAddress, type ProviderHttpAddressResolver, type ProviderHttpEgressAllowlist, type ProviderHttpPinnedConnectorFactory } from '../provider-http-address.js';
import type { ProviderHttpDispatchProfile } from '../provider-http-transport.js';
import type { CodexNativeWsConnection, CodexNativeWsSocket } from './native-ws-session.js';
// Compatibility reference: CLIProxyAPI codex_websockets_connection.go; not an enforcement contract.
export const CODEX_NATIVE_WS_BETA = 'responses_websockets=2026-02-06';
export const CODEX_NATIVE_WS_ENDPOINT = 'wss://chatgpt.com/backend-api/codex/responses';
export interface PreparedCodexNativeWsConnector {
  readonly egressIdentity: string;
  open(headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<CodexNativeWsConnection>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
/** Reuses the exact HTTP DNS/proxy/TLS connector pipeline; no alternate URL or direct WS dial. */
export async function prepareCodexNativeWsConnector(options: {
  readonly signal: AbortSignal;
  readonly profile: ProviderHttpDispatchProfile;
  readonly resolveAddresses?: ProviderHttpAddressResolver;
  readonly createConnector?: ProviderHttpPinnedConnectorFactory;
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  readonly timeoutMs: number;
}): Promise<PreparedCodexNativeWsConnector> {
  if (options.signal.aborted) throw new Error('Native response connection cancelled');
  const configuredTarget = options.profile.url ?? options.profile.targetUrl;
  if (configuredTarget !== undefined && configuredTarget !== CODEX_NATIVE_WS_ENDPOINT.replace('wss:', 'https:')) throw new Error('Native response endpoint policy mismatch');
  const target = new URL(CODEX_NATIVE_WS_ENDPOINT);
  const resolveAddresses = options.resolveAddresses ?? resolveProviderHttpAddresses;
  const addresses = await resolveAddresses(target.hostname, options.signal);
  const address = selectPinnedProviderAddress(target.hostname, addresses, undefined, options.egressAllowlist);
  const proxy = options.profile.egressProxy ? await resolveEgressProxyTarget(options.profile.egressProxy, { resolveAddresses, signal: options.signal, egressAllowlist: options.egressAllowlist }) : undefined;
  if (options.profile.tlsFingerprint && !options.createConnector) throw new Error('Native response TLS profile connector unavailable');
  const connectorInput = { hostname: target.hostname, port: 443, ...address, ...(proxy ? { proxy } : {}), ...(options.profile.tlsFingerprint ? { tlsFingerprint: options.profile.tlsFingerprint } : {}) };
  if (options.signal.aborted) throw new Error('Native response connection cancelled');
  const egressIdentity = createHash('sha256').update(canonical(connectorInput)).digest('hex');
  return {
    egressIdentity,
    async open(headers, signal) {
      if (signal.aborted) throw new Error('Native response connection cancelled');
      const connector = (options.createConnector ?? createPinnedProviderHttpConnector)(connectorInput);
      let socket: InstanceType<typeof WebSocket>;
      try { socket = new WebSocket(CODEX_NATIVE_WS_ENDPOINT, { dispatcher: connector.dispatcher, headers }); }
      catch { await connector.destroy(); throw new Error('Native response connection failed'); }
      socket.binaryType = 'arraybuffer';
      const messageListeners = new Set<(data: string) => void>();
      const closeListeners = new Set<() => void>();
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        socket.close(1000, 'session ended');
        for (const listener of closeListeners) listener();
        messageListeners.clear(); closeListeners.clear();
        await connector.destroy().catch(() => undefined);
      };
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') { void close(); return; }
        for (const listener of messageListeners) listener(event.data);
      });
      socket.addEventListener('close', () => { void close(); });
      socket.addEventListener('error', () => { void close(); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); void close(); reject(new Error('Native response connection timed out')); }, options.timeoutMs);
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Native response connection failed')); };
        const abort = () => { cleanup(); void close(); reject(new Error('Native response connection cancelled')); };
        socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', failed, { once: true }); socket.addEventListener('close', failed, { once: true }); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }).catch(async (error) => { await close(); throw error; });
      const wrapped: CodexNativeWsSocket = {
        get bufferedAmount() { return socket.bufferedAmount; },
        send(data) { if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('Native response connection unavailable'); socket.send(data); },
        close() { void close(); },
        onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
        onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      };
      return { socket: wrapped, close };
    },
  };
}
