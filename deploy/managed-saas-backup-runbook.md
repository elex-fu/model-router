# Managed SaaS PostgreSQL backup and recovery

`backup:create` and `backup:restore` protect local V2 SQLite/configuration deployments. They do not protect managed SaaS PostgreSQL. `saas:upgrade` now refuses a registry anchor or a skipped backup as its recovery prerequisite. The operator must configure `MODEL_ROUTER_SAAS_BACKUP_POLICY_FILE`, obtain fresh PostgreSQL protection evidence, and retain a recent passing `saas:backup-verify-restore` receipt.

## Select and approve a production policy

Copy either `deploy/managed-saas-backup-policy.example.json` or `deploy/managed-saas-pitr-policy.example.json` to the operator configuration directory. Set numeric RPO, RTO, retention, schedule interval, maximum operation duration and restore drill age according to the deployment's requirements. Examples are starting values, not a service guarantee. Schedule interval plus maximum duration must fit the RPO; allow another 65 seconds for the supplied timer's cadence and jitter. A failed or stopped scheduler can exceed the RPO; the status endpoint recalculates freshness on every read.

| Mode | Protection and verified evidence | Recovery limits |
| --- | --- | --- |
| `pg-dump` | Consistent exported PostgreSQL snapshot, custom archive, archive list check, full archive SHA-256, table row fingerprints and migration ledger; versioned offsite object read-back verifies checksum, SSE-KMS key and Object Lock COMPLIANCE retention. The backup receipt is separately uploaded and verified. | Restores the snapshot point only. It does not create WAL archives or claim PITR. The supplied S3 upload supports archives through 5 GiB; larger deployments must use externally managed PITR. |
| `external-pitr` | Operator-owned provider adapter queries the actual base backup, archived WAL coverage, recovery window, encryption, offsite repository and configured retention. A fresh challenge, source ID, timestamps and policy thresholds are validated. Raw provider evidence is retained privately and its SHA-256 must match the receipt. | Uses the provider's base backup and WAL restoration workflow. The adapter must fail if it cannot prove coverage; a command exiting zero or a static policy assertion is insufficient. No redundant local dump is taken. |

The source identity hash binds a receipt to the explicit host, port and database. Keep this endpoint stable; changing it requires fresh protection and restore receipts. Policy changes also require new receipts. Use one private evidence directory for each policy/source. PostgreSQL advisory locks prevent competing operators or replicas from taking backups/restoring the same source concurrently. Locks are released on connection loss; no stale filesystem lock needs manual deletion.

## Isolate credentials and retain recovery material

Run the backup process as a separate `model-router-backup` Unix identity. Give it an operator PostgreSQL login that can read the complete `model_router_saas` schema and export snapshots. The built-in isolated restore drill also requires `CREATEDB`; grant that only to the recovery operator, not to any application workload. PostgreSQL tools receive credentials through a minimal child environment, never command arguments. Remote connections use certificate verification. `--allow-local-plaintext` is only for a deliberately configured disposable loopback server or trusted tunnel; it does not waive backup requirements.

Keep the private evidence directory at mode `0700`, owned by the backup operator, on an encrypted volume. Local logical archives are plaintext scratch files at mode `0600`; local disk encryption is an operator prerequisite. `localRetentionDays` removes old UUID archive files after a successful run. Durable receipts are retained for audit. Failed/incomplete files are not successful receipts and may need reviewed cleanup after an interrupted operation.

Recovery material must survive loss of the primary deployment:

1. Retain current **and retired** credential envelope KMS key IDs/versions, encryption contexts, recovery role policies and access procedures. Include the offsite archive encryption key. Deleting an old key can make historical backups unrecoverable.
2. Retain database TLS trust material, restore-compatible PostgreSQL tools, the exact release package/container image, role templates, policy and provider recovery procedure in an independently recoverable location.
3. Store the key recovery inventory separately from database archives and application credentials. `kms.recoveryMaterialReference` identifies the inventory; it must never contain key bytes, tokens or passwords.
4. `kms.recoveryCheck` must use the **recovery identity** to decrypt a retained canary for every `requiredKeyIds` entry and compare known plaintext hashes. Merely describing a key or decrypting a newly created canary does not prove recovery access.

For AWS KMS, `scripts/backup/verify-aws-kms-canaries.mjs` implements the decrypt/hash check. Configure a distinct `MODEL_ROUTER_SAAS_BACKUP_RECOVERY_AWS_PROFILE`, include it in the adapter's allowed `envNames`, and install a private canary inventory:

```json
{
  "format": "saas-aws-kms-canaries-v1",
  "canaries": [
    {
      "keyId": "arn:aws:kms:REGION:ACCOUNT:key/RETAINED-KEY",
      "region": "us-east-1",
      "ciphertextFile": "/etc/model-router-saas/recovery-canaries/retained-key.bin",
      "plaintextSha256": "REPLACE_WITH_SHA256_OF_RANDOM_CANARY_PLAINTEXT",
      "encryptionContext": { "purpose": "model-router-recovery-canary" }
    }
  ]
}
```

Generate random canaries during key enrollment and retain ciphertext plus plaintext digest. Do not retain plaintext in the inventory or terminal logs. Replace every placeholder in the example; the verifier rejects malformed digests and requires canonical KMS key IDs returned by `Decrypt`. Other KMS products need an operator adapter implementing the same recovery check contract.

## Configure offsite S3 retention

Use a versioned bucket in an independent failure domain, with Object Lock enabled. The service writes COMPLIANCE retention for each archive and receipt, reads it back by version ID, and refuses an object whose checksum, SSE-KMS key or retention differs. Use the canonical KMS ARN because aliases can resolve to a different ARN at read-back.

Set a bucket lifecycle rule that expires noncurrent/current backup versions **after** the policy's retention period. Object Lock enforces the minimum retention even if a lifecycle rule is misconfigured. Local cleanup never deletes S3 objects. The service does not create buckets, modify account lifecycle rules, or grant permissions. Provision these explicitly and retain the reviewed lifecycle policy with the recovery inventory.

The operator needs scoped `s3:PutObject`, `s3:GetObjectVersion`, `s3:GetObjectRetention`, `s3:PutObjectRetention`, checksum/head access, and the corresponding KMS encrypt/data-key/decrypt permissions for the backup prefix. Retrieving a checksum for SSE-KMS objects also requires KMS permissions. Restore drills download the recorded immutable object version and verify its full SHA-256 before creating a database.

Use the AWS CLI credential chain/workload identities. Names of any required environment variables must be explicitly listed in `offsite.credentialEnvNames` or the adapter's `envNames`. No cloud secret values belong in a policy file or argv.

References: [S3 PutObject](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html), [HeadObject checksum and KMS permissions](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-object.html), [Object Lock retention read-back](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object-retention.html).

## Install the durable schedule and safe status projection

Install the supplied `deploy/systemd/managed-saas/model-router-saas-backup.service` and `.timer`, and the private operator environment from `backup.env.example`. Review executable paths for the installed package. The service runs once per due policy interval; the timer checks every minute and catches up after host downtime with `Persistent=true`. Collect service failures in the host's existing alerting system. `latest-attempt.json` records a sanitized failure code; a failure never writes a successful backup receipt.

Prepare separate directories before enabling the timer:

```sh
install -d -m 0700 -o model-router-backup -g model-router-backup /var/lib/model-router-saas-backups
install -d -m 2750 -o model-router-backup -g model-router /var/lib/model-router-saas-backup-status
systemctl daemon-reload
systemctl enable --now model-router-saas-backup.timer
systemctl list-timers model-router-saas-backup.timer
```

Set `MODEL_ROUTER_SAAS_BACKUP_STATUS_FILE=/var/lib/model-router-saas-backup-status/status.json` in both the operator environment and the control-plane environment. Only the operator receives the policy file and PostgreSQL administrator URL. The projection is atomic and mode `0640`; the application group can read it but cannot write its setgid parent directory or access private dumps. Mount only this projection directory read-only into a containerized control-plane. `GET /admin/api/v1/ops/backups` requires a platform session and exposes the policy summary, recent backup/restore receipt IDs, last attempt, and freshness verdict. It contains no database URLs, adapter argv, recovery inventory location, ciphertext or secret values.

For Compose/Kubernetes, run one external scheduler/CronJob invoking the same command and persist both directories. Do not run backups inside gateway or control-plane processes. Multiple schedulers remain protected by the PostgreSQL operation lock. Configure the scheduler and its alerting explicitly; installing the application alone does not schedule backups.

## Bootstrap and repeat restore verification

```sh
model-router saas:backup --policy /etc/model-router-saas/backup-policy.json --env-file /etc/model-router-saas/backup.env
model-router saas:backup-verify-restore --policy /etc/model-router-saas/backup-policy.json --env-file /etc/model-router-saas/backup.env --backup-id BACKUP_RECEIPT_UUID
model-router saas:backup-status --policy /etc/model-router-saas/backup-policy.json --env-file /etc/model-router-saas/backup.env
```

Schedule restore verification at least as frequently as `restoreVerificationMaxAgeHours` and after changing keys, backup tooling, provider recovery settings or policy. A restore timer is deliberately not enabled automatically: restoring large databases consumes material operator/database capacity. The backup timer continues to make backups while the UI reports an expired restore drill; `saas:upgrade` refuses to proceed until the receipt is renewed.

For logical archives, the drill downloads the offsite version, checks SHA-256 and archive structure, creates a fresh UUID-named `model_router_test_backup_*` database, restores it transactionally, verifies all managed-schema table fingerprints and the migration ledger, checks KMS canaries again, and removes only that invocation's database. It never drops/reuses an existing database, terminates another session, restores into the source, or changes runtime grants. A failure to remove the owned target is reported without a passing receipt. Source and target row fingerprints use order-independent MD5-derived aggregates plus exact counts and a SHA-256 over all aggregates/ledger; they detect accidental content differences but are not a malicious-collision proof. The archive itself is protected with full SHA-256.

For external PITR, first use the provider's reviewed workflow to restore an isolated clone at a known authoritative checkpoint. Supply its URL only through the environment variable returned by `external.verifyRestore`. This process performs read-only fingerprint queries against that clone and never invokes a destructive provider restore. The clone's database name must start with `model_router_test_backup_`, and it must differ from the protected source. The provider operator owns external clone cleanup.

The restore receipt reports the original source identity, policy hash, backup ID, recovery point, data/ledger fingerprint, recovery-key evidence, total duration and cleanup result. For external restores, total duration includes the provider's actual restore duration. The receipt is written only after all checks and RTO pass. Every technical drill receipt explicitly has `productionAdmissionApproved: false`.

## External adapter contracts

Adapters are trusted, reviewed operator executables invoked as argv arrays without shell interpolation. They receive only explicitly selected environment variables and JSON in `MODEL_ROUTER_SAAS_BACKUP_REQUEST`. They must query the real provider on each invocation, preserve raw evidence, and fail with nonzero status on uncertainty. The application validates the returned envelope; the adapter is responsible for provider-specific evidence interpretation. No canned success adapter is shipped.

KMS request format is `saas-backup-kms-request-v1`, with `challenge`, `sourceId`, `requiredKeyIds` and `recoveryMaterialReference`. Return exactly:

```text
{ format: "saas-backup-kms-recovery-v1", challenge, verifiedAt,
  recoveredKeyIds: [...], evidenceSha256: "64 lowercase hex characters" }
```

PITR request format is `saas-pitr-request-v1`, with `challenge`, `sourceId`, `rpoSeconds`, `retentionDays` and an absolute `evidenceFile`. Write the actual provider read-back to that private file and return exactly:

```text
{ format: "saas-pitr-evidence-v1", sourceId, challenge, observedAt,
  earliestRecoverableAt, latestRecoverableAt, baseBackupReference,
  repositoryReference, walArchiveVerified: true, offsiteVerified: true,
  encrypted: true, encryptionKeyIds: [...], retentionDays, evidenceSha256 }
```

Times are ISO 8601 UTC/offset timestamps. Evidence must be observed within five minutes and echo the per-invocation challenge. The latest recoverable point must meet the RPO, the configured retention must meet policy, and all required retained KMS key IDs must be accounted for. `evidenceSha256` must equal the complete raw evidence file SHA-256. A fresh timestamp alone does not replace actual provider/WAL checks. Source IDs are operator mappings; bind each mapping to the provider's immutable database/cluster ID in reviewed adapter configuration.

External restore request format is `saas-pitr-restore-request-v1`, with `sourceId`, `challenge`, `backupId`, `earliestRecoverableAt` and `latestRecoverableAt`. Return:

```text
{ format: "saas-pitr-restore-evidence-v1", sourceId, challenge, verifiedAt,
  targetDatabaseUrlEnv: "RESTORED_CLONE_DATABASE_URL", recoveryPointAt,
  restoreDurationMs, expectedFingerprint }
```

`expectedFingerprint` is the authoritative source checkpoint captured with `captureBackupFingerprint()` from `src/saas/backup/service.ts` in a repeatable-read transaction. Capture it at a controlled commit barrier before executing the provider drill. It must not be computed from the restored clone itself. Preserve checkpoint/provider restore evidence independently. `recoveryPointAt` must lie within the verified window; `restoreDurationMs` must include base-backup provisioning and WAL replay, not just this command's read queries. Merely reporting a successful restore without a verifiable checkpoint cannot pass the fingerprint comparison.

## Production recovery admission

A technical drill receipt does not reopen production. Follow the existing managed SaaS recovery admission procedure:

1. Pause request admission, new charges and financial workers. Retain the payment/refund callback inbox and independent audit/WAL evidence. Restore into a new environment under an explicit incident owner.
2. Restore a consistent base backup and WAL through the confirmed commit barrier. A logical snapshot alone cannot recover later commits. Reconcile ledger balances, orders, payment/refund events and request usage after the restore point; replay missing financial events idempotently.
3. Prove that Key/Provider permissions revoked after the base backup remain revoked. Recover authoritative revocation events from WAL or independent immutable audit archives before admitting the affected tenant/project/provider pool. If the chain cannot be proved complete, keep those scopes fail-closed while reconciling authoritative audit/provider state.
4. Replay the release-matched role templates and verify runtime privileges, schema compatibility and KMS access. Rebuild derived Redis/cache state without relaxing authentication or overwriting PostgreSQL authority. Start the retained release image and complete doctor/business checks before opening admission.

No command in this delivery performs production rollback, database replacement, arbitrary down-migration, payment-event replay or automatic admission approval.

## Local acceptance scope

Run `SAAS_BACKUP_ACCEPTANCE=1 node --import tsx --test tests/cli/saas-backup.integration.test.ts` with PostgreSQL tools on PATH. It creates and stops its own temporary cluster, provisions the current migration registry and representative data, performs real `pg_dump`/`pg_restore`, rejects a corrupt offsite download before target creation, and proves the source survives and the owned restore target is removed. S3 and KMS are explicit protocol doubles in this acceptance test; it does not claim a live cloud upload, provider PITR restoration or recovery-role IAM validation. Production rollout still requires one real offsite upload/download/restore drill and the deployment-specific KMS/provider checks above.
