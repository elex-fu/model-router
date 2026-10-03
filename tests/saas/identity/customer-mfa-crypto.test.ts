import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { encryptCredential,decryptCredential,CredentialCryptoError } from '../../../src/saas/credentials/crypto.js';
import { customerMfaCredentialAad,customerMfaEnvelope,customerMfaMatchingStep } from '../../../src/saas/identity/customer-mfa-crypto.js';
import { CustomerMfaError } from '../../../src/saas/identity/customer-mfa-types.js';
import { encodeBase32,totpCode } from '../../../src/saas/platform/auth/totp.js';
import { PLATFORM_TOTP_PROVIDER } from '../../../src/saas/platform/auth/types.js';
test('real encrypted customer envelope exactly preserves finance-purpose AAD without platform RBAC',async()=>{
  const key=randomBytes(32),userId=randomUUID(),credentialId=randomUUID(),raw=randomBytes(20);
  const secret=encodeBase32(raw);raw.fill(0);
  const keys={getCurrentKey:()=>({keyId:'ephemeral-customer-only',key}),getKey:()=>key};
  try {
    const envelope=await encryptCredential(secret,customerMfaCredentialAad(userId,credentialId),keys);
    assert.equal(await decryptCredential(envelope,{userId,provider:PLATFORM_TOTP_PROVIDER,credentialId},keys)===secret,true);
    for(const context of [{userId:randomUUID(),provider:PLATFORM_TOTP_PROVIDER,credentialId},
      {userId,provider:'customer-totp-unversioned',credentialId},{userId,provider:PLATFORM_TOTP_PROVIDER,credentialId:randomUUID()}])
      await assert.rejects(decryptCredential(envelope,context,keys),e=>e instanceof CredentialCryptoError&&e.code==='AUTHENTICATION_FAILED');
    assert.equal(Object.hasOwn(customerMfaCredentialAad(userId,credentialId),'audience'),false);
  } finally {key.fill(0);}
});
test('bounded envelope parser rejects damaged/non-envelope/oversize bytes without raw detail',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from('raw-synthetic-private'),Buffer.from('{}'),Buffer.alloc(4097)])
    assert.throws(()=>customerMfaEnvelope(bytes),e=>e instanceof CustomerMfaError&&e.code==='UNAVAILABLE'&&!e.message.includes('private'));
});
test('actual TOTP reports matched counter, rejects invalid/time bounds; caller owns CAS',()=>{
  const raw=randomBytes(20),secret=encodeBase32(raw);raw.fill(0);const now=Date.UTC(2026,9,3,12,0,5);
  assert.equal(customerMfaMatchingStep(secret,totpCode(secret,now),now),String(Math.floor(now/30000)));
  assert.equal(customerMfaMatchingStep(secret,'bad',now),null);
  assert.equal(customerMfaMatchingStep(secret,'000000',-1),null);
  assert.equal(customerMfaMatchingStep(secret,'000000',Number.MAX_SAFE_INTEGER+1),null);
});
