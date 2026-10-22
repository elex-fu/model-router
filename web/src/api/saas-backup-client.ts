import { PlatformApiError, type ReadRequestOptions, request } from './saas-platform-client';

export interface SaasBackupStatus {
  format: 'saas-backup-status-v1';
  configured: boolean;
  policy: {
    mode: 'pg-dump' | 'external-pitr'; sourceId: string; rpoSeconds: number; rtoSeconds: number;
    retentionDays: number; scheduleIntervalSeconds: number; restoreVerificationMaxAgeHours: number;
    requiredKeyIds: string[];
  } | null;
  latestBackup: {
    id: string; completedAt: string; recoveryPointAt: string; mode: 'pg-dump' | 'external-pitr';
    offsiteVerified: boolean; archiveSha256: string | null;
  } | null;
  latestRestore: {
    id: string; backupId: string; completedAt: string; durationMs: number; fingerprintSha256: string;
    productionAdmissionApproved: false;
  } | null;
  latestAttempt: { completedAt: string; status: 'protected' | 'failed'; code: string | null } | null;
  readiness: { ok: boolean; reasons: string[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSaasBackupStatus(value: unknown): SaasBackupStatus {
  const invalid = (): never => { throw new PlatformApiError(200, 'INVALID_RESPONSE', '备份状态响应无效'); };
  if (!record(value) || value.format !== 'saas-backup-status-v1' || typeof value.configured !== 'boolean' ||
    !record(value.readiness) || typeof value.readiness.ok !== 'boolean' ||
    !Array.isArray(value.readiness.reasons) || value.readiness.reasons.some((reason) => typeof reason !== 'string')) return invalid();
  if (value.policy !== null) {
    if (!record(value.policy) || !['pg-dump', 'external-pitr'].includes(String(value.policy.mode)) ||
      typeof value.policy.sourceId !== 'string' || !Array.isArray(value.policy.requiredKeyIds) ||
      value.policy.requiredKeyIds.some((key) => typeof key !== 'string')) return invalid();
    const policy = value.policy;
    if (['rpoSeconds', 'rtoSeconds', 'retentionDays', 'scheduleIntervalSeconds', 'restoreVerificationMaxAgeHours'].some(
      (key) => typeof policy[key] !== 'number' || !Number.isFinite(policy[key]),
    )) return invalid();
  }
  for (const key of ['latestBackup', 'latestRestore', 'latestAttempt']) {
    const item = value[key];
    if (item !== null && (!record(item) || typeof item.completedAt !== 'string')) return invalid();
  }
  if (value.latestBackup !== null && (!record(value.latestBackup) || typeof value.latestBackup.id !== 'string' ||
    typeof value.latestBackup.recoveryPointAt !== 'string' || typeof value.latestBackup.offsiteVerified !== 'boolean')) return invalid();
  if (value.latestRestore !== null && (!record(value.latestRestore) || typeof value.latestRestore.id !== 'string' ||
    typeof value.latestRestore.backupId !== 'string' || typeof value.latestRestore.durationMs !== 'number' ||
    typeof value.latestRestore.fingerprintSha256 !== 'string' || value.latestRestore.productionAdmissionApproved !== false)) return invalid();
  return value as unknown as SaasBackupStatus;
}

export const saasBackupClient = {
  status(options: ReadRequestOptions = {}): Promise<SaasBackupStatus> {
    return request<unknown>('/ops/backups', options).then(parseSaasBackupStatus);
  },
};
