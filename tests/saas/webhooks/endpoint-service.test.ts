import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  CUSTOMER_WEBHOOK_MAX_SECRET_OVERLAP_MS,
  type CustomerWebhookActorContext,
  CustomerWebhookEndpointService,
} from '../../../src/saas/webhooks/endpoint-service.js';
import type { WebhookSigningSecretProtector } from '../../../src/saas/webhooks/signing-secret-protector.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR: CustomerWebhookActorContext = {
  tenantId: TENANT_ID,
  actorUserId: USER_ID,
  requestId: 'test-request-1',
};

interface StoredEndpoint {
  tenant_id: string;
  endpoint_id: string;
  current_version: number;
  state: 'active' | 'suspended' | 'revoked';
  target_url: string;
  event_types: string[];
  created_at: Date;
  updated_at: Date;
}

interface StoredSecret {
  tenantId: string;
  endpointId: string;
  version: number;
  state: 'current' | 'overlap' | 'revoked';
  envelope: Uint8Array;
  expiresAt: Date | null;
  createdAt: Date;
}

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class FakeWebhookDatabase implements SaasDatabase {
  readonly audits: Array<{ id: string; tenantId: string; action: string; targetId: string }> = [];
  readonly endpoints: StoredEndpoint[] = [];
  readonly secrets: StoredSecret[] = [];
  readonly endpointVersions: Array<{
    tenantId: string;
    endpointId: string;
    version: number;
    url: string;
    events: string[];
  }> = [];
  readonly statements: Array<{ sql: string; values: readonly unknown[]; transaction: boolean }> = [];
  allowMembership = true;
  policyEnabled = true;
  maxEndpoints = 10;
  now = new Date('2026-09-29T00:00:00.000Z');

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values, false);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values: readonly unknown[] = []) => this.execute<Row>(sql, values, true) });
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<Row>(sql: string, values: readonly unknown[], transaction: boolean): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.statements.push({ sql: statement, values: [...values], transaction });
    if (statement.startsWith('SELECT 1 FROM saas_memberships')) {
      return result((this.allowMembership ? [{}] : []) as Row[]);
    }
    if (statement.startsWith('SELECT enabled, max_active_endpoints FROM saas_customer_webhook_tenant_policies')) {
      return result([{ enabled: this.policyEnabled, max_active_endpoints: this.maxEndpoints }] as Row[]);
    }
    if (statement.startsWith('SELECT count(*) AS endpoint_count FROM saas_customer_webhook_endpoints')) {
      return result([
        {
          endpoint_count: this.endpoints.filter((row) => row.tenant_id === values[0] && row.state !== 'revoked').length,
        },
      ] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_audit_events')) {
      this.audits.push({
        id: String(values[0]),
        tenantId: String(values[1]),
        action: String(values[3]),
        targetId: String(values[4]),
      });
      return result([{}] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_endpoints')) {
      this.endpoints.push({
        tenant_id: String(values[0]),
        endpoint_id: String(values[1]),
        current_version: 1,
        state: 'active',
        target_url: '',
        event_types: [],
        created_at: new Date(this.now),
        updated_at: new Date(this.now),
      });
      return result([{}] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_endpoint_versions')) {
      const create = statement.includes('VALUES ($1, $2, 1, $3, $4::text[], $5, $6)');
      const tenantId = values[0];
      const endpointId = values[1];
      const version = create ? 1 : values[2];
      const url = create ? values[2] : values[3];
      const events = create ? values[3] : values[4];
      this.endpointVersions.push({
        tenantId: String(tenantId),
        endpointId: String(endpointId),
        version: Number(version),
        url: String(url),
        events: [...(events as string[])],
      });
      const endpoint = this.endpoints.find((row) => row.tenant_id === tenantId && row.endpoint_id === endpointId);
      if (endpoint && endpoint.current_version === Number(version)) {
        endpoint.target_url = String(url);
        endpoint.event_types = [...(events as string[])];
      }
      return result([{}] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_signing_secrets')) {
      const create = statement.includes("VALUES ($1, $2, 1, 'current', $3, $4)");
      const tenantId = values[0];
      const endpointId = values[1];
      const version = create ? 1 : values[2];
      const state = 'current';
      const envelope = create ? values[2] : values[3];
      this.secrets.push({
        tenantId: String(tenantId),
        endpointId: String(endpointId),
        version: Number(version),
        state: String(state) as StoredSecret['state'],
        envelope: Buffer.from(envelope as Uint8Array),
        expiresAt: null,
        createdAt: new Date(this.now),
      });
      return result([{}] as Row[]);
    }
    if (statement.startsWith('SELECT e.tenant_id, e.id AS endpoint_id')) {
      const [tenantId, endpointId] = values;
      const endpoint = this.endpoints.find((row) => row.tenant_id === tenantId && row.endpoint_id === endpointId);
      return result((endpoint ? [{ ...endpoint }] : []) as Row[]);
    }
    if (statement.startsWith('SELECT secret_version, state FROM saas_customer_webhook_signing_secrets')) {
      const [tenantId, endpointId, stateOrVersion] = values;
      const candidates = this.secrets.filter((row) => row.tenantId === tenantId && row.endpointId === endpointId);
      if (statement.includes('ORDER BY secret_version DESC')) {
        return result(
          candidates
            .sort((left, right) => right.version - left.version)
            .map((row) => ({ secret_version: row.version, state: row.state })) as Row[],
        );
      }
      const found = statement.includes("state = 'current'")
        ? candidates.filter((row) => row.state === 'current')
        : candidates.filter((row) => row.version === Number(stateOrVersion));
      return result(found.map((row) => ({ secret_version: row.version, state: row.state })) as Row[]);
    }
    if (statement.startsWith('SELECT current_version, state FROM saas_customer_webhook_endpoints')) {
      const [tenantId, endpointId] = values;
      const endpoint = this.endpoints.find((row) => row.tenant_id === tenantId && row.endpoint_id === endpointId);
      return result((endpoint ? [{ current_version: endpoint.current_version, state: endpoint.state }] : []) as Row[]);
    }
    if (statement.startsWith("UPDATE saas_customer_webhook_signing_secrets SET state = 'revoked'")) {
      const [tenantId, endpointId] = values;
      for (const secret of this.secrets) {
        if (
          secret.tenantId === tenantId &&
          secret.endpointId === endpointId &&
          (values.length === 2 ? secret.state === 'overlap' : secret.version === Number(values[2]))
        ) {
          secret.state = 'revoked';
          secret.expiresAt = null;
        }
      }
      return result([{}] as Row[]);
    }
    if (statement.startsWith('UPDATE saas_customer_webhook_endpoints SET state = CASE')) {
      const endpoint = this.endpoints.find((row) => row.tenant_id === values[0] && row.endpoint_id === values[1]);
      if (endpoint && endpoint.state === 'active') endpoint.state = 'suspended';
      return result([{}] as Row[]);
    }
    if (statement.startsWith('UPDATE saas_customer_webhook_endpoints SET state = $3')) {
      const endpoint = this.endpoints.find((row) => row.tenant_id === values[0] && row.endpoint_id === values[1]);
      if (endpoint) endpoint.state = String(values[2]) as StoredEndpoint['state'];
      return result([{}] as Row[]);
    }
    if (statement.startsWith('UPDATE saas_customer_webhook_signing_secrets SET state = CASE')) {
      const [tenantId, endpointId, overlapMs, version] = values;
      const secret = this.secrets.find(
        (row) => row.tenantId === tenantId && row.endpointId === endpointId && row.version === Number(version),
      );
      if (secret?.state === 'current') {
        secret.state = Number(overlapMs) > 0 ? 'overlap' : 'revoked';
        secret.expiresAt = Number(overlapMs) > 0 ? new Date(this.now.getTime() + Number(overlapMs)) : null;
      }
      return result(secret ? ([{}] as Row[]) : []);
    }
    if (statement.startsWith('SELECT secret_version, state, overlap_expires_at, created_at')) {
      const [tenantId, endpointId] = values;
      const rows = this.secrets
        .filter((secret) => secret.tenantId === tenantId && secret.endpointId === endpointId)
        .sort((left, right) => right.version - left.version)
        .map((secret) => ({
          secret_version: secret.version,
          state: secret.state,
          overlap_expires_at: secret.expiresAt,
          created_at: secret.createdAt,
        }));
      return result(rows as Row[]);
    }
    return result([] as Row[]);
  }
}

function makeProtector(calls: Array<{ aad: string; plaintext: string }> = []): WebhookSigningSecretProtector {
  return {
    purpose: 'customer-webhook-signing-secret-v1',
    async protect(plaintext, aad) {
      calls.push({ aad: Buffer.from(aad).toString('utf8'), plaintext: Buffer.from(plaintext).toString('utf8') });
      return createHash('sha256').update(aad).update(plaintext).digest();
    },
    async unprotect() {
      throw new Error('not needed in this test');
    },
  };
}

const INPUT = {
  targetUrl: 'https://customer.example.test/webhooks',
  eventTypes: ['wallet.low_balance', 'usage.completed'] as const,
};

test('create stores only a protected envelope, binds AAD to tenant/endpoint/version, and shows plaintext once', async () => {
  const database = new FakeWebhookDatabase();
  const protectionCalls: Array<{ aad: string; plaintext: string }> = [];
  const service = new CustomerWebhookEndpointService(database, makeProtector(protectionCalls));
  const created = await service.createEndpoint(ACTOR, INPUT);

  assert.match(created.signingSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.signingSecretVersion, 1);
  assert.equal(created.endpoint.targetUrl, 'https://customer.example.test/webhooks');
  assert.equal(protectionCalls.length, 1);
  assert.equal(protectionCalls[0]?.plaintext, created.signingSecret);
  assert.equal(
    protectionCalls[0]?.aad,
    `model-router/customer-webhook-signing-secret/v1\ntenant=${TENANT_ID}\nendpoint=${created.endpoint.endpointId}\nversion=1`,
  );
  assert.equal(database.secrets.length, 1);
  assert.equal(Buffer.from(database.secrets[0]?.envelope ?? []).includes(Buffer.from(created.signingSecret)), false);
  assert.equal(
    database.audits.some((row) => row.action === 'customer_webhook.endpoint_created'),
    true,
  );
  assert.equal(database.audits[0]?.tenantId, TENANT_ID);
  assert.equal(
    database.statements.filter((entry) => entry.sql.startsWith('INSERT INTO saas_audit_events'))[0]?.transaction,
    true,
  );

  const reread = await service.readEndpoint(ACTOR, created.endpoint.endpointId);
  assert.equal('signingSecret' in reread, false);
  const secretMetadata = await service.listSigningSecretMetadata(ACTOR, created.endpoint.endpointId);
  assert.deepEqual(
    secretMetadata.map((item) => ({ version: item.version, state: item.state })),
    [{ version: 1, state: 'current' }],
  );
  assert.equal('envelope' in (secretMetadata[0] ?? {}), false);
  assert.equal('secret' in (secretMetadata[0] ?? {}), false);
});

test('rotation provides a new secret once, keeps only a bounded one-version overlap, and audits the change', async () => {
  const database = new FakeWebhookDatabase();
  const calls: Array<{ aad: string; plaintext: string }> = [];
  const service = new CustomerWebhookEndpointService(database, makeProtector(calls));
  const created = await service.createEndpoint(ACTOR, INPUT);
  const rotated = await service.rotateSigningSecret(ACTOR, created.endpoint.endpointId, 60_000);

  assert.notEqual(rotated.signingSecret, created.signingSecret);
  assert.equal(rotated.signingSecretVersion, 2);
  assert.equal(calls[1]?.plaintext, rotated.signingSecret);
  assert.ok(calls[1]?.aad.endsWith('version=2'));
  assert.equal(database.secrets.find((row) => row.version === 1)?.state, 'overlap');
  assert.equal(database.secrets.find((row) => row.version === 2)?.state, 'current');
  assert.ok(database.secrets.find((row) => row.version === 1)?.expiresAt);
  assert.equal(
    database.audits.some((row) => row.action === 'customer_webhook.signing_secret_rotated'),
    true,
  );
  await assert.rejects(
    service.rotateSigningSecret(ACTOR, created.endpoint.endpointId, CUSTOMER_WEBHOOK_MAX_SECRET_OVERLAP_MS + 1),
    /overlapMs/,
  );
  assert.equal(calls.length, 2);
});

test('revoking the current secret suspends its endpoint and can recover through a newer rotation', async () => {
  const database = new FakeWebhookDatabase();
  const service = new CustomerWebhookEndpointService(database, makeProtector());
  const created = await service.createEndpoint(ACTOR, INPUT);

  await service.revokeSigningSecret(ACTOR, created.endpoint.endpointId, 1);
  assert.equal(database.secrets.find((row) => row.version === 1)?.state, 'revoked');
  assert.equal(database.endpoints[0]?.state, 'suspended');

  const rotated = await service.rotateSigningSecret(ACTOR, created.endpoint.endpointId, 0);
  assert.equal(rotated.signingSecretVersion, 2);
  assert.equal(database.secrets.find((row) => row.version === 2)?.state, 'current');
  assert.equal(database.endpoints[0]?.state, 'suspended');
  const activated = await service.setEndpointState(ACTOR, created.endpoint.endpointId, 'active');
  assert.equal(activated.state, 'active');
});

test('endpoint revocation and its audit are committed through the same transaction and cannot be undone', async () => {
  const database = new FakeWebhookDatabase();
  const service = new CustomerWebhookEndpointService(database, makeProtector());
  const created = await service.createEndpoint(ACTOR, INPUT);

  const revoked = await service.setEndpointState(ACTOR, created.endpoint.endpointId, 'revoked');
  assert.equal(revoked.state, 'revoked');
  const stateUpdate = database.statements.find((entry) =>
    entry.sql.startsWith('UPDATE saas_customer_webhook_endpoints SET state = $3'),
  );
  assert.equal(stateUpdate?.transaction, true);
  const revocationAudit = database.audits.find((entry) => entry.action === 'customer_webhook.endpoint_revoked');
  assert.ok(revocationAudit);
  const auditStatement = database.statements.find(
    (entry) => entry.sql.startsWith('INSERT INTO saas_audit_events') && entry.values[3] === revocationAudit.action,
  );
  assert.equal(auditStatement?.transaction, true);
  await assert.rejects(service.setEndpointState(ACTOR, created.endpoint.endpointId, 'active'), /REVOKED/);
});

test('endpoint reads stay tenant-scoped and membership failure prevents secret generation', async () => {
  const database = new FakeWebhookDatabase();
  const service = new CustomerWebhookEndpointService(database, makeProtector());
  const created = await service.createEndpoint(ACTOR, INPUT);
  await assert.rejects(
    service.readEndpoint({ ...ACTOR, tenantId: OTHER_TENANT_ID }, created.endpoint.endpointId),
    /NOT_FOUND/,
  );
  database.allowMembership = false;
  await assert.rejects(service.createEndpoint(ACTOR, INPUT), /FORBIDDEN/);
  assert.equal(database.endpoints.length, 1);
});

test('endpoint URL and event subscriptions reject unsafe or arbitrary configuration', async () => {
  const service = new CustomerWebhookEndpointService(new FakeWebhookDatabase(), makeProtector());
  await assert.rejects(
    service.createEndpoint(ACTOR, { ...INPUT, targetUrl: 'http://customer.example.test/hook' }),
    /HTTPS/,
  );
  await assert.rejects(
    service.createEndpoint(ACTOR, { ...INPUT, targetUrl: 'https://user:pass@customer.example.test/hook' }),
    /authority/,
  );
  await assert.rejects(
    service.createEndpoint(ACTOR, { ...INPUT, targetUrl: 'https://customer.example.test/hook?token=x' }),
    /query/,
  );
  await assert.rejects(
    service.createEndpoint(ACTOR, { ...INPUT, eventTypes: ['wallet.low_balance', 'wallet.low_balance'] as never }),
    /unsupported or duplicate/,
  );
});
