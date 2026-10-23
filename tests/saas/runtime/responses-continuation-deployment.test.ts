import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { loadResponsesContinuationDeployment } from '../../../src/saas/runtime/responses-continuation-deployment.js';
import { KmsResponsesHistoryCipher, loadResponsesHistoryKmsCipher, RESPONSES_HISTORY_KMS_PURPOSE, ResponsesHistoryRuntimeError, type ResponsesHistoryKms } from '../../../src/saas/runtime/responses-history-kms.js';

function kmsFixture(): { kms: ResponsesHistoryKms; keys: Uint8Array[]; closed: () => number } {
  const wrapped = new Map<string,{key:Buffer;context:string}>(); const keys: Uint8Array[] = []; let closed = 0;
  return { keys, closed: () => closed, kms: {
    securityBoundary: 'external-kms',
    generateDataKey(request) { const key = randomBytes(32), blob = randomBytes(40); wrapped.set(blob.toString('hex'),{key:Buffer.from(key),context:JSON.stringify(request.encryptionContext)}); keys.push(key); return {plaintextKey:key,ciphertextBlob:blob}; },
    decryptDataKey(request) { const data = wrapped.get(Buffer.from(request.ciphertextBlob).toString('hex')); if (!data || data.context !== JSON.stringify(request.encryptionContext)) throw new Error('private backend error'); const key = Buffer.from(data.key); keys.push(key); return key; },
    checkReady() {}, close() { closed++; for (const item of wrapped.values()) item.key.fill(0); },
  } };
}
const database: SqlExecutor = { async query<Row>(sql: string) { return { rows: (sql.includes('has_table_privilege') ? [{allowed:true}] : []) as Row[], rowCount: 0 }; } };
test('history KMS envelope binds full associated data and key ID, zeroes each plaintext DEK', async () => {
  const f = kmsFixture(), cipher = new KmsResponsesHistoryCipher('history-key',f.kms);
  const plaintext = Buffer.from('private canonical history'); const aad = Buffer.from(JSON.stringify({ tenantId:'t',projectId:'p',proxyKeyId:'k',conversationId:'c',responseId:'r',digest:createHash('sha256').update(plaintext).digest('hex'),createdAtMs:1,expiresAtMs:2 }));
  const sealed = await cipher.seal(plaintext,aad); assert.equal(Buffer.from(sealed.encryptedContext).includes(plaintext),false);
  assert.deepEqual(await cipher.open(sealed,aad),plaintext);
  await assert.rejects(cipher.open(sealed,Buffer.from('other identity')),ResponsesHistoryRuntimeError);
  await assert.rejects(cipher.open({...sealed,encryptionKeyId:'another-key'},aad),ResponsesHistoryRuntimeError);
  const corrupt = Buffer.from(sealed.encryptedContext); corrupt[corrupt.length-1] ^= 1;
  await assert.rejects(cipher.open({...sealed,encryptedContext:corrupt},aad),ResponsesHistoryRuntimeError);
  assert.ok(f.keys.every(key => key.every(byte => byte === 0)));
  await cipher.close(); await cipher.close(); assert.equal(f.closed(),1);
  await assert.rejects(cipher.seal(plaintext,aad),ResponsesHistoryRuntimeError);
});
test('history trusted module receives purpose scoped environment and performs real DEK roundtrip', async () => {
  const f = kmsFixture(); let env: Readonly<Record<string,string|undefined>> | undefined;
  const cipher = await loadResponsesHistoryKmsCipher('history-key',{ env: { SAAS_RESPONSES_HISTORY_KMS_MODULE:'/trusted/history-kms.mjs',MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_KEY_ID:'history-key',AWS_SECRET_ACCESS_KEY:'do-not-forward',MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY:'do-not-forward' }, importer: async () => ({createResponsesHistoryKms(options: any) { assert.equal(options.purpose,RESPONSES_HISTORY_KMS_PURPOSE); env = options.env; return f.kms; }}) });
  assert.equal(env?.AWS_SECRET_ACCESS_KEY,undefined); assert.equal(env?.MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY,undefined);
  assert.equal(f.keys.length,2); await cipher.close();
});
test('history deployment disabled by default; production forbids pilot keys and checks exact DB privileges', async () => {
  assert.equal(await loadResponsesContinuationDeployment({database,env:{}}),undefined);
  await assert.rejects(loadResponsesContinuationDeployment({database,env:{MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE:'production-kms',MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KEYRING_FILE:'/secret'}}),ResponsesHistoryRuntimeError);
  const f = kmsFixture();
  const loaded = await loadResponsesContinuationDeployment({database,env:{MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE:'production-kms',MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_KEY_ID:'history-key',SAAS_RESPONSES_HISTORY_KMS_MODULE:'/trusted/history.mjs'},importer:async () => ({createResponsesHistoryKms:()=>f.kms})});
  assert.equal(loaded?.readiness,'production-kms'); assert.ok(loaded?.resolver); assert.equal(loaded?.diagnostics?.().verification,'kms_roundtrip_verified'); assert.equal(loaded?.diagnostics?.().productionEvidence,'external_evidence_required'); await loaded?.close(); assert.equal(f.closed(),1);
});
test('history readiness failure closes KMS and never leaks underlying DB diagnostic', async () => {
  const f = kmsFixture();
  await assert.rejects(loadResponsesContinuationDeployment({database:{async query(){throw new Error('private DB credentials');}},env:{MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE:'production-kms',MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_KEY_ID:'history-key',SAAS_RESPONSES_HISTORY_KMS_MODULE:'/trusted/history.mjs'},importer:async () => ({createResponsesHistoryKms:()=>f.kms})}), (error: unknown) => error instanceof ResponsesHistoryRuntimeError && error.code === 'READINESS_FAILED' && !error.message.includes('private'));
  assert.equal(f.closed(),1);
});
test('pilot file keyring is independent, permission checked and explicitly labeled', async () => {
  const dir = await mkdtemp(join(tmpdir(),'responses-history-')); const file = join(dir,'keys.json');
  try {
    await writeFile(file,JSON.stringify({version:1,currentKeyId:'history-test',keys:{'history-test':'11'.repeat(32)}}),{mode:0o600});
    const env = {MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE:'pilot-file-keyring',MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KEYRING_FILE:file};
    const loaded = await loadResponsesContinuationDeployment({database,env}); assert.equal(loaded?.readiness,'pilot-file-keyring'); assert.equal(loaded?.diagnostics?.().verification,'pilot_only'); await loaded?.close();
    await chmod(file,0o644); await assert.rejects(loadResponsesContinuationDeployment({database,env}),ResponsesHistoryRuntimeError);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
