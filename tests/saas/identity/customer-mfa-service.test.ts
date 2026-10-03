import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptCredential } from '../../../src/saas/credentials/crypto.js';
import { CustomerMfaService } from '../../../src/saas/identity/customer-mfa-service.js';
import { CustomerMfaError, type CustomerMfaCode } from '../../../src/saas/identity/customer-mfa-types.js';
import { customerMfaCredentialAad, customerMfaEnvelope } from '../../../src/saas/identity/customer-mfa-crypto.js';
import { PLATFORM_TOTP_PROVIDER } from '../../../src/saas/platform/auth/types.js';
import { totpCode } from '../../../src/saas/platform/auth/totp.js';
import { CustomerMfaUnitDatabase,CustomerMfaUnitKeys,TEST_PASSWORD } from './customer-mfa-unit-database.js';

async function fixture() {
  const db=await CustomerMfaUnitDatabase.create(),keys=new CustomerMfaUnitKeys(db);
  const svc=new CustomerMfaService(db,{issuer:'Customer MFA Unit Only',keyProvider:keys});
  return {db,keys,svc,proof:await db.session()};
}
const rejected=(code:CustomerMfaCode)=>(e:unknown)=>e instanceof CustomerMfaError&&e.code===code;
async function enrolled() {
  const f=await fixture(),setup=await f.svc.start(f.proof,{password:TEST_PASSWORD});
  await f.svc.confirm(f.db.next(f.proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,f.db.state.now)});
  return {...f,setup,proof:await f.db.session()};
}
test('start uses real password/envelope and returns enrollment plaintext only once',async()=>{
  const {db,keys,svc,proof}=await fixture();
  const setup=await svc.start(proof,{password:TEST_PASSWORD});
  assert.equal(db.state.credentials.length,1);assert.equal(db.state.credentials[0]?.verified,false);
  const c=db.state.credentials[0];assert.ok(c);
  assert.equal(Buffer.from(c.encrypted_secret).toString('utf8').includes(setup.secret),false);
  assert.equal(JSON.stringify(db.state).includes(setup.confirmationToken),false);
  assert.equal(JSON.stringify(db.state.events).includes(setup.secret),false);
  assert.equal(await decryptCredential(customerMfaEnvelope(c.encrypted_secret),customerMfaCredentialAad(db.userId,c.id),keys)===setup.secret,true);
  assert.equal(keys.calls>0,true);
  await assert.rejects(svc.start(db.next(proof),{password:TEST_PASSWORD}),rejected('ENROLLMENT_PENDING'));
  assert.equal(db.state.credentials.length,1);
  assert.equal(db.state.audits.length,db.state.events.length);assert.equal(db.state.events.length,db.state.outbox.length);
});
test('wrong password is a durable uniform denial before any key lookup',async()=>{
  const {db,keys,svc,proof}=await fixture();
  await assert.rejects(svc.start(proof,{password:'not-the-password'}),rejected('REAUTH_REQUIRED'));
  assert.equal(keys.calls,0);assert.equal(db.state.credentials.length,0);assert.equal(db.state.budget,1);
  assert.equal(db.state.events.at(-1)?.[7],'REAUTH_REQUIRED');assert.equal(db.state.commands.at(-1)?.outcome,'denied');
  assert.equal(db.state.events.length,db.state.audits.length);assert.equal(db.state.events.length,db.state.outbox.length);
});
test('confirm consumes real TOTP and atomically verifies credential and revokes all prior customer sessions',async()=>{
  const {db,keys,svc,proof}=await fixture();await db.session();
  const setup=await svc.start(proof,{password:TEST_PASSWORD});
  const result=await svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,db.state.now)});
  assert.deepEqual(result,{enabled:true,sessionsRevoked:2,signInRequired:true});
  const c=db.state.credentials[0];assert.ok(c);
  assert.equal(c.verified,true);assert.equal(c.last_used_step,String(Math.floor(db.state.now/30000)));
  assert.equal(db.state.enrollments[0]?.consumed,true);assert.equal(db.state.sessions.every(s=>s.revoked),true);
  // EXACT finance-purpose legacy AAD, not a platform identity/role grant.
  assert.equal(customerMfaCredentialAad(db.userId,c.id).provider,PLATFORM_TOTP_PROVIDER);
  assert.equal(await decryptCredential(customerMfaEnvelope(c.encrypted_secret),
    {userId:db.userId,provider:PLATFORM_TOTP_PROVIDER,credentialId:c.id},keys)===setup.secret,true);
  await assert.rejects(svc.status(db.next(proof)),rejected('UNAUTHENTICATED'));
});
test('replayed confirmation cannot reuse nonce or a newly logged in session',async()=>{
  const {db,svc,proof,setup}=await enrolled();
  await assert.rejects(svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,db.state.now)}),rejected('ENROLLMENT_INVALID'));
  assert.equal(db.state.credentials.filter(c=>c.verified&&!c.revoked).length,1);
});
test('wrong session/CSRF/unknown nonce is rejected before key lookup',async()=>{
  const {db,keys,svc,proof}=await fixture();
  const setup=await svc.start(proof,{password:TEST_PASSWORD});const before=keys.calls;
  const other=await db.session();
  await assert.rejects(svc.confirm(other,{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:'000000'}),rejected('ENROLLMENT_INVALID'));
  await assert.rejects(svc.start({...db.next(proof),csrfToken:'x'.repeat(43)},{password:TEST_PASSWORD}),rejected('UNAUTHENTICATED'));
  assert.equal(keys.calls,before);assert.equal(db.state.enrollments[0]?.attempt_count,0);
});
test('five rejected genuine confirmation attempts lock and revoke pending credential with same-TX denial facts',async()=>{
  const {db,svc,proof}=await fixture(),setup=await svc.start(proof,{password:TEST_PASSWORD});
  for(let i=0;i<5;i++)await assert.rejects(svc.confirm(db.next(proof),{
    password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,code:'invalid'}),rejected('MFA_CODE_REJECTED'));
  assert.equal(db.state.enrollments[0]?.attempt_count,5);assert.equal(db.state.enrollments[0]?.locked,true);
  assert.equal(db.state.credentials[0]?.revoked,true);assert.equal(db.state.credentials[0]?.verified,false);
  await assert.rejects(svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,db.state.now)}),rejected('ENROLLMENT_INVALID'));
  assert.equal(db.state.events.length,db.state.audits.length);assert.equal(db.state.events.length,db.state.outbox.length);
});
test('expired enrollment cannot confirm/decrypt and a later real start closes expired ciphertext',async()=>{
  const {db,keys,svc,proof}=await fixture(),setup=await svc.start(proof,{password:TEST_PASSWORD});
  const before=keys.calls;db.state.now+=300001;
  await assert.rejects(svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,db.state.now)}),rejected('ENROLLMENT_INVALID'));assert.equal(keys.calls,before);
  await svc.start(db.next(proof),{password:TEST_PASSWORD});
  assert.equal(db.state.enrollments[0]?.closed,true);assert.equal(db.state.credentials[0]?.revoked,true);
  assert.equal(db.state.credentials.filter(c=>!c.revoked&&!c.verified).length,1);
});
test('replacement requires real current password and unconsumed old TOTP plus real new TOTP',async()=>{
  const {db,svc,proof,setup}=await enrolled();db.state.now+=60000;
  await assert.rejects(svc.start(db.next(proof),{password:TEST_PASSWORD}),rejected('MFA_CODE_REJECTED'));
  const replacement=await svc.start(db.next(proof),{password:TEST_PASSWORD,currentTotpCode:totpCode(setup.secret,db.state.now)});
  assert.equal(db.state.credentials[0]?.revoked,false);
  db.state.now+=60000;
  const result=await svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:replacement.confirmationToken,
    code:totpCode(replacement.secret,db.state.now),currentTotpCode:totpCode(setup.secret,db.state.now)});
  assert.equal(result.enabled,true);assert.equal(result.signInRequired,true);
  assert.equal(db.state.credentials[0]?.revoked,true);assert.equal(db.state.credentials[1]?.verified,true);
  assert.equal(db.state.credentials.filter(c=>c.verified&&!c.revoked).length,1);
});
test('reused current credential counter cannot authorize revocation after replacement start',async()=>{
  const {db,svc,proof,setup}=await enrolled();db.state.now+=60000;
  const code=totpCode(setup.secret,db.state.now);
  await svc.start(db.next(proof),{password:TEST_PASSWORD,currentTotpCode:code});
  await assert.rejects(svc.revoke(db.next(proof),{password:TEST_PASSWORD,code}),rejected('MFA_CODE_REJECTED'));
  assert.equal(db.state.credentials[0]?.revoked,false);
});
test('real password plus fresh TOTP revocation closes pending secret and revokes every customer session',async()=>{
  const {db,svc,proof,setup}=await enrolled();await db.session();db.state.now+=60000;
  await svc.start(db.next(proof),{password:TEST_PASSWORD,currentTotpCode:totpCode(setup.secret,db.state.now)});
  db.state.now+=60000;
  const changed=await svc.revoke(db.next(proof),{password:TEST_PASSWORD,code:totpCode(setup.secret,db.state.now)});
  assert.deepEqual(changed,{enabled:false,sessionsRevoked:2,signInRequired:true});
  assert.equal(db.state.credentials.every(c=>c.revoked),true);assert.equal(db.state.sessions.every(s=>s.revoked),true);
  assert.equal((await svc.status(await db.session())).enabled,false);
});
test('session revoked while key lookup is outside TX cannot produce pending secret',async()=>{
  const {db,keys,svc,proof}=await fixture();
  keys.beforeLookup=()=>{db.state.sessions.forEach(s=>{s.revoked=true;});};
  await assert.rejects(svc.start(proof,{password:TEST_PASSWORD}),rejected('AUTHORITY_CHANGED'));
  assert.equal(keys.calls>0,true);assert.equal(db.state.credentials.length,0);
  assert.equal(db.state.events.at(-1)?.[7],'AUTHORITY_CHANGED');
});
test('password change after genuine scrypt before final TX refuses the original authorization',async()=>{
  const {db,keys,svc,proof}=await fixture();
  keys.beforeLookup=()=>{db.state.passwordHash='changed-password-hash';};
  await assert.rejects(svc.start(proof,{password:TEST_PASSWORD}),rejected('AUTHORITY_CHANGED'));
  assert.equal(db.state.credentials.length,0);
});
test('key failure is unavailable, no raw error detail/credential is produced, denial persists',async()=>{
  const {db,keys,svc,proof}=await fixture();keys.fail=true;
  await assert.rejects(svc.start(proof,{password:TEST_PASSWORD}),e=>e instanceof CustomerMfaError
    &&e.code==='UNAVAILABLE'&&!e.message.includes('synthetic'));
  assert.equal(db.state.credentials.length,0);assert.equal(db.state.events.at(-1)?.[7],'UNAVAILABLE');
});
test('outbox failure rolls back verification, attempt counter, session revocation and terminal command',async()=>{
  const {db,svc,proof}=await fixture(),setup=await svc.start(proof,{password:TEST_PASSWORD});
  db.failTag='outbox';db.failOutcome='confirmed';
  await assert.rejects(svc.confirm(db.next(proof),{password:TEST_PASSWORD,confirmationToken:setup.confirmationToken,
    code:totpCode(setup.secret,db.state.now)}),rejected('UNAVAILABLE'));
  assert.equal(db.state.credentials[0]?.verified,false);assert.equal(db.state.enrollments[0]?.consumed,false);
  assert.equal(db.state.enrollments[0]?.attempt_count,0);assert.equal(db.state.sessions.every(s=>!s.revoked),true);
  assert.equal(db.state.events.some(e=>e[6]==='confirmed'),false);
});
test('two concurrent real starts preserve one pending credential and original writer/user/fresh-read order',async()=>{
  const {db,svc,proof}=await fixture();
  const results=await Promise.allSettled([svc.start(proof,{password:TEST_PASSWORD}),
    svc.start(db.next(proof),{password:TEST_PASSWORD})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&rejected('ENROLLMENT_PENDING')(r.reason)).length,1);
  assert.equal(db.state.credentials.length,1);
  const entry=db.trace.findIndex(x=>x.tag==='isolation');
  assert.deepEqual(db.trace.slice(entry,entry+6).map(x=>x.tag),['isolation','timeouts','writer','hint','user','current']);
  assert.equal(db.trace.filter(x=>['writer','hint','user','current','audit','event','outbox'].includes(x.tag)).every(x=>x.tx),true);
});
test('durable per-user limit and platform-role separation fail before KMS',async()=>{
  const {db,keys,svc,proof}=await fixture();db.state.budget=20;
  await assert.rejects(svc.start(proof,{password:TEST_PASSWORD}),rejected('RATE_LIMITED'));assert.equal(keys.calls,0);
  db.state.platform=true;
  await assert.rejects(svc.start(db.next(proof),{password:TEST_PASSWORD}),rejected('MFA_STATE_CONFLICT'));
  assert.equal(keys.calls,0);assert.equal(db.state.credentials.length,0);assert.equal(db.state.platform,true);
});
