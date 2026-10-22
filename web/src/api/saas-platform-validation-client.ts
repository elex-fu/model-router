import { PlatformApiError, request } from './saas-platform-client';

export interface ValidationRequeueStatus {
  state: 'ready' | 'not_eligible';
  jobId: string | null;
  credentialVersion: number | null;
  credentialAuthzVersion: number | null;
  leaseGeneration: number | null;
}

export interface ValidationRequeueInput {
  jobId: string;
  expectedCredentialVersion: number;
  expectedCredentialAuthzVersion: number;
  expectedLeaseGeneration: number;
  reason: string;
}

export interface ValidationRequeueReceipt {
  outcome: 'queued';
  jobId: string;
  credentialVersion: number;
  leaseGeneration: number;
  auditEventId: string;
  recordedAt: string;
  replayed: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new PlatformApiError(200, 'INVALID_RESPONSE', '凭据验证重试响应无效');
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}

function path(accountId: string, credentialId: string): string {
  return `/supply/accounts/${encodeURIComponent(accountId)}/credentials/${encodeURIComponent(credentialId)}/validation-requeue`;
}

export function parseValidationRequeueStatus(value: unknown): ValidationRequeueStatus {
  const body = record(value);
  if (body.state !== 'ready' && body.state !== 'not_eligible') invalid();
  const parsed: ValidationRequeueStatus = {
    state: body.state,
    jobId: body.jobId === null ? null : uuid(body.jobId),
    credentialVersion: body.credentialVersion === null ? null : integer(body.credentialVersion, 1),
    credentialAuthzVersion: body.credentialAuthzVersion === null ? null : integer(body.credentialAuthzVersion, 1),
    leaseGeneration: body.leaseGeneration === null ? null : integer(body.leaseGeneration, 0),
  };
  if (parsed.state === 'ready' && Object.values(parsed).some((field) => field === null)) invalid();
  return parsed;
}

export function parseValidationRequeueReceipt(value: unknown): ValidationRequeueReceipt {
  const body = record(value);
  if (body.outcome !== 'queued' || typeof body.replayed !== 'boolean' || typeof body.recordedAt !== 'string' || !Number.isFinite(Date.parse(body.recordedAt))) invalid();
  return {
    outcome: 'queued', jobId: uuid(body.jobId), credentialVersion: integer(body.credentialVersion, 1),
    leaseGeneration: integer(body.leaseGeneration, 1), auditEventId: uuid(body.auditEventId),
    recordedAt: body.recordedAt, replayed: body.replayed,
  };
}

export const platformValidationClient = {
  async getStatus(accountId: string, credentialId: string): Promise<ValidationRequeueStatus> {
    return parseValidationRequeueStatus(await request<unknown>(path(accountId, credentialId)));
  },
  async requeue(accountId: string, credentialId: string, input: ValidationRequeueInput, idempotencyKey: string): Promise<ValidationRequeueReceipt> {
    const result = parseValidationRequeueReceipt(await request<unknown>(path(accountId, credentialId), {
      method: 'POST', body: input, idempotencyKey,
    }));
    if (result.jobId !== input.jobId || result.credentialVersion !== input.expectedCredentialVersion || result.leaseGeneration !== input.expectedLeaseGeneration + 1) invalid();
    return result;
  },
};
