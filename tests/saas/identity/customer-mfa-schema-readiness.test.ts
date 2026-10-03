import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { checkCustomerMfaSchema } from '../../../src/saas/identity/customer-mfa-schema-readiness.js';
import { CustomerMfaError } from '../../../src/saas/identity/customer-mfa-types.js';

function catalog(shape=true, binding=true, damaged=false):{tx:SqlExecutor;calls:string[]} {
  const sql=readFileSync(resolve(process.cwd(),'deploy/drafts/customer-mfa-enrollment.forward.sql'),'utf8');
  const routines=Array.from(sql.matchAll(/CREATE FUNCTION model_router_saas\.(saas_customer_mfa_[a-z_]+)\(\) RETURNS trigger\nLANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS \$body\$([\s\S]*?)\$body\$;/g),
    m=>({name:m[1],body:m[2],safe:true}));
  assert.equal(routines.length,7);
  const calls:string[]=[];
  const tx:SqlExecutor={async query<Row>(query:string):Promise<SqlResult<Row>>{
    let rows:unknown[];
    if(query.includes('WITH wanted(relation_name,column_name,type_name)')) {calls.push('shape');rows=[{ready:shape}];}
    else if(query.includes('p.prosrc AS body')) {calls.push('routines');rows=routines.map((r,i)=>damaged&&i===0?{...r,body:r.body+' altered'}:r);}
    else if(query.includes('trigger_name,function_name,deferred,type_bits')) {calls.push('bindings');rows=[{ready:binding}];}
    else throw new Error('Unexpected readiness SQL');
    // Test-only PG catalog row boundary, not an application authority cast.
    return {rows:rows as Row[],rowCount:rows.length};
  }};
  return {tx,calls};
}
const unavailable=(e:unknown)=>e instanceof CustomerMfaError&&e.code==='UNAVAILABLE';
test('readiness catalog source contract matches exact draft routine bytes and trigger timing checks',async()=>{
  const f=catalog();await checkCustomerMfaSchema(f.tx);
  assert.deepEqual(f.calls,['shape','routines','bindings']);
  const source=readFileSync(resolve(process.cwd(),'src/saas/identity/customer-mfa-schema-readiness.ts'),'utf8');
  assert.match(source,/t\.tgtype=w\.type_bits AND t\.tgnargs=0/);
  assert.match(source,/current_user='model_router_saas_control_plane'/);
  assert.match(source,/p\.proowner='model_router_saas_migrator'::regrole AND NOT p\.prosecdef/);
  assert.match(source,/has_function_privilege\(current_user,p\.oid,'EXECUTE'\)/);
  assert.doesNotMatch(source,/saas_schema_migrations|SET ROLE|GRANT|verifySchema/);
});
test('bad relation/role/column shape refuses before any routine/binding query',async()=>{
  const f=catalog(false);await assert.rejects(checkCustomerMfaSchema(f.tx),unavailable);
  assert.deepEqual(f.calls,['shape']);
});
test('changed trigger function body refuses even when caller catalog fixture claims safe owner',async()=>{
  const f=catalog(true,true,true);await assert.rejects(checkCustomerMfaSchema(f.tx),unavailable);
  assert.deepEqual(f.calls,['shape','routines']);
});
test('missing/disabled/wrong-timing or deferred binding refuses startup, never no-op readiness',async()=>{
  const f=catalog(true,false);await assert.rejects(checkCustomerMfaSchema(f.tx),unavailable);
  assert.deepEqual(f.calls,['shape','routines','bindings']);
});
