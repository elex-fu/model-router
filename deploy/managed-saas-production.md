# Charging production deployment and recovery admission

The single PostgreSQL Compose stack is pilot only. This procedure supplies an
operator configuration and read-only observations, not a deployed HA service or
C2 receipt. Charging requires independently reviewed synchronous PostgreSQL,
production KMS/IAM, real PSP configuration, offsite recovery, alerts, candidate
revision/build required CI and operations sign-off.

## Configure the writable endpoint

Use the existing database provider HA workflow to provision a primary plus a
synchronous physical standby in an independent failure domain. Apply the reviewed
`managed-saas-production-postgres.conf.example` fragment on the primary and ensure
the standby application_name matches the configured target. `synchronous_commit=on`
waits for standby durable WAL flush; `remote_write`, `local` and `off` are insufficient.
Use verified TLS, role-specific DSNs and the existing role manifests. No application,
role, connection startup option, transaction or pooler may override the synchronous
setting. Inspect role/database defaults and actual sessions after every change.

Keep synchronous target enforcement during standby loss: financial commits wait,
or a configured request/statement timeout leaves an uncertain result for original
request lookup. Cancellation does not establish rollback. Preserve unknown and
reconcile the original request before retry; never switch to asynchronous/local
commit to restore traffic. Monitor synchronous peer availability, WAL flush/replay
lag, slot retention, WAL disk capacity and blocked commits. Page before exhaustion.

Failover uses the provider's reviewed quorum/lease and STONITH fencing mechanism.
Prove the former writer cannot accept writes before promoting a recovered peer or
routing traffic. Do not promote a lagging async replica automatically. Retain the
old writer, independent audit evidence and callback inbox until incident review.

## Install role configuration and observe prerequisites

Use `systemd/managed-saas/README.md` for units and the existing
`scripts/check-managed-saas-deployment.mjs` for installed env/unit isolation. Place
all DSNs only in role secret files; common metadata must carry no PSP credentials.
Replace pilot software seal/decrypt/rewrap modules with reviewed external KMS
modules, install workload identities with least privilege and retain historical
keys. Remove software master key declarations from production role env files.
Production KMS unavailability blocks charging; software KMS is not a substitute.
Run existing KMS recovery-canary and backup/PITR checks in
`managed-saas-backup-runbook.md` using the independent recovery identity.

Run `psql -X --no-password --file deploy/managed-saas-production-preflight.sql`
with the normal secure PG service/pass-file environment for every workload login
against the actual writable endpoint. It prints no DSN, secret or replication peer.
The login needs visibility of replication status (provider-approved monitoring
visibility); lack of visibility fails closed. This SQL is read-only and does not
change server settings. Capture protected provider configuration and placement
read-back separately; a passing SQL result cannot prove failure-domain isolation,
absence of per-transaction overrides, fencing or last-ack recovery.

For PSP, only control-plane receives `MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE` and
`MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY`. The latter points to a private
read-only credential mount; if absent the loader uses systemd `CREDENTIALS_DIRECTORY`.
The descriptor references versioned credential basenames, for example
`alipay-merchant-private-key-v1` and `alipay-public-key-v1`; preserve old versions
for historical orders. Gateway and validation worker receive neither descriptor,
merchant key, credential directory nor payment workload identity.

## Record last acknowledged financial commit recovery

1. Close new admissions, charges and financial workers at a controlled barrier.
   Retain independent, access-controlled acknowledgements identifying committed
   wallet/ledger, hold, dispatch/unknown operations and associated evidence, with
   request IDs and actual commit/WAL boundary from the reviewed provider workflow.
   A timestamp or `pg_current_wal_lsn()` alone is not a transaction commit proof.
2. In an authorized production-like drill, lose the writer failure domain, fence
   its write authority and recover/promote only a peer proven to contain that
   acknowledged boundary. Capture provider operation IDs, cluster/peer immutable
   IDs, synchronous flush evidence, fencing acknowledgement, timeline, replay end
   and recovery duration in private evidence storage. Do not simulate this by
   replaying an application fixture or returning a canned receipt.
3. Query original requests on the recovered database; match the retained independent
   acknowledgement set and final financial/hold/dispatch/unknown invariants.
   Record missing/uncertain items explicitly. PSP settlement cannot reconstruct
   model charges or replace missing financial WAL evidence.
4. Use the existing offsite backup/PITR restore receipt and KMS recovery checks as
   a separate disaster-recovery layer. Follow its production recovery admission
   procedure for revoked permissions, role grants, schema and reconciliation.
5. Record exact revision/build, topology/config hashes, protected raw evidence
   references+SHA-256, last acknowledged boundary and recovered boundary,
   unknown resolutions, fencing, alert delivery and named operator sign-off.
   Missing evidence keeps C2 blocked and charging closed. No local file, SQL result
   or technical restore receipt authorizes automatic reopening.

Financial acknowledged commits require independent synchronous durable recovery.
The initial 15-minute RPO applies only to non-financial/non-charging pilot data;
Redis quota's short count-loss window is separate. RTO and retention targets need
actual measured drills. Reuse the existing backup scheduler/policy and evidence
store; do not introduce a second backup system.
