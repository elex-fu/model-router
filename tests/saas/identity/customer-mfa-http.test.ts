import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCustomerMfaHandler } from '../../../src/saas/identity/customer-mfa-http.js';
import { CustomerMfaService } from '../../../src/saas/identity/customer-mfa-service.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { totpCode } from '../../../src/saas/platform/auth/totp.js';
import type { CustomerMfaSessionProof } from '../../../src/saas/identity/customer-mfa-types.js';
import { CustomerMfaUnitDatabase,CustomerMfaUnitKeys,TEST_PASSWORD } from './customer-mfa-unit-database.js';

function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function string(value:unknown):string {if(typeof value!=='string')throw new Error('Unit HTTP shape');return value;}
async function endpoint(t:TestContext,composed=false) {
  const db=await CustomerMfaUnitDatabase.create(),keys=new CustomerMfaUnitKeys(db),proof=await db.session();
  const svc=new CustomerMfaService(db,{issuer:'Customer MFA HTTP Unit',keyProvider:keys});
  let handler:ReturnType<typeof createCustomerMfaHandler>|undefined;
  let limited=false,limiterFailed=false;
  const server=createServer((req,res)=>{void (async()=>{
    if(!handler||!await handler(req,res)){res.writeHead(404);res.end();}
  })().catch(()=>{res.destroy();});});
  t.after(async()=>{try {server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}finally {keys.key.fill(0);}});
  const listening=once(server,'listening');let timer:ReturnType<typeof setTimeout>|undefined;
  server.listen(0,'127.0.0.1');
  try {await Promise.race([listening,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('Unit listener timeout')),5000);timer.unref();})]);}
  finally {if(timer)clearTimeout(timer);}
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const origin='http://127.0.0.1:'+addr.port;
  const rateLimiter={async take(){if(limiterFailed)throw new Error('synthetic private rate-limit detail');return limited?1:undefined;}};
  handler=composed?createSaasIdentityHandler({service:new SaasIdentityService(db),customerMfa:svc,
    publicOrigin:origin,sessionTtlSeconds:1800,rateLimiter})
    :createCustomerMfaHandler({service:svc,publicOrigin:origin,rateLimiter});
  const request=async(path:string,body?:unknown,p:CustomerMfaSessionProof=proof,headers:Record<string,string>={})=>{
    const response=await fetch(origin+'/console/api/v1/auth/mfa'+path,{
      method:body===undefined?'GET':'POST',headers:{origin,
        cookie:'mr_saas_session='+p.sessionToken+'; mr_saas_csrf='+p.csrfToken,
        'x-csrf-token':p.csrfToken,'content-type':'application/json',...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    const json:unknown=await response.json();assert.ok(record(json));
    return {response,json};
  };
  return {db,keys,svc,proof,request,setLimited:(v:boolean)=>{limited=v;},setLimiterFailure:()=>{limiterFailed=true;}};
}
test('actual public HTTP -> real password/crypto/service enrollment and confirm clear customer cookies',async t=>{
  const f=await endpoint(t);
  const start=await f.request('/enrollment/start',{password:TEST_PASSWORD});
  assert.equal(start.response.status,201);assert.equal(start.response.headers.get('cache-control'),'no-store');
  assert.ok(record(start.json.data));const secret=string(start.json.data.secret),token=string(start.json.data.confirmationToken);
  assert.equal(JSON.stringify(f.db.state.events).includes(secret),false);
  const done=await f.request('/enrollment/confirm',{password:TEST_PASSWORD,confirmationToken:token,code:totpCode(secret,f.db.state.now)},f.db.next(f.proof));
  assert.equal(done.response.status,200);assert.ok(record(done.json.data));assert.equal(done.json.data.signInRequired,true);
  assert.equal(done.response.headers.getSetCookie().length,2);
  assert.equal(done.response.headers.getSetCookie().every(c=>c.includes('Max-Age=0')&&c.includes('Path=/console/api/v1')),true);
  assert.equal(f.db.state.credentials[0]?.verified,true);assert.equal(f.db.state.sessions[0]?.revoked,true);
  const status=await f.request('',undefined,await f.db.session());
  assert.equal(status.response.status,200);assert.deepEqual(status.json.data,{enabled:true});
  assert.equal('secret' in status.json.data,false);
});
test('public duplicate concurrent start preserves one credential, no second secret issuance',async t=>{
  const f=await endpoint(t),responses=await Promise.all([
    f.request('/enrollment/start',{password:TEST_PASSWORD}),f.request('/enrollment/start',{password:TEST_PASSWORD},f.db.next(f.proof))]);
  assert.deepEqual(responses.map(x=>x.response.status).sort(),[201,409]);
  assert.equal(f.db.state.credentials.length,1);assert.equal(f.db.state.enrollments.length,1);
  assert.equal(responses.filter(x=>record(x.json.data)&&Object.hasOwn(x.json.data,'secret')).length,1);
});
test('HTTP origin/CSRF/duplicate cookies/query secret/client recent boolean cannot reach producer',async t=>{
  const f=await endpoint(t);
  const deniedHeaders:Record<string,string>[]=[{origin:'http://untrusted.invalid'}, {'x-csrf-token':'incorrect'},
    {cookie:'mr_saas_session='+f.proof.sessionToken+'; mr_saas_session='+f.proof.sessionToken+'; mr_saas_csrf='+f.proof.csrfToken}];
  for(const headers of deniedHeaders) {
    const r=await f.request('/enrollment/start',{password:TEST_PASSWORD},f.db.next(f.proof),headers);
    assert.equal(r.response.status===401||r.response.status===403,true);
  }
  const query=await f.request('/enrollment/start?secret=synthetic-hidden',{password:TEST_PASSWORD});
  assert.equal(query.response.status,400);assert.equal(JSON.stringify(query.json).includes('synthetic-hidden'),false);
  const clientProof=await f.request('/enrollment/start',{password:TEST_PASSWORD,recent:true});
  assert.equal(clientProof.response.status,400);assert.equal(f.keys.calls,0);assert.equal(f.db.state.commands.length,0);
});
test('expired enrollment and raw sensitive key/service errors never surface public detail',async t=>{
  const f=await endpoint(t),start=await f.request('/enrollment/start',{password:TEST_PASSWORD});
  assert.ok(record(start.json.data));const token=string(start.json.data.confirmationToken);
  f.db.state.now+=300001;
  const expired=await f.request('/enrollment/confirm',{password:TEST_PASSWORD,confirmationToken:token,code:'000000'},f.db.next(f.proof));
  assert.equal(expired.response.status,409);assert.equal(JSON.stringify(expired.json).includes(token),false);
  f.keys.fail=true;
  const failure=await f.request('/enrollment/start',{password:TEST_PASSWORD},f.db.next(f.proof));
  assert.equal(failure.response.status,503);assert.equal(JSON.stringify(failure.json).includes('synthetic sensitive'),false);
});
test('HTTP actual revoke requires password plus fresh TOTP, revokes current-session facts',async t=>{
  const f=await endpoint(t),start=await f.request('/enrollment/start',{password:TEST_PASSWORD});
  assert.ok(record(start.json.data));const secret=string(start.json.data.secret),token=string(start.json.data.confirmationToken);
  const confirmed=await f.request('/enrollment/confirm',{password:TEST_PASSWORD,confirmationToken:token,code:totpCode(secret,f.db.state.now)});
  assert.equal(confirmed.response.status,200);
  const proof=await f.db.session();f.db.state.now+=60000;
  const wrong=await f.request('/revoke',{password:'wrong',code:totpCode(secret,f.db.state.now)},proof);
  assert.equal(wrong.response.status,403);assert.equal(f.db.state.credentials[0]?.revoked,false);
  const revoked=await f.request('/revoke',{password:TEST_PASSWORD,code:totpCode(secret,f.db.state.now)},f.db.next(proof));
  assert.equal(revoked.response.status,200);assert.equal(f.db.state.credentials[0]?.revoked,true);
  const old=await f.request('',undefined,proof);assert.equal(old.response.status,401);
});
test('shared limiter failure/rate limit is fail-closed without password/KMS/business effects',async t=>{
  const f=await endpoint(t);f.setLimited(true);
  assert.equal((await f.request('/enrollment/start',{password:TEST_PASSWORD})).response.status,429);
  f.setLimited(false);f.setLimiterFailure();
  const failed=await f.request('/enrollment/start',{password:TEST_PASSWORD});assert.equal(failed.response.status,503);
  assert.equal(JSON.stringify(failed.json).includes('synthetic private'),false);
  assert.equal(f.keys.calls,0);assert.equal(f.db.state.credentials.length,0);
});
test('existing identity HTTP composition delegates the public MFA path to the genuine producer',async t=>{
  const f=await endpoint(t,true);
  const denied=await f.request('/enrollment/start',{password:'incorrect'});
  assert.equal(denied.response.status,403);assert.equal(f.keys.calls,0);
  const started=await f.request('/enrollment/start',{password:TEST_PASSWORD});
  assert.equal(started.response.status,201);assert.ok(record(started.json.data));
  const secret=string(started.json.data.secret),token=string(started.json.data.confirmationToken);
  const confirmed=await f.request('/enrollment/confirm',{password:TEST_PASSWORD,confirmationToken:token,
    code:totpCode(secret,f.db.state.now)});
  assert.equal(confirmed.response.status,200);assert.equal(f.db.state.credentials[0]?.verified,true);
  assert.equal(f.db.state.sessions.every(s=>s.revoked),true);
  assert.equal(f.db.state.events.length,f.db.state.audits.length);
  assert.equal(f.db.state.events.length,f.db.state.outbox.length);
});
