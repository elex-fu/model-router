import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { PostgresResponsesContinuationHistory } from '../../../src/saas/gateway/responses-continuation-postgres.js';
import { AesGcmResponsesHistoryCipher } from '../../../src/saas/gateway/responses-continuation-cipher.js';
import { PersistentResponsesContinuationResolver } from '../../../src/saas/gateway/responses-continuation-resolver.js';
import type { ResponsesHistoryIdentity, ResponsesHistoryRecord } from '../../../src/saas/gateway/responses-continuation-history.js';
import { REQUIRED_FLAG, anyRoleConfigured, roleUrls, seedFixture } from '../metering/normal-success-postgres-fixture.js';

// Offline suite skips only when no PG roles are configured; required CI and partial role configs fail closed.
test('141 real PG gateway persists only ciphertext, enforces immutable history and database-clock expiry', { timeout: 300_000, skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and disposable role URLs` : false }, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const controlPlane = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => { await Promise.allSettled([migrator.close(), controlPlane.close(), gateway.close()]); });
  await gateway.verifySchema();
  const fixture = await seedFixture(migrator, gateway, 'platform');
  const nowRow = await gateway.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = new Date(nowRow.rows[0]!.now).getTime();
  const history = new PostgresResponsesContinuationHistory(gateway);
  const cipher = new AesGcmResponsesHistoryCipher('synthetic-history-v1', new Map([['synthetic-history-v1', new Uint8Array(32).fill(11)]]));
  t.after(() => cipher.close());
  const identity: ResponsesHistoryIdentity = {
    tenantId: fixture.tenantId, projectId: fixture.projectId, proxyKeyId: fixture.keyId,
    conversationId: `history-${randomUUID()}`, providerId: 'openai-codex', productId: 'codex-chatgpt',
    accountId: 'synthetic-account', credentialId: 'synthetic-credential', credentialVersion: '1', credentialAuthzVersion: '1', publicModel: 'synthetic-model', resolvedModel: 'synthetic-model',
  };
  const responseId = `response-${randomUUID()}`;
  const reference = { tenantId: identity.tenantId, projectId: identity.projectId, proxyKeyId: identity.proxyKeyId, conversationId: identity.conversationId, responseId };
  const resolver = new PersistentResponsesContinuationResolver({ history, cipher, maxBytes: 10000, ttlMs: 60_000, nowMs: () => now });
  const output = [{ type: 'message', content: 'synthetic-answer' }, { type: 'compaction', encrypted_content: 'synthetic-opaque' }];
  assert.equal(await resolver.remember({ identity, responseId, request: { model: identity.publicModel, input: 'synthetic-private-context' }, output, operation: 'responses' }), true);
  const saved = await history.find(reference, 0);
  assert.ok(saved);
  assert.equal(Buffer.from(saved.encryptedContext).includes(Buffer.from('synthetic-private-context')), false);
  assert.equal(await history.insert(saved), 'identical');
  assert.equal(await history.insert({ ...saved, canonicalContextDigest: 'e'.repeat(64) }), 'conflict');
  assert.equal(await history.find({ ...reference, projectId: randomUUID() }, now), null);
  assert.equal(await history.find({ ...reference, proxyKeyId: randomUUID() }, now), null);
  const replay = await resolver.resolve(reference, { input: 'next', previous_response_id: responseId });
  assert.deepEqual(replay.body.input, [{ role: 'user', content: 'synthetic-private-context' }, ...output, { role: 'user', content: 'next' }]);
  resolver.assertPreparedIdentity(replay, identity);
  assert.throws(() => resolver.assertPreparedIdentity(replay, { ...identity, credentialVersion: '2' }), /resend full context/);
  await assert.rejects(gateway.query('UPDATE saas_responses_continuation_contexts SET expires_at=expires_at WHERE tenant_id=$1 AND proxy_key_id=$2 AND conversation_id=$3 AND response_id=$4', [reference.tenantId, reference.proxyKeyId, reference.conversationId, reference.responseId]));
  const expired: ResponsesHistoryRecord = { ...saved, responseId: `expired-${randomUUID()}`, createdAtMs: now - 20_000, expiresAtMs: now - 10_000 };
  assert.equal(await history.insert(expired), 'inserted');
  assert.equal(await history.find(expired, now - 30_000), null, 'host-supplied past time cannot revive DB-expired history');
  assert.ok(await history.purgeExpired(now + 24 * 60 * 60 * 1000, 1000) >= 1);
  assert.notEqual(await history.find(reference, now), null, 'host-supplied future time cannot prematurely purge active history');
  const expiredRow = await gateway.query('SELECT response_id FROM saas_responses_continuation_contexts WHERE tenant_id=$1 AND proxy_key_id=$2 AND conversation_id=$3 AND response_id=$4', [expired.tenantId, expired.proxyKeyId, expired.conversationId, expired.responseId]);
  assert.equal(expiredRow.rows.length, 0);
  await history.delete(reference);
});
