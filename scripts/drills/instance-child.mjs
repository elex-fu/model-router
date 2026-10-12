#!/usr/bin/env node
// OPS-01 I1 dual-instance drill child (Track I): assembles the managed-saas
// startup gate chain for one role (control-plane or gateway) as an isolated,
// SIGKILLable probe process, then optionally holds a real PostgreSQL provider
// account lease so the parent drill can prove failover authority.
//
// Gate order mirrors deploy/systemd/managed-saas/README.md (B2 fail-closed
// assembly): ping -> schema verification -> control-plane unknown-outcome
// readiness -> runtime least-privilege ACL verification -> KMS readiness
// self-probe (software KMS pilot with an ephemeral per-process master key, so
// no KMS secret ever enters the drill environment). The full supervisor
// assembly (listeners/web bootstrap) is intentionally not reproduced here;
// the README records this trade-off. Each passed gate appends one fsync'd
// JSONL marker; a SIGKILL cannot lose committed markers.
//
// The restricted role URL arrives only via env (never argv/process list).
// No output contains URLs, key material or tenant data.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}
const inputsPath = arg('inputs');
const progressPath = arg('progress');
const instanceId = arg('instance-id');
const mode = arg('mode') ?? 'hold';
const databaseUrl = process.env.MODEL_ROUTER_SAAS_DRILL_INSTANCE_URL;
if (
  !inputsPath || !progressPath || !databaseUrl ||
  !instanceId || !/^[a-z0-9-]+$/.test(instanceId) ||
  !['hold', 'once'].includes(mode)
) {
  console.error(
    'usage: instance-child --inputs f --progress f --instance-id id [--mode hold|once] (env: MODEL_ROUTER_SAAS_DRILL_INSTANCE_URL)',
  );
  process.exit(2);
}
const payload = JSON.parse(readFileSync(inputsPath, 'utf8'));
const ROLE = payload !== null && typeof payload === 'object' ? payload.role : undefined;
if (!['gateway', 'control-plane'].includes(ROLE)) {
  console.error('inputs file does not declare a gateway or control-plane drill role');
  process.exit(2);
}
const leaseTtlMs = Number(payload.leaseTtlMs);
if (mode === 'hold' && (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 500 || leaseTtlMs > 60_000)) {
  console.error('hold mode requires a bounded leaseTtlMs between 500 and 60000');
  process.exit(2);
}
const leaseInput = payload.lease;
if (mode === 'hold') {
  const required = ['tenantId', 'projectId', 'requestId', 'attemptId', 'evidenceId', 'accountId', 'upstreamId', 'publicModel'];
  const valid = leaseInput !== null && typeof leaseInput === 'object' &&
    required.every((field) => typeof leaseInput[field] === 'string' && /^[a-zA-Z0-9:_.-]+$/.test(leaseInput[field]));
  if (!valid) {
    console.error('hold mode requires a lease input with safe identifier strings');
    process.exit(2);
  }
}

function marker(kind, extra) {
  // Synchronous append: a SIGKILL after this line cannot lose the marker.
  appendFileSync(progressPath, `${JSON.stringify({ kind, instanceId, role: ROLE, ...extra })}\n`);
}

const { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } = await import('../../src/saas/db/index.js');
const { PostgresProviderAccountLeaseService } = await import('../../src/saas/gateway/provider-account-lease-service.js');
const kmsModule = await import('../../src/saas/runtime/software-provider-credential-kms.js');

const database = createSaasDatabase({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
let stage = 'ping';
let lease = null;
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function gate(name, check) {
  stage = name;
  await check();
  marker('gate', { gate: name, ok: true });
}

async function runGates() {
  await gate('ping', () => database.ping());
  await gate('schema', () => database.verifySchema());
  if (ROLE === 'control-plane') await gate('unknown-outcome', () => database.verifyUnknownOutcomeSchema());
  await gate('acl', () =>
    verifySaasRuntimeDatabasePrivileges(database, ROLE === 'gateway' ? 'gateway' : 'control_plane'));
  await gate('kms', async () => {
    // Ephemeral per-process pilot key ring: the readiness self-probe is real
    // (production NODE_ENV plus the explicit pilot acceptance), but no KMS
    // secret is ever provisioned into the drill environment.
    const env = {
      NODE_ENV: 'production',
      [kmsModule.MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT]: 'true',
      [kmsModule.MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: randomBytes(32).toString('hex'),
    };
    const kms = ROLE === 'gateway'
      ? kmsModule.createGatewayProviderCredentialUnsealingKms({ env })
      : kmsModule.createProviderCredentialSealingKms({ env });
    try {
      await kms.checkReady();
    } finally {
      await kms.close();
    }
  });
  marker('ready');
}

function leaseRequest() {
  const input = leaseInput;
  return {
    tenantId: input.tenantId,
    accountId: input.accountId,
    upstreamId: input.upstreamId,
    attemptId: input.attemptId,
    evidence: {
      evidenceId: input.evidenceId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      attemptOrdinal: 1,
      supplyMode: 'platform',
      accountOwnerKind: 'platform',
      publicModel: input.publicModel,
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      upstreamId: input.upstreamId,
      accountId: input.accountId,
      credentialId: 'drill-fixture-only',
      credentialVersion: '1',
      routeTargetMode: 'platform_pool',
      payloadSha256: 'b'.repeat(64),
      statementSha256: 'c'.repeat(64),
      status: 'registered',
      claimedAt: null,
      claimedAttemptId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

async function holdLease() {
  stage = 'lease';
  const service = new PostgresProviderAccountLeaseService({ database, maxConcurrency: 1, leaseTtlMs });
  let renewals = 0;
  let lastPendingMarker = 0;
  while (!stopping) {
    if (!lease) {
      try {
        lease = await service.acquire(leaseRequest());
      } catch (error) {
        // A typed contention answer is null; any thrown error here is a real
        // authority failure (account revoked, storage fault) and must stop the
        // drill loudly rather than spin.
        marker('failed', { stage, code: error && typeof error === 'object' ? String(error.code ?? 'error') : 'error' });
        throw error;
      }
      if (!lease) {
        if (Date.now() - lastPendingMarker >= 500) {
          lastPendingMarker = Date.now();
          marker('lease-pending');
        }
        await sleep(100);
        continue;
      }
      renewals = 0;
      marker('lease-acquired', { fencingToken: lease.fencingToken });
    }
    await sleep(Math.min(lease.renewIntervalMs, 500));
    if (stopping) break;
    try {
      await lease.renew();
      renewals += 1;
      marker('lease-renewed', { fencingToken: lease.fencingToken, renewals });
    } catch (error) {
      const code = error && typeof error === 'object' ? String(error.code ?? 'error') : 'error';
      if (code === 'STALE_LEASE') {
        marker('lease-lost', { fencingToken: lease.fencingToken });
        lease = null;
        continue;
      }
      marker('failed', { stage, code });
      throw error;
    }
  }
}

async function shutdown() {
  stage = 'shutdown';
  if (lease) {
    try {
      await lease.release();
    } catch {
      // Releasing an already-superseded lease is not a drill failure; the
      // parent asserts terminal lease authority from database facts.
    }
    lease = null;
  }
  await database.close();
  marker('shutdown', { clean: true });
}

try {
  await runGates();
  if (mode === 'hold') await holdLease();
  await shutdown();
} catch {
  // Redacted by contract: the parent observes markers and database facts.
  console.error(`instance drill child failed at stage ${stage}`);
  try {
    await database.close();
  } catch {
    // Nothing further is safe to do; the non-zero exit below stands.
  }
  process.exitCode = 1;
}
