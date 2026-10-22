import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BackupCommandExecutor } from '../../../src/saas/backup/service.js';
import type { SaasBackupPolicy } from '../../../src/saas/backup/types.js';

export function policyFixture(directory: string, mode: 'pg-dump' | 'external-pitr' = 'pg-dump'): SaasBackupPolicy {
  const base = {
    format: 'saas-backup-policy-v1' as const,
    sourceId: 'disposable-backup-fixture',
    databaseUrlEnv: 'MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL',
    stateDirectory: directory,
    rpoSeconds: 3600,
    rtoSeconds: 1800,
    scheduleIntervalSeconds: 600,
    maximumDurationSeconds: 600,
    retentionDays: 30,
    localRetentionDays: 2,
    restoreVerificationMaxAgeHours: 168,
    kms: {
      requiredKeyIds: ['fixture-recovery-key'],
      recoveryMaterialReference: 'vault:fixture/recovery-material',
      recoveryCheck: { argv: ['/fixture/verify-kms'], envNames: [] },
    },
  };
  return mode === 'pg-dump'
    ? {
        ...base,
        mode,
        offsite: {
          bucket: 'fixture-offsite-bucket',
          prefix: 'fixture-backups',
          region: 'us-east-1',
          kmsKeyId: 'fixture-recovery-key',
          awsExecutable: '/fixture/aws',
          credentialEnvNames: [],
        },
      }
    : {
        ...base,
        mode,
        external: {
          verify: { argv: ['/fixture/verify-pitr'], envNames: [] },
          verifyRestore: { argv: ['/fixture/verify-pitr-restore'], envNames: [] },
        },
      };
}

/** Object-store/KMS protocol double. PostgreSQL commands remain real in the acceptance test. */
export function backupToolFixture(fallback?: BackupCommandExecutor) {
  const objects = new Map<
    string,
    { content: Buffer; checksum: string; retainUntil: string; kmsKeyId: string; versionId: string }
  >();
  const calls: string[][] = [];
  let corruptDownload = false;
  let wrongOffsiteChecksum = false;
  let wrongOffsiteRetention = false;
  let missingRecoveryKey = false;
  let pitrLagSeconds = 0;
  const execute: BackupCommandExecutor = async (argv, options) => {
    calls.push([...argv]);
    const request = JSON.parse(options.env.MODEL_ROUTER_SAAS_BACKUP_REQUEST ?? '{}') as Record<string, unknown>;
    if (argv[0] === '/fixture/verify-kms')
      return JSON.stringify({
        format: 'saas-backup-kms-recovery-v1',
        challenge: request.challenge,
        verifiedAt: new Date().toISOString(),
        recoveredKeyIds: missingRecoveryKey ? [] : ['fixture-recovery-key'],
        evidenceSha256: createHash('sha256').update('fixture-canary-decrypted').digest('hex'),
      });
    if (argv[0] === '/fixture/verify-pitr') {
      const rawProviderEvidence = JSON.stringify({
        provider: 'test-double',
        repository: 'fixture-offsite',
        observedAt: new Date().toISOString(),
      });
      await writeFile(String(request.evidenceFile), rawProviderEvidence, { mode: 0o600 });
      return JSON.stringify({
        format: 'saas-pitr-evidence-v1',
        sourceId: request.sourceId,
        challenge: request.challenge,
        observedAt: new Date().toISOString(),
        earliestRecoverableAt: new Date(Date.now() - 86_400_000).toISOString(),
        latestRecoverableAt: new Date(Date.now() - pitrLagSeconds * 1000).toISOString(),
        baseBackupReference: 'provider:fixture-base-backup',
        repositoryReference: 'provider:fixture-offsite-repository',
        walArchiveVerified: true,
        offsiteVerified: true,
        encrypted: true,
        encryptionKeyIds: ['fixture-recovery-key'],
        retentionDays: 30,
        evidenceSha256: createHash('sha256').update(rawProviderEvidence).digest('hex'),
      });
    }
    if (argv[0] !== '/fixture/aws') {
      if (!fallback) throw new Error('Unexpected command');
      return fallback(argv, options);
    }
    const command = argv[argv.indexOf('s3api') + 1];
    const argument = (flag: string): string => argv[argv.indexOf(flag) + 1];
    const key = argument('--key');
    if (command === 'put-object') {
      const content = await readFile(argument('--body'));
      const checksum = createHash('sha256').update(content).digest('base64');
      if (checksum !== argument('--checksum-sha256')) throw new Error('Bad checksum sent to object store');
      const object = {
        content,
        checksum,
        retainUntil: argument('--object-lock-retain-until-date'),
        kmsKeyId: argument('--ssekms-key-id'),
        versionId: `fixture-version-${objects.size}`,
      };
      objects.set(key, object);
      return JSON.stringify({ VersionId: object.versionId });
    }
    const object = objects.get(key);
    if (!object || object.versionId !== argument('--version-id')) throw new Error('Wrong object version');
    if (command === 'head-object')
      return JSON.stringify({
        ContentLength: object.content.length,
        ChecksumSHA256: wrongOffsiteChecksum ? 'invalid-checksum' : object.checksum,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: object.kmsKeyId,
      });
    if (command === 'get-object-retention')
      return JSON.stringify({
        Retention: { Mode: 'COMPLIANCE', RetainUntilDate: wrongOffsiteRetention ? 'not-a-date' : object.retainUntil },
      });
    if (command === 'get-object') {
      await writeFile(
        argv[argv.indexOf('--version-id') + 2],
        corruptDownload ? Buffer.from('corrupt-download') : object.content,
      );
      return JSON.stringify({ ContentLength: object.content.length });
    }
    throw new Error('Unexpected object-store command');
  };
  return {
    execute,
    calls,
    objects,
    corruptDownload: () => {
      corruptDownload = true;
    },
    wrongOffsiteChecksum: () => {
      wrongOffsiteChecksum = true;
    },
    wrongOffsiteRetention: () => {
      wrongOffsiteRetention = true;
    },
    missingRecoveryKey: () => {
      missingRecoveryKey = true;
    },
    lagPitr: (seconds: number) => {
      pitrLagSeconds = seconds;
    },
  };
}
