import { CODEX_NATIVE_WS_ENDPOINT } from '../gateway/codex/native-ws-connector.js';
import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { resolveCodexTrustedBoundProfile } from './codex-trusted-bound-profiles.js';
import type { CodexWorkflowReadiness } from './gateway-capability-readiness.js';

export interface CodexFinancialCatalogScope {
  readonly providerId: 'openai-codex';
  readonly productId: 'codex-chatgpt';
  readonly resolvedModel: string;
  readonly catalogEndpoint: 'codex-responses';
  readonly protocol: 'responses';
}

export type CodexWorkflowFinancialReadiness = Readonly<Record<CodexWorkflowReadiness['workflow'], boolean>>;

/** The same declared workflow set is used for bundle aggregation and mounting. */
export function declaredCodexFinancialWorkflows(nativeCompact: boolean): readonly CodexWorkflowReadiness['workflow'][] {
  const workflows: CodexWorkflowReadiness['workflow'][] = ['responses-http-full', 'responses-ws-full', 'responses-ws-continuation',
    ...(nativeCompact ? ['responses-compact' as const] : [])];
  return Object.freeze(workflows);
}

/** Static catalog coverage only: no route, entitlement, price, credential or live-workflow admission. */
export function collectCodexWorkflowFinancialReadiness(
  candidates: readonly (CodexFinancialCatalogScope | null)[] | undefined,
  nowMs = Date.now(),
): CodexWorkflowFinancialReadiness {
  const unavailable: CodexWorkflowFinancialReadiness = Object.freeze({
    'responses-http-full': false,
    'responses-ws-full': false,
    'responses-ws-continuation': false,
    'responses-compact': false,
  });
  if (!Array.isArray(candidates) || candidates.length === 0 || !Number.isFinite(nowMs)) return unavailable;
  // Never discard a bad observation and accidentally certify the remaining subset.
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' ||
      candidate.providerId !== 'openai-codex' || candidate.productId !== 'codex-chatgpt' ||
      candidate.catalogEndpoint !== 'codex-responses' || candidate.protocol !== 'responses' ||
      typeof candidate.resolvedModel !== 'string' || !/\S/.test(candidate.resolvedModel)) return unavailable;
  }
  const covered = (endpoint: string, operation: string, transport: 'http' | 'websocket',
    continuationMode: 'full' | 'canonical-replay' | 'remote-history' | 'compact'): boolean =>
    candidates.every((candidate) => candidate !== null && resolveCodexTrustedBoundProfile({
      endpoint, productId: candidate.productId, model: candidate.resolvedModel,
      operation, transport, continuationMode,
    }, nowMs) !== null);
  return Object.freeze({
    'responses-http-full': covered(CODEX_RESPONSES_ENDPOINT, 'responses', 'http', 'full'),
    'responses-ws-full': covered(CODEX_NATIVE_WS_ENDPOINT, 'responses', 'websocket', 'full'),
    'responses-ws-continuation': covered(CODEX_NATIVE_WS_ENDPOINT, 'responses', 'websocket', 'canonical-replay') &&
      covered(CODEX_NATIVE_WS_ENDPOINT, 'responses', 'websocket', 'remote-history'),
    'responses-compact': covered(`${CODEX_RESPONSES_ENDPOINT}/compact`, 'responses.compact', 'http', 'compact'),
  });
}
