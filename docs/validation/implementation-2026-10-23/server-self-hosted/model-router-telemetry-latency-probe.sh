set -eu
cd /opt/model-router
node --input-type=module <<'NODE'
import fs from 'node:fs';import path from 'node:path';
const dir=fs.mkdtempSync('/opt/model-router/operations/telemetry-latency-');
process.env.MODEL_ROUTER_PERF='1';
const {SQLiteTelemetryStore}=await import('./dist/storage/telemetry-store.js');
const {TelemetryWriteClient}=await import('./dist/storage/telemetry-write-client.js');
const file=path.join(dir,'probe.sqlite');const schema=new SQLiteTelemetryStore(file);await schema.init();await schema.close();
const writer=await TelemetryWriteClient.open(file);const timings=[];
const record={id:'isolated-probe',proxyKeyId:null,source:'health',clientProtocol:'anthropic',requestModel:'probe',routeId:null,configRevision:1,state:'received',finalHttpStatus:null,startedAtMs:Date.now(),endedAtMs:null,durationMs:null,firstByteMs:null,firstEventMs:null,firstTextMs:null,finalUpstreamId:null};
const attempt={id:'isolated-attempt',requestId:record.id,ordinal:1,upstreamId:'probe',credentialId:null,resolvedModel:'probe',reportedModel:null,protocol:'anthropic',outcome:'started',status:null,retryReason:null,startedAtMs:Date.now(),endedAtMs:null,usage:null,pricingVersion:null,costMicros:null,currency:null};
const started=performance.now();
try{
 for(const [stage,write] of [['received',()=>writer.upsertRequest(record)],['admitted',()=>writer.upsertRequest({...record,state:'admitted'})],['attempt-started',()=>writer.upsertAttempt(attempt)]]){const t=performance.now();await write();timings.push({stage,awaitMs:performance.now()-t});}
 const report={at:new Date().toISOString(),kind:'isolated-production-recorder-probe',writes:timings,totalMs:performance.now()-started,note:'Same deployed TelemetryWriteClient and three awaited pre-dispatch writes; separate temporary SQLite DB, no production records or settings changed.'};
 fs.writeFileSync('operations/telemetry-latency-probe.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await writer.close();fs.rmSync(dir,{recursive:true,force:true});}
NODE
