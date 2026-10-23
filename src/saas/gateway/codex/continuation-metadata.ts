/** Server-only identity metadata; JSON fields and headers cannot create this authority. */
const canonicalRequests = new WeakSet<object>();
export function markCodexCanonicalReplay<T extends object>(body: T): T { canonicalRequests.add(body); return body; }
const remoteRequests = new WeakSet<object>();
export function codexContinuationMode(body: unknown): 'full' | 'canonical-replay' | 'remote-history' {
  return body !== null && typeof body === 'object' && remoteRequests.has(body) ? 'remote-history' : body !== null && typeof body === 'object' && canonicalRequests.has(body) ? 'canonical-replay' : 'full';
}

const nativeRequests = new WeakSet<object>();
export function markCodexNativeWsRequest<T extends object>(body: T): T { nativeRequests.add(body); return body; }
export function codexUpstreamTransport(body: unknown): 'http' | 'websocket' { return body !== null && typeof body === 'object' && nativeRequests.has(body) ? 'websocket' : 'http'; }

export function markCodexNativeWsRemoteReference<T extends object>(body: T): T { remoteRequests.add(body); nativeRequests.add(body); return body; }
