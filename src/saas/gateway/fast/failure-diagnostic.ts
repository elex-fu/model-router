import { FastGatewayExecutionError } from './executor.js';
import { FastGatewaySnapshotError } from './snapshots.js';

/** Fixed vocabularies only: never forward an exception message, name, cause or arbitrary field. */
const SAFE_CODES = new Set([
  'SNAPSHOT_DENIED',
  'SNAPSHOT_UNAVAILABLE',
  'SNAPSHOT_BUSY',
  'FAST_AUTHORITY_EXPIRED',
  'FAST_PAYLOAD_REJECTED',
  'FAST_UNAVAILABLE',
  'FAST_RATE_LIMITED',
  'FAST_QUOTA_EXCEEDED',
  'FAST_REQUEST_EXISTS',
  'FAST_CREDIT_BUSY',
  'FAST_JOURNAL_UNAVAILABLE',
  'FAST_CREDIT_NOT_READY',
  'FAST_CREDIT_UNAVAILABLE',
  'FAST_LEASE_UNAVAILABLE',
  // PostgreSQL SQLSTATEs relevant to a closed reserve/read, never SQL or parameters.
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '23502',
  '23503',
  '23505',
  '23514',
  '40001',
  '40P01',
  '42501',
  '53300',
  '53400',
  '55000',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  // Node transport codes; unknown/custom codes remain absent.
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
]);
const SAFE_SOURCES = [
  'saas/gateway/fast/snapshots',
  'saas/gateway/fast/executor',
  'saas/gateway/fast/postgres-snapshot-loader',
  'saas/gateway/fast/runtime-snapshot',
  'saas/gateway/fast/redis-snapshot-store',
  'saas/gateway/fast/redis-admission',
  'saas/gateway/fast/journal',
  'saas/gateway/fast/credit-wait',
  'saas/gateway/hold-calculator',
  'saas/gateway/provider-payload-compiler',
  'saas/gateway/provider-http-transport',
  'saas/gateway/http-handler',
  'saas/db/database',
  'saas/db/atomic-statement',
  'server/managed-saas-gateway',
] as const;
const SOURCE_FRAMES = SAFE_SOURCES.map((source) => ({
  source,
  pattern: new RegExp(`/(src|dist)/${source}\\.(ts|js):([0-9]{1,7}):([0-9]{1,7})\\)?$`),
}));

export interface FastGatewayFailureDiagnostic {
  /** Server-owned UUID only; never a client idempotency key or caller identity. */
  readonly requestId?: string;
  readonly headersSent: boolean;
  readonly category: 'snapshot' | 'execution' | 'type-error' | 'range-error' | 'syntax-error' | 'error' | 'unknown';
  readonly code: string | null;
  /** Fixed relative source names and bounded numeric locations, not raw stack lines. */
  readonly frames: readonly { readonly source: string; readonly line: number; readonly column: number }[];
}
export type FastGatewayDiagnosticObserver = (event: FastGatewayFailureDiagnostic) => void | Promise<void>;

function field(error: unknown, name: 'code' | 'stack'): unknown {
  try {
    return error !== null && typeof error === 'object' ? Reflect.get(error, name) : undefined;
  } catch {
    return undefined;
  }
}

function exception(error: unknown): Pick<FastGatewayFailureDiagnostic, 'category' | 'code' | 'frames'> {
  try {
    const category =
      error instanceof FastGatewaySnapshotError
        ? 'snapshot'
        : error instanceof FastGatewayExecutionError
          ? 'execution'
          : error instanceof TypeError
            ? 'type-error'
            : error instanceof RangeError
              ? 'range-error'
              : error instanceof SyntaxError
                ? 'syntax-error'
                : error instanceof Error
                  ? 'error'
                  : 'unknown';
    const rawCode = field(error, 'code');
    const code = typeof rawCode === 'string' && SAFE_CODES.has(rawCode) ? rawCode : null;
    const stack = field(error, 'stack');
    const frames: { source: string; line: number; column: number }[] = [];
    if (typeof stack === 'string') {
      // Ignore the first line (name/message) and bound both scanning and output.
      for (const frame of stack.slice(0, 16384).split('\n').slice(1, 33)) {
        for (const { source, pattern } of SOURCE_FRAMES) {
          const match = pattern.exec(frame);
          if (!match) continue;
          const line = Number(match[3]),
            column = Number(match[4]);
          if (line > 0 && column > 0) frames.push({ source: `${match[1]}/${source}.${match[2]}`, line, column });
          break;
        }
        if (frames.length >= 8) break;
      }
    }
    return { category, code, frames };
  } catch {
    // Even exotic thrown proxies or throwing getters cannot change request ownership.
    return { category: 'unknown', code: null, frames: [] };
  }
}

/** No work on success/disabled paths; observational only, never an error recovery policy. */
export function reportFastGatewayFailure(
  observer: FastGatewayDiagnosticObserver | undefined,
  error: unknown,
  requestId: string,
  headersSent: boolean,
): void {
  if (!observer) return;
  try {
    const event = {
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? { requestId } : {}),
      headersSent,
      ...exception(error),
    };
    // Do not await observers; contain both synchronous throws and rejected async callbacks.
    void Promise.resolve(observer(event)).catch(() => {});
  } catch {
    /* Diagnostics must never replace the original public error or abort. */
  }
}
