import type { NormalizedUsage, UsageProtocol } from './usage.js';

export type RequestState =
  | 'received'
  | 'rejected'
  | 'admitted'
  | 'routing'
  | 'connecting'
  | 'streaming'
  | 'nonstream'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type TrafficSource = 'production' | 'playground' | 'health';
export interface RequestRecord {
  id: string;
  proxyKeyId: string | null;
  source: TrafficSource;
  clientProtocol: UsageProtocol | 'unknown';
  requestModel: string | null;
  routeId: string | null;
  configRevision: number | null;
  state: RequestState;
  finalHttpStatus: number | null;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  firstByteMs: number | null;
  firstEventMs: number | null;
  firstTextMs: number | null;
  finalUpstreamId: string | null;
}
export interface AttemptRecord {
  id: string;
  requestId: string;
  ordinal: number;
  upstreamId: string;
  credentialId: string | null;
  resolvedModel: string | null;
  reportedModel: string | null;
  protocol: UsageProtocol | 'unknown';
  outcome: 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  status: number | null;
  retryReason: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  usage: NormalizedUsage | null;
  pricingVersion: string | null;
  costMicros: number | null;
  currency: string | null;
}
