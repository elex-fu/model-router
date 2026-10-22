import { isAbsolute } from 'node:path';
import { z } from 'zod';

const reference = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:/@.+-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const argv = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(64)
  .refine(
    (parts) =>
      isAbsolute(parts[0]) &&
      !['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell'].includes(parts[0].split('/').at(-1) ?? ''),
    'adapter executable must be absolute and must not be a shell',
  );
const envNames = z
  .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
  .max(64)
  .default([]);
const adapter = z.object({ argv, envNames }).strict();

const base = {
  format: z.literal('saas-backup-policy-v1'),
  sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  databaseUrlEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default('MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL'),
  stateDirectory: z.string().refine(isAbsolute, 'state directory must be absolute'),
  rpoSeconds: z.number().int().min(60).max(2_592_000),
  rtoSeconds: z.number().int().min(60).max(604_800),
  scheduleIntervalSeconds: z.number().int().min(60).max(604_800),
  maximumDurationSeconds: z.number().int().min(30).max(86_400).default(1800),
  retentionDays: z.number().int().min(1).max(3650),
  localRetentionDays: z.number().int().min(1).max(365).default(7),
  restoreVerificationMaxAgeHours: z.number().int().min(1).max(8760),
  kms: z
    .object({
      requiredKeyIds: z
        .array(reference)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      recoveryMaterialReference: reference,
      recoveryCheck: adapter,
    })
    .strict(),
};

const pgDump = z
  .object({
    ...base,
    mode: z.literal('pg-dump'),
    offsite: z
      .object({
        bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
        prefix: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,199}$/)
          .refine((value) => !value.split('/').includes('..')),
        region: z.string().regex(/^[a-z0-9-]+$/),
        kmsKeyId: reference,
        // S3 Object Lock COMPLIANCE is checked after upload. Retention is enforced
        // by the object store, so scheduler crashes cannot delete the last copy.
        endpoint: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
          })
          .optional(),
        awsExecutable: z.string().refine(isAbsolute).default('/usr/local/bin/aws'),
        credentialEnvNames: envNames,
      })
      .strict(),
  })
  .strict();

const pitr = z
  .object({
    ...base,
    mode: z.literal('external-pitr'),
    external: z
      .object({
        verify: adapter,
        // This adapter reads an independently restored isolated clone. It must
        // return the expected checkpoint fingerprint; this process performs the
        // target database read itself and never executes a provider restore.
        verifyRestore: adapter,
      })
      .strict(),
  })
  .strict();

export const backupPolicySchema = z.discriminatedUnion('mode', [pgDump, pitr]).superRefine((policy, context) => {
  if (policy.scheduleIntervalSeconds + policy.maximumDurationSeconds > policy.rpoSeconds) {
    context.addIssue({ code: 'custom', message: 'RPO must cover the schedule interval plus maximum run duration' });
  }
  if (policy.mode === 'pg-dump' && !policy.kms.requiredKeyIds.includes(policy.offsite.kmsKeyId)) {
    context.addIssue({
      code: 'custom',
      message: 'The offsite archive encryption key must be included in recovery canaries',
    });
  }
});
export type SaasBackupPolicy = z.infer<typeof backupPolicySchema>;

export const fingerprintSchema = z
  .object({
    tables: z.array(
      z
        .object({
          name: z.string(),
          rows: z.string().regex(/^\d+$/),
          digestA: z.string(),
          digestB: z.string(),
        })
        .strict(),
    ),
    ledgerHash: sha256,
    ledgerCount: z.number().int().nonnegative(),
    registryHead: z.number().int().nonnegative(),
    sha256,
  })
  .strict();
export type BackupFingerprint = z.infer<typeof fingerprintSchema>;

export const kmsRecoveryEvidenceSchema = z
  .object({
    format: z.literal('saas-backup-kms-recovery-v1'),
    challenge: z.string().uuid(),
    verifiedAt: timestamp,
    recoveredKeyIds: z.array(reference).min(1),
    evidenceSha256: sha256,
  })
  .strict();
export type KmsRecoveryEvidence = z.infer<typeof kmsRecoveryEvidenceSchema>;

export const pitrEvidenceSchema = z
  .object({
    format: z.literal('saas-pitr-evidence-v1'),
    sourceId: z.string(),
    challenge: z.string().uuid(),
    observedAt: timestamp,
    earliestRecoverableAt: timestamp,
    latestRecoverableAt: timestamp,
    baseBackupReference: reference,
    repositoryReference: reference,
    walArchiveVerified: z.literal(true),
    offsiteVerified: z.literal(true),
    encrypted: z.literal(true),
    encryptionKeyIds: z.array(reference).min(1),
    retentionDays: z.number().int().positive(),
    evidenceSha256: sha256,
  })
  .strict();
export type PitrEvidence = z.infer<typeof pitrEvidenceSchema>;

export const backupReceiptSchema = z
  .object({
    format: z.literal('saas-backup-receipt-v1'),
    id: z.string().uuid(),
    sourceId: z.string(),
    sourceIdentitySha256: sha256,
    policySha256: sha256,
    mode: z.enum(['pg-dump', 'external-pitr']),
    startedAt: timestamp,
    completedAt: timestamp,
    recoveryPointAt: timestamp,
    kms: kmsRecoveryEvidenceSchema,
    archive: z
      .object({
        fileName: z.string().regex(/^[a-f0-9-]+\.dump$/),
        bytes: z.number().int().positive(),
        sha256,
        objectKey: z.string(),
        versionId: z.string().min(1),
        retainUntil: timestamp,
        encryptionKeyId: reference,
        fingerprint: fingerprintSchema,
      })
      .strict()
      .nullable(),
    pitr: pitrEvidenceSchema.nullable(),
  })
  .strict()
  .refine(
    (receipt) =>
      receipt.mode === 'pg-dump'
        ? receipt.archive !== null && receipt.pitr === null
        : receipt.archive === null && receipt.pitr !== null,
    'receipt mechanism must match its evidence',
  );
export type SaasBackupReceipt = z.infer<typeof backupReceiptSchema>;

export const restoreReceiptSchema = z
  .object({
    format: z.literal('saas-restore-receipt-v1'),
    id: z.string().uuid(),
    backupId: z.string().uuid(),
    sourceId: z.string(),
    sourceIdentitySha256: sha256,
    policySha256: sha256,
    startedAt: timestamp,
    completedAt: timestamp,
    recoveryPointAt: timestamp,
    durationMs: z.number().nonnegative(),
    targetDatabase: z.string().regex(/^model_router_test_backup_[a-z0-9_]+$/),
    archiveSha256: sha256.nullable(),
    fingerprintSha256: sha256,
    kms: kmsRecoveryEvidenceSchema,
    cleanup: z.enum(['dropped-owned-database', 'external-clone-read-only']),
    // Technical restore verification cannot authorize production reopening.
    // Financial reconciliation and revocation/WAL barriers remain mandatory.
    productionAdmissionApproved: z.literal(false),
  })
  .strict();
export type SaasRestoreReceipt = z.infer<typeof restoreReceiptSchema>;

export interface SaasBackupStatus {
  readonly format: 'saas-backup-status-v1';
  readonly configured: boolean;
  readonly policy: {
    readonly mode: SaasBackupPolicy['mode'];
    readonly sourceId: string;
    readonly rpoSeconds: number;
    readonly rtoSeconds: number;
    readonly retentionDays: number;
    readonly scheduleIntervalSeconds: number;
    readonly restoreVerificationMaxAgeHours: number;
    readonly requiredKeyIds: readonly string[];
  } | null;
  readonly latestBackup: {
    readonly id: string;
    readonly completedAt: string;
    readonly recoveryPointAt: string;
    readonly mode: SaasBackupPolicy['mode'];
    readonly offsiteVerified: boolean;
    readonly archiveSha256: string | null;
  } | null;
  readonly latestRestore: {
    readonly id: string;
    readonly backupId: string;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly fingerprintSha256: string;
    readonly productionAdmissionApproved: false;
  } | null;
  readonly latestAttempt: {
    readonly completedAt: string;
    readonly status: 'protected' | 'failed';
    readonly code: string | null;
  } | null;
  readonly readiness: { readonly ok: boolean; readonly reasons: readonly string[] };
}

/** Validates the secret-free projection shared with the control-plane user. */
export const backupStatusSchema = z
  .object({
    format: z.literal('saas-backup-status-v1'),
    configured: z.boolean(),
    policy: z
      .object({
        mode: z.enum(['pg-dump', 'external-pitr']),
        sourceId: z.string(),
        rpoSeconds: z.number().positive(),
        rtoSeconds: z.number().positive(),
        retentionDays: z.number().positive(),
        scheduleIntervalSeconds: z.number().positive(),
        restoreVerificationMaxAgeHours: z.number().positive(),
        requiredKeyIds: z.array(reference),
      })
      .strict()
      .nullable(),
    latestBackup: z
      .object({
        id: z.string().uuid(),
        completedAt: timestamp,
        recoveryPointAt: timestamp,
        mode: z.enum(['pg-dump', 'external-pitr']),
        offsiteVerified: z.boolean(),
        archiveSha256: sha256.nullable(),
      })
      .strict()
      .nullable(),
    latestRestore: z
      .object({
        id: z.string().uuid(),
        backupId: z.string().uuid(),
        completedAt: timestamp,
        durationMs: z.number().nonnegative(),
        fingerprintSha256: sha256,
        productionAdmissionApproved: z.literal(false),
      })
      .strict()
      .nullable(),
    latestAttempt: z
      .object({
        completedAt: timestamp,
        status: z.enum(['protected', 'failed']),
        code: z
          .string()
          .regex(/^[A-Z_]+$/)
          .nullable(),
      })
      .strict()
      .nullable(),
    readiness: z.object({ ok: z.boolean(), reasons: z.array(z.string().regex(/^[A-Z_]+$/)) }).strict(),
  })
  .strict();
