import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_FIRST_REQUEST_REQUIRED, createOwnedAcceptanceLifecycle, requirePlatformFirstRequestEnvironment, verifyPlatformAccessFirstRequest } from '../../scripts/ops/verify-platform-access-first-request.js';

// No provider/network/database work is performed by the fail-closed contract test.
test('platform first-request acceptance refuses absent explicit live authorization',()=>{
  assert.throws(()=>requirePlatformFirstRequestEnvironment({}),/Explicit first-request live opt-in is required/);
  assert.throws(()=>requirePlatformFirstRequestEnvironment({[PLATFORM_FIRST_REQUEST_REQUIRED]:'1'}),/Ephemeral KIMI_CODE_API_KEY is required/);
});

// Local process/files only: exercise the same signal handlers without touching
// provider credentials, PostgreSQL, Redis, or a real control plane.
test('owned signal cleanup aborts continuation, stops its child and removes temporary signing material once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'model-router-first-cleanup-test-'));
  const material=join(directory,'ephemeral-signing-material');await writeFile(material,'test-only',{mode:0o600});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const exited=once(child,'close');
  const signals=new EventEmitter();let cleanups=0,finished=0;
  const lifecycle=createOwnedAcceptanceLifecycle(async()=>{
    cleanups++;child.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true});
  },signals,()=>{finished++;});
  signals.emit('SIGTERM');signals.emit('SIGINT');
  assert.equal(lifecycle.signal.aborted,true);assert.throws(()=>lifecycle.assertRunning());
  await lifecycle.close();await lifecycle.close();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(cleanups,1);assert.equal(finished,1);
  assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);
  assert.ok(child.exitCode!==null||child.signalCode!==null);
  await assert.rejects(stat(material),{code:'ENOENT'});
});

const enabled=process.env[PLATFORM_FIRST_REQUEST_REQUIRED]==='1';
const required=process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED==='1';
test('new customer formal HTTP provisioning reaches one real built-in Kimi request and balanced PG settlement',{
  skip:!enabled&&!required?'Explicit RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE=1 and disposable runner required':false,
  timeout:300000,
},async t=>{
  // Required mode must fail, never skip, if credentials/role URLs are absent.
  await verifyPlatformAccessFirstRequest(value=>t.diagnostic(JSON.stringify(value)));
});
