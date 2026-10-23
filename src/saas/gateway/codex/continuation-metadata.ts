/** Server-only identity metadata; JSON fields and headers cannot create this authority. */
const canonicalRequests = new WeakSet<object>();
export function markCodexCanonicalReplay<T extends object>(body: T): T { canonicalRequests.add(body); return body; }
export function codexContinuationMode(body: unknown): 'full' | 'canonical-replay' {
  return body !== null && typeof body === 'object' && canonicalRequests.has(body) ? 'canonical-replay' : 'full';
}
