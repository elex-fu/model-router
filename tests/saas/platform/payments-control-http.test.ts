import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPaymentsControlHttpHandler } from '../../../src/saas/platform/payments-control-http.js';
import { PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_SESSION_COOKIE } from '../../../src/saas/platform/auth/http.js';

function fixture(roles: string[] = ['operations']) {
  let queries = 0, transactions = 0;
  const options: any = {
    publicOrigin:'https://admin.example',
    access:{authenticate:async()=>({userId:'operator',sessionId:'session',roles})},
    authService:{verifyCsrfToken:async()=>true},
    resolver:{require(){throw new Error('unused');},list:()=>[]},
    database:{query:async()=>{queries++;return {rows:[{mode:'disabled',active_binding_id:null,revision:'1'}],rowCount:1};},transaction:async()=>{transactions++;throw new Error('service failure must be safe');}},
  };
  async function call(method: string, body?: any, headers: Record<string,string | undefined> = {}, url = '/admin/api/v1/payments/control') {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
    req.method=method;req.url=url;
    req.headers={host:'admin.example',origin:'https://admin.example','content-type':'application/json',cookie:`${PLATFORM_ADMIN_SESSION_COOKIE}=s; ${PLATFORM_ADMIN_CSRF_COOKIE}=csrf`,'x-csrf-token':'csrf',...headers};
    let status=0, text=''; const responseHeaders: Record<string,unknown>={};
    const res={destroyed:false,writableEnded:false,setHeader(k:string,v:unknown){responseHeaders[k]=v;},writeHead(s:number,h:Record<string,unknown>){status=s;Object.assign(responseHeaders,h);},end(s:string){text=s;this.writableEnded=true;}} as unknown as ServerResponse;
    const handled=await createPaymentsControlHttpHandler(options)(req,res);
    return {handled,status,body:text ? JSON.parse(text):undefined,headers:responseHeaders};
  }
  return {options,call,counts:()=>({queries,transactions})};
}
test('GET returns only nonsecret control state with no-store headers',async()=>{
  const f=fixture();const r=await f.call('GET');assert.equal(r.status,200);assert.deepEqual(r.body.data,{mode:'disabled',activeBindingId:null,revision:'1'});assert.equal(r.headers['cache-control'],'no-store');assert.equal(f.counts().transactions,0);
});
test('operations and superadmin are required',async()=>{
  const denied=fixture(['finance']);assert.equal((await denied.call('GET')).status,403);assert.equal(denied.counts().queries,0);
  assert.equal((await fixture(['superadmin']).call('GET')).status,200);
});
test('Host, Origin, queries and methods fail closed',async()=>{
  const f=fixture();assert.equal((await f.call('GET',undefined,{host:'evil.example'})).status,403);
  assert.equal((await f.call('GET',undefined,{origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('GET',undefined,{},'/admin/api/v1/payments/control?mode=enabled')).status,400);
  const method=await f.call('POST');assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, PATCH');assert.equal(f.counts().queries,0);
});
test('PATCH enforces CSRF before service mutation',async()=>{
  const f=fixture();const r=await f.call('PATCH',{expectedRevision:'1',mode:'disabled',activeBindingId:null},{'x-csrf-token':'wrong'});assert.equal(r.status,403);assert.equal(f.counts().transactions,0);
});
test('PATCH closed body rejects actor injection and unsafe revision before mutation',async()=>{
  const f=fixture();for(const body of [{expectedRevision:'1',mode:'disabled',activeBindingId:null,actorId:'fake'},{expectedRevision:'0',mode:'disabled',activeBindingId:null},{expectedRevision:'9223372036854775808',mode:'disabled',activeBindingId:null},{expectedRevision:'1',mode:'enabled',activeBindingId:null}]) assert.equal((await f.call('PATCH',body)).status,400);
  assert.equal(f.counts().transactions,0);
});
test('valid PATCH invokes transactional service and hides internal failures',async()=>{
  const f=fixture();const r=await f.call('PATCH',{expectedRevision:'1',mode:'disabled',activeBindingId:null});assert.equal(f.counts().transactions,1);assert.equal(r.status,503);assert.ok(!JSON.stringify(r.body).includes('service failure'));
});
test('service CAS conflict maps to 409 and transaction rechecks live authority',async()=>{
  const f=fixture();let updated=false;
  f.options.database.transaction=async(work:any)=>work({query:async(sql:string)=>{
    if(sql.includes('FROM saas_platform_sessions')) return {rows:[{session_id:'session',roles:['operations']}],rowCount:1};
    if(sql.startsWith('UPDATE saas_payment_control')){updated=true;return {rows:[],rowCount:0};}
    return {rows:[],rowCount:0};
  }});
  const r=await f.call('PATCH',{expectedRevision:'1',mode:'disabled',activeBindingId:null});assert.equal(updated,true);assert.equal(r.status,409);assert.equal(r.body.error.code,'PAYMENT_CONTROL_CONFLICT');
});

test('browser GET without Origin uses same-origin fetch metadata or strict Referer',async()=>{
  const f=fixture();
  assert.equal((await f.call('GET',undefined,{origin:undefined,'sec-fetch-site':'same-origin'})).status,200);
  assert.equal((await f.call('GET',undefined,{origin:undefined,referer:'https://admin.example/admin/payments'})).status,200);
  assert.equal((await f.call('GET',undefined,{origin:undefined})).status,403);
  assert.equal((await f.call('GET',undefined,{origin:undefined,'sec-fetch-site':'cross-site',referer:'https://admin.example/admin/payments'})).status,403);
  assert.equal((await f.call('GET',undefined,{origin:undefined,'sec-fetch-site':'same-site'})).status,403);
  assert.equal((await f.call('GET',undefined,{origin:undefined,referer:'https://admin.example.evil/payments'})).status,403);
  assert.equal((await f.call('GET',undefined,{origin:'https://evil.example','sec-fetch-site':'same-origin'})).status,403);
  assert.equal((await f.call('PATCH',{expectedRevision:'1',mode:'disabled',activeBindingId:null},{origin:undefined,'sec-fetch-site':'same-origin'})).status,403);
});
