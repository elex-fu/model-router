import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAwsResponsesHistoryKms, type ResponsesHistoryAwsCredentials } from '../../../src/saas/runtime/aws-responses-history-kms.js';
import { RESPONSES_HISTORY_KMS_PURPOSE, ResponsesHistoryRuntimeError } from '../../../src/saas/runtime/responses-history-kms.js';
const keyId = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
const now = Date.parse('2026-10-24T00:00:00Z');
const credentials: ResponsesHistoryAwsCredentials = {accessKeyId:'ASIAABCDEFGHIJKLMNOP',secretAccessKey:'test-secret-credential-only',sessionToken:'test-session-token-only',expiration:'2026-10-24T01:00:00Z'};
const encryptionContext = {purpose:RESPONSES_HISTORY_KMS_PURPOSE,version:'2',keyId,aadSha256:'a'.repeat(64)};
const request = {kmsKeyId:keyId,keySpec:'AES_256' as const,encryptionContext};
const options = {env:{MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_REGION:'us-east-1'},purpose:RESPONSES_HISTORY_KMS_PURPOSE,keyId,nowMs:()=>now,readCredentials:async()=>credentials};
test('AWS history uses fixed region endpoint, scoped SigV4 and short lived credential snapshot every request', async () => {
  let reads = 0; const seen: any[] = []; const key = Buffer.alloc(32,7);
  const kms = createAwsResponsesHistoryKms({...options,readCredentials:async()=>{reads++;return {...credentials};},fetch:(async (url: any,init: any) => {
    assert.equal(url,'https://kms.us-east-1.amazonaws.com/'); assert.equal(init.redirect,'error'); assert.equal(init.method,'POST');
    const headers = init.headers as Record<string,string>; assert.equal(headers['x-amz-date'],'20261024T000000Z'); assert.equal(headers['x-amz-security-token'],credentials.sessionToken);
    assert.match(headers.authorization,/Credential=ASIAABCDEFGHIJKLMNOP\/20261024\/us-east-1\/kms\/aws4_request/); assert.match(headers.authorization,/SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[a-f0-9]{64}$/);
    const body = JSON.parse(init.body); seen.push(body); assert.equal(body.KeyId,keyId); assert.deepEqual(body.EncryptionContext,encryptionContext);
    return new Response(JSON.stringify({KeyId:keyId,Plaintext:key.toString('base64'),CiphertextBlob:Buffer.from('wrapped-key').toString('base64'),EncryptionAlgorithm:'SYMMETRIC_DEFAULT'}));
  }) as typeof fetch});
  const generated = await kms.generateDataKey(request); assert.equal(generated.plaintextKey.length,32);
  const decrypted = await kms.decryptDataKey({kmsKeyId:keyId,ciphertextBlob:generated.ciphertextBlob,encryptionContext}); assert.deepEqual(decrypted,key); assert.equal(reads,2); assert.equal(kms.diagnostics?.().credentialExpiresAt,'2026-10-24T01:00:00.000Z'); assert.deepEqual(kms.diagnostics?.().retainedDecryptKeyIds,[keyId]); assert.equal(JSON.stringify(kms.diagnostics?.()).includes(credentials.secretAccessKey),false); assert.equal(seen[0].KeySpec,'AES_256'); assert.equal(seen[1].EncryptionAlgorithm,'SYMMETRIC_DEFAULT');
  generated.plaintextKey.fill(0); decrypted.fill(0); await kms.close();
});
test('AWS history rejects wrong purpose/key, unsupported regions and mismatched returned KeyId', async () => {
  assert.throws(()=>createAwsResponsesHistoryKms({...options,env:{MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_REGION:'invented-1'}}),ResponsesHistoryRuntimeError);
  const kms = createAwsResponsesHistoryKms({...options,fetch:(async()=>new Response(JSON.stringify({KeyId:'other-key',Plaintext:Buffer.alloc(32).toString('base64'),CiphertextBlob:'YQ=='}))) as typeof fetch});
  await assert.rejects(kms.generateDataKey({...request,encryptionContext:{...encryptionContext,purpose:'provider-credential'}}),ResponsesHistoryRuntimeError);
  await assert.rejects(kms.generateDataKey(request),ResponsesHistoryRuntimeError); await kms.close();
});
test('AWS history expires credentials before network and redacts transport errors', async () => {
  let calls = 0;
  const expired = createAwsResponsesHistoryKms({...options,readCredentials:async()=>({...credentials,expiration:'2026-10-24T00:00:30Z'}),fetch:(async()=>{calls++;throw new Error('secret');}) as typeof fetch});
  await assert.rejects(expired.generateDataKey(request),ResponsesHistoryRuntimeError); assert.equal(calls,0);
  const kms = createAwsResponsesHistoryKms({...options,fetch:(async()=>{throw new Error('secret-access-key');}) as typeof fetch});
  await assert.rejects(kms.generateDataKey(request),(error: unknown)=>error instanceof ResponsesHistoryRuntimeError && !error.message.includes('secret-access-key'));
  await expired.close(); await kms.close();
});
