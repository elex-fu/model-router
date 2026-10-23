set -eu
cd /opt/model-router
node --input-type=module <<'NODE'
import fs from 'node:fs';import os from 'node:os';import {execFileSync} from 'node:child_process';
const legacy=JSON.parse(fs.readFileSync('/etc/model-router/config.json','utf8'));
const current=JSON.parse(fs.readFileSync('/var/lib/model-router/current/config.json','utf8'));
const proxyKey=legacy.proxyKeys.find(k=>k.enabled!==false).key;
const u=legacy.upstreams.find(u=>u.enabled!==false),cu=current.upstreams.find(u=>u.enabled);
const directUrl=cu.baseUrl.replace(/\/$/,'')+'/'+cu.endpoints.generate.replace(/^\//,'');
const secrets=[proxyKey,...legacy.upstreams.flatMap(u=>u.apiKeys??[])];
const clean=s=>secrets.reduce((v,k)=>k?v.split(k).join('[REDACTED]'):v,String(s??'')).slice(0,240);
const pid=Number(execFileSync('systemctl',['show','model-router.service','-p','MainPID','--value'],{encoding:'utf8'}).trim());
const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim());
function proc(){const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');return {ticks:Number(fields[11])+Number(fields[12]),rssKiB:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)};}
const percentile=(values,p)=>{if(!values.length)return null;const v=[...values].sort((a,b)=>a-b);return Math.round(v[Math.max(0,Math.ceil(v.length*p)-1)]*100)/100;};
const report={startedAt:new Date().toISOString(),assembly:'deployed-self-hosted-systemd-real-kimi',model:'kimi-k2.6',stream:true,maxTokens:32,host:{cpus:os.cpus().length,totalMemoryMiB:Math.round(os.totalmem()/1048576),loadAtStart:os.loadavg()},artifact:JSON.parse(fs.readFileSync('.model-router-deploy-manifest.json','utf8')).commit,scope:'40 bounded real requests plus 2 warmups; local load client shares host; direct/provider timing includes internet and generation; not managed-SaaS R4/R9 acceptance',samples:[],batches:[]};
async function request(leg,index,concurrency){
 const started=performance.now();let status=null,headersMs=null,firstByteMs=null,firstTextMs=null,terminal=false,error=null,textChars=0,usage={};
 try{
 const r=await fetch(leg==='direct'?directUrl:'http://127.0.0.1:15005/v1/messages',{method:'POST',headers:{Authorization:'Bearer '+(leg==='direct'?u.apiKeys[0]:proxyKey),'Content-Type':'application/json','anthropic-version':'2023-06-01',Accept:'text/event-stream'},body:JSON.stringify({model:'kimi-k2.6',messages:[{role:'user',content:'Reply with exactly OK.'}],max_tokens:32,stream:true,thinking:{type:'disabled'}}),signal:AbortSignal.timeout(90000),redirect:'error'});
 status=r.status;headersMs=performance.now()-started;
 if(status!==200){let b;try{b=await r.json()}catch{}error=clean(b?.error?.type||b?.error?.code||'http_error');}
 else {
 let pending='';const decoder=new TextDecoder();
 const event=frame=>{for(const line of frame.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;let b;try{b=JSON.parse(data)}catch{continue;}
 if(b.type==='message_stop')terminal=true;
 if(b.type==='error')error=clean(b.error?.type||b.error?.code||'stream_error');
 if(b.message?.usage)usage={...usage,...b.message.usage};if(b.usage)usage={...usage,...b.usage};
 if(b.type==='content_block_delta'&&typeof b.delta?.text==='string'&&b.delta.text.length){firstTextMs??=performance.now()-started;textChars+=b.delta.text.length;}
 }};
 for await(const chunk of r.body){firstByteMs??=performance.now()-started;pending+=decoder.decode(chunk,{stream:true});const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop();for(const f of frames)event(f);}pending+=decoder.decode();if(pending.trim())event(pending);
 }
 }catch(e){error=clean(e.cause?.code??e.name);}
 const sample={leg,index,concurrency,status,headersMs,firstByteMs,firstTextMs,totalMs:performance.now()-started,terminal,textChars,usage,error,ok:status===200&&terminal&&textChars>0&&!error};report.samples.push(sample);return sample;
}
async function batch(leg,n,c,label){
 const initial=proc(),started=performance.now();let rssMax=initial.rssKiB,cursor=0;const timer=setInterval(()=>{rssMax=Math.max(rssMax,proc().rssKiB)},250);const samples=[];
 try{await Promise.all(Array.from({length:c},async()=>{for(;;){const i=cursor++;if(i>=n)return;samples.push(await request(leg,i,c));}}));}finally{clearInterval(timer);}
 const elapsedMs=performance.now()-started,final=proc();const ok=samples.filter(x=>x.ok);const b={label,leg,n,concurrency:c,success:ok.length,failed:n-ok.length,statuses:samples.reduce((a,s)=>{a[String(s.status)]=(a[String(s.status)]??0)+1;return a},{}),elapsedMs,throughputRps:n*1000/elapsedMs,firstByteMs:{p50:percentile(ok.map(x=>x.firstByteMs),.5),p95:percentile(ok.map(x=>x.firstByteMs),.95)},firstTextMs:{p50:percentile(ok.map(x=>x.firstTextMs),.5),p95:percentile(ok.map(x=>x.firstTextMs),.95)},totalMs:{p50:percentile(ok.map(x=>x.totalMs),.5),p95:percentile(ok.map(x=>x.totalMs),.95)},routerCpuPercent:(final.ticks-initial.ticks)/hz/(elapsedMs/1000)*100,routerRssMaxMiB:rssMax/1024,loadAfter:os.loadavg()};report.batches.push(b);fs.writeFileSync('operations/real-performance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(b));return b;
}
for(const leg of ['direct','gateway']){const warm=await request(leg,-1,1);console.log(JSON.stringify({warmup:leg,status:warm.status,ok:warm.ok,error:warm.error}));if(!warm.ok){fs.writeFileSync('operations/real-performance.json',JSON.stringify(report,null,2),{mode:0o600});process.exit(1);}}
for(const [leg,c,n] of [['direct',1,10],['gateway',1,10],['gateway',2,10],['gateway',5,10]]){const b=await batch(leg,n,c,leg+'-c'+c);if(b.failed){report.stoppedAfterFailure=true;break;}}
report.finishedAt=new Date().toISOString();report.host.loadAtEnd=os.loadavg();fs.writeFileSync('operations/real-performance.json',JSON.stringify(report,null,2),{mode:0o600});if(report.batches.some(b=>b.failed))process.exitCode=1;
NODE
