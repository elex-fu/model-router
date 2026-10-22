import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { createSaasDeployPool, type ValidatedUrl, validateDatabaseUrl } from '../../cli/saas-deploy-shared.js';
import { SAAS_MIGRATIONS } from '../db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor } from '../db/types.js';
import {
  type BackupFingerprint,
  backupPolicySchema,
  backupReceiptSchema,
  backupStatusSchema,
  fingerprintSchema,
  type KmsRecoveryEvidence,
  kmsRecoveryEvidenceSchema,
  type PitrEvidence,
  pitrEvidenceSchema,
  restoreReceiptSchema,
  type SaasBackupPolicy,
  type SaasBackupReceipt,
  type SaasBackupStatus,
  type SaasRestoreReceipt,
} from './types.js';

const exec = promisify(execFile);
export const SAAS_BACKUP_POLICY_FILE_ENV = 'MODEL_ROUTER_SAAS_BACKUP_POLICY_FILE';
export const SAAS_BACKUP_STATUS_FILE_ENV = 'MODEL_ROUTER_SAAS_BACKUP_STATUS_FILE';
const SCHEMA = 'model_router_saas';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class SaasBackupFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type BackupCommandExecutor = (
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string>;
export interface SaasBackupDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly execute?: BackupCommandExecutor;
  readonly createPool?: typeof createSaasDeployPool;
}
export interface SaasBackupOperationOptions {
  readonly policyFile?: string;
  readonly allowLocalPlaintext?: boolean;
  readonly ifDue?: boolean;
}

export function backupPolicyHash(policy: SaasBackupPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}
function sourceIdentity(admin: ValidatedUrl): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        admin.url.hostname.toLowerCase(),
        admin.url.port || '5432',
        decodeURIComponent(admin.url.pathname.slice(1)),
      ]),
    )
    .digest('hex');
}
function fail(code: string, message: string): never {
  throw new SaasBackupFailure(code, message);
}

export async function loadSaasBackupPolicy(file: string): Promise<SaasBackupPolicy> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('invalid');
    return backupPolicySchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return fail(
      'INVALID_BACKUP_POLICY',
      'Backup policy is unreadable or invalid; inspect the versioned policy example',
    );
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    fail('UNSAFE_BACKUP_DIRECTORY', 'Backup state directory must be owned by this operator and have mode 0700');
  }
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function digestFile(path: string): Promise<{ bytes: number; sha256: string; base64: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0) fail('ARCHIVE_INVALID', 'Backup archive is missing or empty');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const digest = hash.digest();
  return { bytes: info.size, sha256: digest.toString('hex'), base64: digest.toString('base64') };
}

/** No shell and no child stdout/stderr ever enters an error or operator log. */
export const executeBackupCommand: BackupCommandExecutor = async (argv, options) => {
  try {
    const result = await exec(argv[0], [...argv.slice(1)], {
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return result.stdout;
  } catch {
    return fail(
      'BACKUP_TOOL_FAILED',
      'A backup tool failed; its output is withheld because it may contain credentials',
    );
  }
};

function selectedEnvironment(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME };
  for (const name of names) if (env[name] !== undefined) selected[name] = env[name];
  return selected;
}
function pgEnvironment(admin: ValidatedUrl, env: NodeJS.ProcessEnv, database?: string): NodeJS.ProcessEnv {
  return {
    ...selectedEnvironment(env, ['PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY']),
    PGHOST: admin.url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: admin.url.port || '5432',
    PGUSER: admin.username,
    PGPASSWORD: admin.password,
    PGDATABASE: database ?? decodeURIComponent(admin.url.pathname.slice(1)),
    PGSSLMODE: admin.url.searchParams.get('sslmode') === 'disable' ? 'disable' : 'verify-full',
    PGCONNECT_TIMEOUT: '10',
    PGPASSFILE: '/dev/null',
  };
}
function fresh(date: string, now: number, maxAgeMs = 300_000): boolean {
  const elapsed = now - Date.parse(date);
  return Number.isFinite(elapsed) && elapsed >= -30_000 && elapsed <= maxAgeMs;
}
function parsedOutput<T>(output: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(output));
  } catch {
    return fail('BACKUP_EVIDENCE_INVALID', 'Backup adapter returned invalid evidence');
  }
}

interface Context {
  policy: SaasBackupPolicy;
  policyFile: string;
  env: NodeJS.ProcessEnv;
  admin: ValidatedUrl;
  now: () => number;
  execute: BackupCommandExecutor;
  pool: SaasDatabasePool;
  deadline: number;
}
async function tool(context: Context, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const remaining = context.deadline - context.now();
  if (remaining <= 0) fail('BACKUP_TIMEOUT', 'Backup operation exceeded the configured time limit');
  return context.execute(argv, { env, timeoutMs: remaining });
}
async function adapter(
  context: Context,
  configuration: { argv: readonly string[]; envNames: readonly string[] },
  request: unknown,
): Promise<string> {
  return tool(context, configuration.argv, {
    ...selectedEnvironment(context.env, configuration.envNames),
    MODEL_ROUTER_SAAS_BACKUP_REQUEST: JSON.stringify(request),
  });
}
async function kmsRecovery(context: Context): Promise<KmsRecoveryEvidence> {
  const challenge = randomUUID();
  const evidence = parsedOutput(
    await adapter(context, context.policy.kms.recoveryCheck, {
      format: 'saas-backup-kms-request-v1',
      challenge,
      sourceId: context.policy.sourceId,
      requiredKeyIds: context.policy.kms.requiredKeyIds,
      recoveryMaterialReference: context.policy.kms.recoveryMaterialReference,
    }),
    kmsRecoveryEvidenceSchema,
  );
  if (
    evidence.challenge !== challenge ||
    !fresh(evidence.verifiedAt, context.now()) ||
    context.policy.kms.requiredKeyIds.some((key) => !evidence.recoveredKeyIds.includes(key))
  ) {
    fail(
      'KMS_RECOVERY_UNVERIFIED',
      'Recovery identity must decrypt a retained canary for every required current and retired KMS key',
    );
  }
  return evidence;
}

export function verifyPitrEvidence(
  policy: SaasBackupPolicy,
  evidence: PitrEvidence,
  challenge: string,
  now: number,
): void {
  if (
    evidence.sourceId !== policy.sourceId ||
    evidence.challenge !== challenge ||
    !fresh(evidence.observedAt, now) ||
    Date.parse(evidence.latestRecoverableAt) > now + 30_000 ||
    now - Date.parse(evidence.latestRecoverableAt) > policy.rpoSeconds * 1000 ||
    Date.parse(evidence.earliestRecoverableAt) > Date.parse(evidence.latestRecoverableAt) ||
    evidence.retentionDays < policy.retentionDays ||
    policy.kms.requiredKeyIds.some((key) => !evidence.encryptionKeyIds.includes(key))
  ) {
    fail(
      'PITR_COVERAGE_UNVERIFIED',
      'External PITR coverage is stale, mismatched, or below the configured RPO/retention/KMS policy',
    );
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Snapshot-consistent, order-independent row fingerprints; no customer row values leave PostgreSQL. */
export async function captureBackupFingerprint(executor: SqlExecutor): Promise<BackupFingerprint> {
  const tables = (
    await executor.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'model_router_saas' AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
  ).rows;
  if (!tables.some((table) => table.table_name === 'saas_schema_migrations')) {
    fail('SAAS_SCHEMA_MISSING', 'The source is not a provisioned managed SaaS PostgreSQL database');
  }
  const counts: BackupFingerprint['tables'] = [];
  for (const { table_name: name } of tables) {
    const values = (
      await executor.query<{ rows: string; digest_a: string; digest_b: string }>(
        `SELECT count(*)::text AS rows,
         coalesce(sum(('x' || substr(row_hash, 1, 16))::bit(64)::bigint::numeric), 0)::text AS digest_a,
         coalesce(sum(('x' || substr(row_hash, 17, 16))::bit(64)::bigint::numeric), 0)::text AS digest_b
       FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${quoteIdentifier(SCHEMA)}.${quoteIdentifier(name)} t) hashes`,
      )
    ).rows[0];
    if (!values || !/^\d+$/.test(values.rows)) fail('FINGERPRINT_FAILED', 'Could not fingerprint a SaaS table');
    counts.push({ name, rows: values.rows, digestA: values.digest_a, digestB: values.digest_b });
  }
  const ledger = (
    await executor.query<{ version: number; name: string; checksum: string }>(
      `SELECT version, name, checksum FROM ${quoteIdentifier(SCHEMA)}.saas_schema_migrations ORDER BY version ASC`,
    )
  ).rows;
  const known = [...SAAS_MIGRATIONS].sort((a, b) => a.version - b.version);
  if (
    !ledger.length ||
    ledger.some((row, index) => {
      const migration = known[index];
      return (
        !migration ||
        Number(row.version) !== migration.version ||
        row.name !== migration.name ||
        row.checksum !== createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex')
      );
    })
  )
    fail('MIGRATION_LEDGER_INVALID', 'The backup migration ledger is not a clean prefix of this release registry');
  const data = {
    tables: counts,
    ledgerHash: createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),
    ledgerCount: ledger.length,
    registryHead: Number(ledger.at(-1)?.version ?? 0),
  };
  return { ...data, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

async function withContext<T>(
  options: SaasBackupOperationOptions & { readonly operationKind?: 'backup' | 'restore' },
  dependencies: SaasBackupDependencies,
  operation: (context: Context, client: SaasDatabaseClient) => Promise<T>,
): Promise<T> {
  const env = dependencies.env ?? process.env;
  const policyFile = options.policyFile ?? env[SAAS_BACKUP_POLICY_FILE_ENV];
  if (!policyFile)
    fail(
      'BACKUP_POLICY_REQUIRED',
      `${SAAS_BACKUP_POLICY_FILE_ENV} or --policy is required; local V2 SQLite backups do not protect SaaS PostgreSQL`,
    );
  const policy = await loadSaasBackupPolicy(policyFile);
  const admin = validateDatabaseUrl(env[policy.databaseUrlEnv], {
    name: policy.databaseUrlEnv,
    allowLocalPlaintext: options.allowLocalPlaintext === true,
  });
  const databaseName = decodeURIComponent(admin.url.pathname.slice(1));
  if (
    Buffer.byteLength(databaseName) > 63 ||
    databaseName.includes('=') ||
    /^(postgres|postgresql):/i.test(databaseName) ||
    /[\0\r\n]/.test(databaseName)
  ) {
    fail('UNSAFE_DATABASE_NAME', 'Backup database name must not be interpreted as a libpq connection string');
  }
  await privateDirectory(policy.stateDirectory);
  const now = dependencies.now ?? Date.now;
  const pool = (dependencies.createPool ?? createSaasDeployPool)(admin.url.toString(), {
    allowLocalPlaintext: options.allowLocalPlaintext === true,
    applicationName: 'model-router-saas-backup',
  });
  const context: Context = {
    policy,
    policyFile,
    admin,
    env,
    now,
    pool,
    execute: dependencies.execute ?? executeBackupCommand,
    deadline: now() + policy.maximumDurationSeconds * 1000,
  };
  let client: SaasDatabaseClient | undefined;
  try {
    client = await pool.connect();
    const lock = (
      await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('model_router_saas_backup'), hashtext($1)) AS locked",
        [sourceIdentity(admin)],
      )
    ).rows[0]?.locked;
    if (!lock) fail('BACKUP_IN_PROGRESS', 'Another backup or restore verification owns this database operation lock');
    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      String(policy.maximumDurationSeconds * 1000),
    ]);
    return await operation(context, client);
  } catch (error) {
    // Includes connection/lock failures before the operation callback starts.
    // Configuration failures before a safe directory exists remain in the
    // command's nonzero result and scheduler journal.
    try {
      await durableJson(
        join(
          policy.stateDirectory,
          options.operationKind === 'restore' ? 'latest-restore-attempt.json' : 'latest-attempt.json',
        ),
        {
          completedAt: new Date(now()).toISOString(),
          status: 'failed',
          code: error instanceof SaasBackupFailure ? error.code : 'BACKUP_OPERATION_FAILED',
        },
      );
      if (options.operationKind !== 'restore') await publishBackupStatus(context);
    } catch {
      /* Preserve the primary failure if evidence storage is unavailable. */
    }
    throw error;
  } finally {
    try {
      if (client) {
        try {
          await client.query('ROLLBACK');
          await client.query('SELECT pg_advisory_unlock_all()');
        } finally {
          client.release(true);
        }
      }
    } finally {
      await pool.end();
    }
  }
}

async function s3(context: Context, args: readonly string[]): Promise<string> {
  if (context.policy.mode !== 'pg-dump') fail('INVALID_BACKUP_POLICY', 'S3 is only used for a pg-dump policy');
  const store = context.policy.offsite;
  const endpoint =
    store.endpoint ??
    `https://s3.${store.region}.${store.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
  const extra = ['--endpoint-url', endpoint];
  return tool(context, [store.awsExecutable, '--no-cli-pager', '--region', store.region, ...extra, 's3api', ...args], {
    ...selectedEnvironment(context.env, store.credentialEnvNames),
    AWS_CLI_AUTO_PROMPT: 'off',
  });
}
function jsonRecord(output: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    return fail('OFFSITE_EVIDENCE_INVALID', 'Object storage returned invalid verification data');
  }
}

async function uploadVerifiedObject(
  context: Context,
  path: string,
  key: string,
  retainUntil: string,
): Promise<{ versionId: string; sha256: string; bytes: number }> {
  if (context.policy.mode !== 'pg-dump') fail('INVALID_BACKUP_POLICY', 'S3 policy required');
  const { offsite } = context.policy;
  const digest = await digestFile(path);
  if (digest.bytes > 5 * 1024 ** 3) {
    fail(
      'ARCHIVE_TOO_LARGE',
      'Logical archive exceeds the S3 single-object upload limit; configure externally managed PITR for this database',
    );
  }
  const uploaded = jsonRecord(
    await s3(context, [
      'put-object',
      '--bucket',
      offsite.bucket,
      '--key',
      key,
      '--body',
      path,
      '--server-side-encryption',
      'aws:kms',
      '--ssekms-key-id',
      offsite.kmsKeyId,
      '--checksum-algorithm',
      'SHA256',
      '--checksum-sha256',
      digest.base64,
      '--object-lock-mode',
      'COMPLIANCE',
      '--object-lock-retain-until-date',
      retainUntil,
      '--output',
      'json',
    ]),
  );
  const versionId = uploaded.VersionId;
  if (typeof versionId !== 'string' || !versionId || versionId === 'null') {
    fail('OFFSITE_VERSIONING_REQUIRED', 'Offsite backup requires S3 versioning and Object Lock');
  }
  const identity = ['--bucket', offsite.bucket, '--key', key, '--version-id', versionId];
  const head = jsonRecord(
    await s3(context, ['head-object', ...identity, '--checksum-mode', 'ENABLED', '--output', 'json']),
  );
  const retention = jsonRecord(await s3(context, ['get-object-retention', ...identity, '--output', 'json']));
  const locked = retention.Retention as Record<string, unknown> | undefined;
  if (
    head.ContentLength !== digest.bytes ||
    head.ChecksumSHA256 !== digest.base64 ||
    head.ServerSideEncryption !== 'aws:kms' ||
    head.SSEKMSKeyId !== offsite.kmsKeyId ||
    locked?.Mode !== 'COMPLIANCE' ||
    typeof locked.RetainUntilDate !== 'string' ||
    !Number.isFinite(Date.parse(locked.RetainUntilDate)) ||
    Date.parse(locked.RetainUntilDate) < Date.parse(retainUntil)
  ) {
    fail('OFFSITE_VERIFICATION_FAILED', 'Offsite checksum, encryption, or immutable retention read-back failed');
  }
  return { versionId, sha256: digest.sha256, bytes: digest.bytes };
}

async function readReceipts<T>(directory: string, suffix: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const receipts: T[] = [];
  for (const name of names.filter((entry) => entry.endsWith(suffix) && UUID.test(entry.slice(0, -suffix.length)))) {
    try {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('invalid');
      receipts.push(schema.parse(JSON.parse(await readFile(path, 'utf8'))));
    } catch {
      fail(
        'BACKUP_RECEIPTS_CORRUPT',
        'A durable backup receipt is invalid; reconcile the evidence directory before proceeding',
      );
    }
  }
  return receipts;
}

async function pruneLocalArchives(context: Context): Promise<void> {
  const cutoff = context.now() - context.policy.localRetentionDays * 86_400_000;
  const receipts = await readReceipts(context.policy.stateDirectory, '.backup.json', backupReceiptSchema);
  for (const receipt of receipts) {
    if (
      !receipt.archive ||
      receipt.policySha256 !== backupPolicyHash(context.policy) ||
      receipt.sourceIdentitySha256 !== sourceIdentity(context.admin) ||
      receipt.archive.fileName !== `${receipt.id}.dump`
    )
      continue;
    const path = join(context.policy.stateDirectory, receipt.archive.fileName);
    try {
      const info = await lstat(path);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function runSaasBackup(
  options: SaasBackupOperationOptions = {},
  dependencies: SaasBackupDependencies = {},
): Promise<{ status: 'protected' | 'not-due'; receipt: SaasBackupReceipt }> {
  return withContext(options, dependencies, async (context, client) => {
    const { policy, now } = context;
    if (options.ifDue) {
      const previous = (await readReceipts(policy.stateDirectory, '.backup.json', backupReceiptSchema))
        .filter(
          (entry) =>
            entry.policySha256 === backupPolicyHash(policy) &&
            entry.sourceIdentitySha256 === sourceIdentity(context.admin),
        )
        .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
      if (previous && fresh(previous.startedAt, now(), policy.scheduleIntervalSeconds * 1000)) {
        await publishBackupStatus(context);
        return { status: 'not-due', receipt: previous };
      }
    }
    const id = randomUUID();
    const startedAt = new Date(now()).toISOString();
    try {
      const kms = await kmsRecovery(context);
      let archive: SaasBackupReceipt['archive'] = null;
      let pitr: PitrEvidence | null = null;
      let recoveryPointAt = startedAt;
      if (policy.mode === 'external-pitr') {
        const challenge = randomUUID();
        const evidenceFile = join(policy.stateDirectory, `${id}.pitr-provider.json`);
        pitr = parsedOutput(
          await adapter(context, policy.external.verify, {
            format: 'saas-pitr-request-v1',
            sourceId: policy.sourceId,
            challenge,
            rpoSeconds: policy.rpoSeconds,
            retentionDays: policy.retentionDays,
            evidenceFile,
          }),
          pitrEvidenceSchema,
        );
        verifyPitrEvidence(policy, pitr, challenge, now());
        const providerEvidence = await digestFile(evidenceFile);
        await chmod(evidenceFile, 0o600);
        if (providerEvidence.sha256 !== pitr.evidenceSha256) {
          fail(
            'PITR_PROVIDER_EVIDENCE_MISMATCH',
            'The provider read-back evidence file does not match the PITR receipt',
          );
        }
        recoveryPointAt = pitr.latestRecoverableAt;
      } else {
        recoveryPointAt = new Date(now()).toISOString();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(
          "SET LOCAL timezone = 'UTC'; SET LOCAL bytea_output = 'hex'; SET LOCAL extra_float_digits = 3",
        );
        const snapshot = (await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]
          ?.snapshot;
        if (!snapshot || !/^[0-9A-Fa-f-]+$/.test(snapshot))
          fail('SNAPSHOT_FAILED', 'PostgreSQL snapshot export failed');
        const fingerprint = await captureBackupFingerprint(client);
        const fileName = `${id}.dump`;
        const path = join(policy.stateDirectory, fileName);
        const empty = await open(path, 'wx', 0o600);
        await empty.close();
        await tool(
          context,
          [
            'pg_dump',
            '--no-password',
            '--format=custom',
            `--schema=${SCHEMA}`,
            `--snapshot=${snapshot}`,
            `--file=${path}`,
            `--dbname=${decodeURIComponent(context.admin.url.pathname.slice(1))}`,
          ],
          pgEnvironment(context.admin, context.env),
        );
        await chmod(path, 0o600);
        await tool(context, ['pg_restore', '--list', path], selectedEnvironment(context.env, []));
        await client.query('COMMIT');
        const retainUntil = new Date(now() + policy.retentionDays * 86_400_000).toISOString();
        const objectKey = `${policy.offsite.prefix.replace(/\/$/, '')}/${policy.sourceId}/${id}.dump`;
        const uploaded = await uploadVerifiedObject(context, path, objectKey, retainUntil);
        archive = {
          fileName,
          ...uploaded,
          objectKey,
          retainUntil,
          encryptionKeyId: policy.offsite.kmsKeyId,
          fingerprint,
        };
      }
      const receipt: SaasBackupReceipt = {
        format: 'saas-backup-receipt-v1',
        id,
        sourceId: policy.sourceId,
        sourceIdentitySha256: sourceIdentity(context.admin),
        policySha256: backupPolicyHash(policy),
        mode: policy.mode,
        startedAt,
        completedAt: new Date(now()).toISOString(),
        recoveryPointAt,
        kms,
        archive,
        pitr,
      };
      // Successful local evidence is committed only after both remote archive
      // and receipt are independently checksum/encryption/retention verified.
      if (archive && policy.mode === 'pg-dump') {
        const staging = join(policy.stateDirectory, `${id}.pending.json`);
        await durableJson(staging, receipt);
        await uploadVerifiedObject(
          context,
          staging,
          `${policy.offsite.prefix.replace(/\/$/, '')}/${policy.sourceId}/${id}.receipt.json`,
          archive.retainUntil,
        );
        await unlink(staging);
      }
      await durableJson(join(policy.stateDirectory, `${id}.backup.json`), receipt);
      await durableJson(join(policy.stateDirectory, 'latest-attempt.json'), {
        completedAt: receipt.completedAt,
        status: 'protected',
        code: null,
      });
      // Retention cleanup cannot invalidate a fully verified remote backup.
      // A cleanup error is explicit in the attempt record for operators.
      try {
        await pruneLocalArchives(context);
      } catch {
        await durableJson(join(policy.stateDirectory, 'latest-attempt.json'), {
          completedAt: receipt.completedAt,
          status: 'protected',
          code: 'LOCAL_RETENTION_CLEANUP_FAILED',
        });
      }
      await publishBackupStatus(context);
      return { status: 'protected', receipt };
    } catch (error) {
      await durableJson(join(policy.stateDirectory, 'latest-attempt.json'), {
        completedAt: new Date(now()).toISOString(),
        status: 'failed',
        code: error instanceof SaasBackupFailure ? error.code : 'BACKUP_FAILED',
      });
      try {
        await publishBackupStatus(context);
      } catch {
        /* Preserve the primary failure. */
      }
      throw error;
    }
  });
}

export async function verifySaasBackupRestore(
  options: SaasBackupOperationOptions & { readonly backupId: string },
  dependencies: SaasBackupDependencies = {},
): Promise<SaasRestoreReceipt> {
  if (!UUID.test(options.backupId)) fail('INVALID_BACKUP_ID', 'Backup id must be a UUID');
  return withContext({ ...options, operationKind: 'restore' }, dependencies, async (context, sourceClient) => {
    const { policy, now } = context;
    const backup = (await readReceipts(policy.stateDirectory, '.backup.json', backupReceiptSchema)).find(
      (entry) => entry.id === options.backupId,
    );
    if (
      !backup ||
      backup.sourceIdentitySha256 !== sourceIdentity(context.admin) ||
      backup.policySha256 !== backupPolicyHash(policy)
    ) {
      fail('BACKUP_RECEIPT_MISMATCH', 'Backup receipt is missing or belongs to a different source or policy');
    }
    const started = now();
    const id = randomUUID();
    let target = `model_router_test_backup_${id.replaceAll('-', '')}`;
    let targetPool: SaasDatabasePool | undefined;
    let created = false;
    let fingerprint: BackupFingerprint;
    let cleanup: SaasRestoreReceipt['cleanup'] = 'dropped-owned-database';
    let recoveryPointAt = backup.recoveryPointAt;
    let externalRestoreDurationMs = 0;
    try {
      if (policy.mode === 'pg-dump') {
        if (!backup.archive) fail('ARCHIVE_INVALID', 'Backup receipt does not contain a logical archive');
        const archive = backup.archive;
        // Download the immutable recorded version even when a local archive
        // exists. A restore drill must prove the offsite copy is usable.
        const path = join(policy.stateDirectory, `${id}.restore.dump`);
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
        try {
          await s3(context, [
            'get-object',
            '--bucket',
            policy.offsite.bucket,
            '--key',
            archive.objectKey,
            '--version-id',
            archive.versionId,
            path,
            '--output',
            'json',
          ]);
          await chmod(path, 0o600);
          const digest = await digestFile(path);
          if (digest.sha256 !== archive.sha256 || digest.bytes !== archive.bytes)
            fail('ARCHIVE_CHECKSUM_MISMATCH', 'Downloaded offsite archive does not match its receipt');
          await tool(context, ['pg_restore', '--list', path], selectedEnvironment(context.env, []));
          // No DROP IF EXISTS or pg_terminate_backend: only this invocation's
          // successfully created UUID target may ever be removed.
          await sourceClient.query(`CREATE DATABASE ${quoteIdentifier(target)} TEMPLATE template0`);
          created = true;
          await tool(
            context,
            [
              'pg_restore',
              '--no-password',
              '--exit-on-error',
              '--single-transaction',
              '--no-owner',
              '--no-privileges',
              `--dbname=${target}`,
              path,
            ],
            pgEnvironment(context.admin, context.env, target),
          );
        } finally {
          await unlink(path);
        }
        const url = new URL(context.admin.url);
        url.pathname = `/${target}`;
        targetPool = (dependencies.createPool ?? createSaasDeployPool)(url.toString(), {
          allowLocalPlaintext: options.allowLocalPlaintext === true,
          applicationName: 'model-router-saas-restore-verification',
        });
        fingerprint = await readOnlyFingerprint(targetPool, context.deadline - now());
        if (fingerprint.sha256 !== archive.fingerprint.sha256)
          fail(
            'RESTORE_FINGERPRINT_MISMATCH',
            'Restored database data or migration ledger differs from the backup snapshot',
          );
      } else {
        const challenge = randomUUID();
        const output = jsonRecord(
          await adapter(context, policy.external.verifyRestore, {
            format: 'saas-pitr-restore-request-v1',
            sourceId: policy.sourceId,
            challenge,
            backupId: backup.id,
            earliestRecoverableAt: backup.pitr?.earliestRecoverableAt,
            latestRecoverableAt: backup.pitr?.latestRecoverableAt,
          }),
        );
        if (
          output.format !== 'saas-pitr-restore-evidence-v1' ||
          output.challenge !== challenge ||
          output.sourceId !== policy.sourceId ||
          typeof output.verifiedAt !== 'string' ||
          !fresh(output.verifiedAt, now()) ||
          typeof output.targetDatabaseUrlEnv !== 'string' ||
          !/^[A-Z][A-Z0-9_]*$/.test(output.targetDatabaseUrlEnv) ||
          typeof output.recoveryPointAt !== 'string' ||
          !Number.isFinite(Date.parse(output.recoveryPointAt)) ||
          typeof output.restoreDurationMs !== 'number' ||
          !Number.isFinite(output.restoreDurationMs) ||
          output.restoreDurationMs <= 0 ||
          !backup.pitr ||
          Date.parse(output.recoveryPointAt) < Date.parse(backup.pitr.earliestRecoverableAt) ||
          Date.parse(output.recoveryPointAt) > Date.parse(backup.pitr.latestRecoverableAt)
        ) {
          fail(
            'PITR_RESTORE_EVIDENCE_INVALID',
            'External restore adapter must identify a fresh isolated clone and a checkpoint within the verified recovery window',
          );
        }
        const expected = parsedOutput(JSON.stringify(output.expectedFingerprint), fingerprintSchema);
        const url = validateDatabaseUrl(context.env[output.targetDatabaseUrlEnv], {
          name: output.targetDatabaseUrlEnv,
          allowLocalPlaintext: options.allowLocalPlaintext === true,
        });
        target = decodeURIComponent(url.url.pathname.slice(1));
        if (
          !/^model_router_test_backup_[a-z0-9_]+$/.test(target) ||
          target === decodeURIComponent(context.admin.url.pathname.slice(1)) ||
          sourceIdentity(url) === sourceIdentity(context.admin)
        ) {
          fail(
            'RESTORE_TARGET_REFUSED',
            'External verification only reads an explicitly named isolated model_router_test_backup_* clone',
          );
        }
        targetPool = (dependencies.createPool ?? createSaasDeployPool)(url.url.toString(), {
          allowLocalPlaintext: options.allowLocalPlaintext === true,
          applicationName: 'model-router-saas-pitr-restore-verification',
        });
        fingerprint = await readOnlyFingerprint(targetPool, context.deadline - now());
        if (fingerprint.sha256 !== expected.sha256)
          fail(
            'RESTORE_FINGERPRINT_MISMATCH',
            'External restored clone does not match the authoritative checkpoint fingerprint',
          );
        cleanup = 'external-clone-read-only';
        recoveryPointAt = output.recoveryPointAt;
        externalRestoreDurationMs = output.restoreDurationMs;
      }
      const kms = await kmsRecovery(context);
      await targetPool.end();
      targetPool = undefined;
      if (created) {
        await sourceClient.query(`DROP DATABASE ${quoteIdentifier(target)}`);
        created = false;
      }
      const durationMs = now() - started + externalRestoreDurationMs;
      if (durationMs > policy.rtoSeconds * 1000)
        fail(
          'RESTORE_RTO_EXCEEDED',
          'Restore completed but exceeded the configured RTO; no passing restore receipt was written',
        );
      const receipt: SaasRestoreReceipt = {
        format: 'saas-restore-receipt-v1',
        id,
        backupId: backup.id,
        sourceId: policy.sourceId,
        sourceIdentitySha256: sourceIdentity(context.admin),
        policySha256: backupPolicyHash(policy),
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(now()).toISOString(),
        durationMs,
        recoveryPointAt,
        targetDatabase: target,
        archiveSha256: backup.archive?.sha256 ?? null,
        fingerprintSha256: fingerprint.sha256,
        kms,
        cleanup,
        productionAdmissionApproved: false,
      };
      const staging = join(policy.stateDirectory, `${id}.restore-pending.json`);
      await durableJson(staging, receipt);
      if (policy.mode === 'pg-dump') {
        await uploadVerifiedObject(
          context,
          staging,
          `${policy.offsite.prefix.replace(/\/$/, '')}/${policy.sourceId}/${id}.restore.json`,
          new Date(now() + policy.retentionDays * 86_400_000).toISOString(),
        );
      }
      await durableJson(join(policy.stateDirectory, `${id}.restore.json`), receipt);
      await unlink(staging);
      await durableJson(join(policy.stateDirectory, 'latest-restore-attempt.json'), {
        completedAt: receipt.completedAt,
        status: 'verified',
        code: null,
      });
      await publishBackupStatus(context);
      return receipt;
    } finally {
      if (targetPool) await targetPool.end();
      if (created) {
        try {
          await sourceClient.query(`DROP DATABASE ${quoteIdentifier(target)}`);
        } catch {
          fail(
            'RESTORE_CLEANUP_FAILED',
            `Owned disposable restore target ${target} requires operator cleanup; no passing receipt was written`,
          );
        }
      }
    }
  });
}

async function readOnlyFingerprint(pool: SaasDatabasePool, timeoutMs: number): Promise<BackupFingerprint> {
  if (timeoutMs <= 0) fail('BACKUP_TIMEOUT', 'Restore verification exceeded its maximum operation duration');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone = 'UTC'; SET LOCAL bytea_output = 'hex'; SET LOCAL extra_float_digits = 3");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.ceil(timeoutMs))]);
    const fingerprint = await captureBackupFingerprint(client);
    await client.query('ROLLBACK');
    return fingerprint;
  } finally {
    client.release(true);
  }
}

export async function getSaasBackupStatus(
  options: { readonly policyFile?: string } = {},
  dependencies: Pick<SaasBackupDependencies, 'env' | 'now'> = {},
): Promise<SaasBackupStatus> {
  const env = dependencies.env ?? process.env;
  const policyFile = options.policyFile ?? env[SAAS_BACKUP_POLICY_FILE_ENV];
  const now = (dependencies.now ?? Date.now)();
  if (!policyFile && env[SAAS_BACKUP_STATUS_FILE_ENV]) {
    const path = env[SAAS_BACKUP_STATUS_FILE_ENV] as string;
    try {
      if (!isAbsolute(path)) throw new Error('invalid');
      const info = await lstat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid');
      const projection = backupStatusSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      return { ...projection, readiness: statusReadiness(projection, now) };
    } catch {
      return fail('BACKUP_STATUS_UNAVAILABLE', 'Sanitized backup status projection is unavailable or invalid');
    }
  }
  if (!policyFile)
    return {
      format: 'saas-backup-status-v1',
      configured: false,
      policy: null,
      latestBackup: null,
      latestRestore: null,
      latestAttempt: null,
      readiness: { ok: false, reasons: ['BACKUP_POLICY_REQUIRED'] },
    };
  const policy = await loadSaasBackupPolicy(policyFile);
  const hash = backupPolicyHash(policy);
  let expectedIdentity: string | undefined;
  if (env[policy.databaseUrlEnv]) {
    try {
      expectedIdentity = sourceIdentity({
        url: new URL(env[policy.databaseUrlEnv] as string),
        username: '',
        password: '',
      });
    } catch {
      fail('INVALID_DATABASE_URL', 'The protected database URL is invalid');
    }
  }
  const backups = (await readReceipts(policy.stateDirectory, '.backup.json', backupReceiptSchema))
    .filter(
      (entry) =>
        entry.policySha256 === hash &&
        entry.sourceId === policy.sourceId &&
        (expectedIdentity === undefined || entry.sourceIdentitySha256 === expectedIdentity),
    )
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const backup = backups[0];
  const restore = (await readReceipts(policy.stateDirectory, '.restore.json', restoreReceiptSchema))
    .filter(
      (entry) =>
        entry.policySha256 === hash &&
        entry.sourceId === policy.sourceId &&
        backups.some(
          (candidate) =>
            candidate.id === entry.backupId && candidate.sourceIdentitySha256 === entry.sourceIdentitySha256,
        ),
    )
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
  let latestAttempt: SaasBackupStatus['latestAttempt'] = null;
  try {
    const value = JSON.parse(await readFile(join(policy.stateDirectory, 'latest-attempt.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt)) ||
      !['protected', 'failed'].includes(String(value.status)) ||
      (value.code !== null && typeof value.code !== 'string')
    ) {
      throw new Error('invalid');
    }
    latestAttempt = {
      completedAt: value.completedAt,
      status: value.status as 'protected' | 'failed',
      code: value.code as string | null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fail('BACKUP_RECEIPTS_CORRUPT', 'The latest backup attempt record is invalid');
  }
  const status: SaasBackupStatus = {
    format: 'saas-backup-status-v1',
    configured: true,
    policy: {
      mode: policy.mode,
      sourceId: policy.sourceId,
      rpoSeconds: policy.rpoSeconds,
      rtoSeconds: policy.rtoSeconds,
      retentionDays: policy.retentionDays,
      scheduleIntervalSeconds: policy.scheduleIntervalSeconds,
      restoreVerificationMaxAgeHours: policy.restoreVerificationMaxAgeHours,
      requiredKeyIds: policy.kms.requiredKeyIds,
    },
    latestBackup: backup
      ? {
          id: backup.id,
          completedAt: backup.completedAt,
          recoveryPointAt: backup.recoveryPointAt,
          mode: backup.mode,
          offsiteVerified: backup.archive !== null || backup.pitr?.offsiteVerified === true,
          archiveSha256: backup.archive?.sha256 ?? null,
        }
      : null,
    latestRestore: restore
      ? {
          id: restore.id,
          backupId: restore.backupId,
          completedAt: restore.completedAt,
          durationMs: restore.durationMs,
          fingerprintSha256: restore.fingerprintSha256,
          productionAdmissionApproved: false,
        }
      : null,
    latestAttempt,
    readiness: { ok: false, reasons: [] },
  };
  return { ...status, readiness: statusReadiness(status, now) };
}

function statusReadiness(status: SaasBackupStatus, now: number): SaasBackupStatus['readiness'] {
  if (!status.configured || !status.policy) return { ok: false, reasons: ['BACKUP_POLICY_REQUIRED'] };
  const { policy, latestBackup: backup, latestRestore: restore } = status;
  const reasons: string[] = [];
  if (!backup || !fresh(backup.recoveryPointAt, now, policy.rpoSeconds * 1000)) reasons.push('BACKUP_RPO_EXCEEDED');
  if (!backup?.offsiteVerified) reasons.push('OFFSITE_BACKUP_UNVERIFIED');
  if (!restore || !fresh(restore.completedAt, now, policy.restoreVerificationMaxAgeHours * 3_600_000))
    reasons.push('RESTORE_VERIFICATION_REQUIRED');
  if (restore && restore.durationMs > policy.rtoSeconds * 1000) reasons.push('RESTORE_RTO_EXCEEDED');
  if (status.latestAttempt?.status === 'failed') reasons.push('LATEST_BACKUP_ATTEMPT_FAILED');
  return { ok: reasons.length === 0, reasons };
}

async function publishBackupStatus(context: Context): Promise<void> {
  const path = context.env[SAAS_BACKUP_STATUS_FILE_ENV];
  if (!path) return;
  if (!isAbsolute(path) || path.startsWith(`${context.policy.stateDirectory}/`)) {
    fail(
      'INVALID_BACKUP_STATUS_PATH',
      'Status projection must be an absolute path outside the private backup directory',
    );
  }
  try {
    // The operator creates a setgid directory owned by model-router-backup
    // and grouped to model-router. The runtime can read this projection only.
    const parent = await lstat(join(path, '..'));
    if (!parent.isDirectory() || (parent.mode & 0o027) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error('invalid');
    const status = await getSaasBackupStatus(
      { policyFile: context.policyFile },
      { env: context.env, now: context.now },
    );
    await durableJson(path, status);
    await chmod(path, 0o640);
  } catch {
    fail('BACKUP_STATUS_PUBLICATION_FAILED', 'Could not publish the sanitized backup status projection');
  }
}

/** Called by saas:upgrade before any migration. External PITR does not dump. */
export async function protectSaasUpgrade(
  env: NodeJS.ProcessEnv,
  admin: ValidatedUrl,
  allowLocalPlaintext = false,
): Promise<{ status: 'ok'; detail: string }> {
  const file = env[SAAS_BACKUP_POLICY_FILE_ENV];
  if (!file)
    fail(
      'BACKUP_POLICY_REQUIRED',
      `Upgrade requires ${SAAS_BACKUP_POLICY_FILE_ENV}; a registry anchor is not a PostgreSQL recovery point`,
    );
  const policy = await loadSaasBackupPolicy(file);
  const configured = validateDatabaseUrl(env[policy.databaseUrlEnv], {
    name: policy.databaseUrlEnv,
    allowLocalPlaintext,
  });
  if (sourceIdentity(configured) !== sourceIdentity(admin))
    fail('BACKUP_SOURCE_MISMATCH', 'Backup policy must protect the exact database being upgraded');
  // Verify a recent restore before creating new protection so an operator can
  // prepare the first backup and restore drill without circular prerequisites.
  const previous = await getSaasBackupStatus({ policyFile: file }, { env });
  if (!previous.latestRestore || previous.readiness.reasons.includes('RESTORE_VERIFICATION_REQUIRED')) {
    fail(
      'RESTORE_VERIFICATION_REQUIRED',
      'A recent passing saas:backup-verify-restore receipt is required before upgrading',
    );
  }
  const { receipt } = await runSaasBackup({ policyFile: file, allowLocalPlaintext }, { env });
  const current = await getSaasBackupStatus({ policyFile: file }, { env });
  if (!current.readiness.ok) {
    fail(
      'BACKUP_PROTECTION_UNVERIFIED',
      `Post-backup recovery readiness failed: ${current.readiness.reasons.join(', ')}`,
    );
  }
  return {
    status: 'ok',
    detail: `${receipt.mode} protection verified; backup receipt ${receipt.id}; restore receipt ${previous.latestRestore.id}`,
  };
}
