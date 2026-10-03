import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CustomerMfaError, type CustomerMfaOperations, type CustomerMfaSessionProof } from './customer-mfa-types.js';
import type { SaasIdentityRateLimiter } from './http.js';

const PREFIX = '/console/api/v1/auth/mfa';
type Route = 'status' | 'start' | 'confirm' | 'revoke';
class BoundaryError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Customer MFA request rejected.'); }
}
export interface CustomerMfaHttpOptions {
  readonly service: CustomerMfaOperations;
  readonly publicOrigin: string;
  /** Existing managed shared source limiter; DB service adds durable per-user limits. */
  readonly rateLimiter: SaasIdentityRateLimiter;
}
function record(v: unknown): v is Record<string,unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function cookie(req: IncomingMessage,name: string): string {
  const raw=req.headers.cookie;
  if(typeof raw!=='string'||raw.length>8192)throw new BoundaryError(401,'UNAUTHENTICATED');
  const parts=raw.split(';').map(p=>p.trim()).filter(p=>p.slice(0,p.indexOf('='))===name);
  if(parts.length!==1)throw new BoundaryError(401,'UNAUTHENTICATED');
  let value:string;
  try { value=decodeURIComponent((parts[0]??'').slice(name.length+1)); }
  catch {throw new BoundaryError(401,'UNAUTHENTICATED');}
  if(!/^[A-Za-z0-9_-]{16,256}$/.test(value))throw new BoundaryError(401,'UNAUTHENTICATED');
  return value;
}
function sessionProof(req:IncomingMessage):CustomerMfaSessionProof {
  const sessionToken=cookie(req,'mr_saas_session'),csrfToken=cookie(req,'mr_saas_csrf');
  const supplied=req.headers['x-csrf-token'];
  if(typeof supplied!=='string'||Buffer.byteLength(supplied)>256)throw new BoundaryError(403,'CSRF_REJECTED');
  const a=Buffer.from(supplied),b=Buffer.from(csrfToken);
  try {if(a.length!==b.length||!timingSafeEqual(a,b))throw new BoundaryError(403,'CSRF_REJECTED');}
  finally {a.fill(0);b.fill(0);}
  return {sessionToken,csrfToken,requestId:randomUUID()};
}
async function body(req:IncomingMessage,route:Exclude<Route,'status'>):Promise<Record<string,unknown>> {
  if(typeof req.headers['content-type']!=='string'||!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']))
    throw new BoundaryError(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];
  if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>4096))
    throw new BoundaryError(413,'BODY_TOO_LARGE');
  const chunks:Buffer[]=[];
  let joined:Buffer|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const read=async():Promise<unknown>=>{
      let size=0;
      for await(const chunk of req) {
        if(!(chunk instanceof Uint8Array))throw new BoundaryError(400,'INVALID_BODY');
        const copy=Buffer.from(chunk);chunks.push(copy);size+=copy.length;
        if(size>4096)throw new BoundaryError(413,'BODY_TOO_LARGE');
      }
      joined=Buffer.concat(chunks);
      try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)) as unknown;}
      catch {throw new BoundaryError(400,'INVALID_BODY');}
    };
    const value=await Promise.race([read(),new Promise<never>((_r,reject)=>{
      timer=setTimeout(()=>{req.destroy();reject(new BoundaryError(408,'BODY_TIMEOUT'));},5000);timer.unref();
    })]);
    const allowed=route==='start'?['password','currentTotpCode']:route==='confirm'
      ?['password','currentTotpCode','confirmationToken','code']:['password','code'];
    if(!record(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new BoundaryError(400,'INVALID_BODY');
    for(const key of allowed) {
      if(key==='currentTotpCode'&&!Object.hasOwn(value,key))continue;
      if(typeof value[key]!=='string'||!value[key].length||Buffer.byteLength(value[key])>(key==='password'?1024:256))
        throw new BoundaryError(400,'INVALID_BODY');
    }
    return value;
  } finally {if(timer)clearTimeout(timer);joined?.fill(0);for(const c of chunks)c.fill(0);}
}
function text(value:unknown):string {if(typeof value!=='string')throw new BoundaryError(400,'INVALID_BODY');return value;}
function reply(res:ServerResponse,status:number,requestId:string,data:unknown,errorCode?:string,cookies?:string[]):void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    ...(cookies?{'set-cookie':cookies}:{})});
  res.end(JSON.stringify(errorCode?{error:{code:errorCode,message:'The customer MFA request could not be completed.',requestId}}
    :{data,meta:{requestId}}));
}
export function createCustomerMfaHandler(options:CustomerMfaHttpOptions) {
  const url=new URL(options.publicOrigin);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'
    ||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))
    ||typeof options.rateLimiter?.take!=='function')throw new TypeError('Invalid customer MFA deployment configuration');
  const expiredCookies=['mr_saas_session=; HttpOnly','mr_saas_csrf='].map(c=>
    c+'; SameSite=Strict; Path=/console/api/v1; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'+(url.protocol==='https:'?'; Secure':''));
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const requestId=randomUUID();
    let path:URL;
    try {path=new URL(req.url??'/',url.origin);}catch{return false;}
    const route:Route|undefined=path.pathname===PREFIX?'status'
      :path.pathname===PREFIX+'/enrollment/start'?'start'
      :path.pathname===PREFIX+'/enrollment/confirm'?'confirm'
      :path.pathname===PREFIX+'/revoke'?'revoke':undefined;
    if(!route)return false;
    try {
      if(path.origin!==url.origin||path.search||path.hash)throw new BoundaryError(400,'INVALID_PATH');
      if((req.method??'GET')!==(route==='status'?'GET':'POST'))throw new BoundaryError(405,'METHOD_NOT_ALLOWED');
      if(req.headers.host!==url.host||
        (route==='status' ? req.headers.origin!==undefined&&req.headers.origin!==url.origin : req.headers.origin!==url.origin))
        throw new BoundaryError(403,'ORIGIN_REJECTED');
      let limited:number|undefined;
      try {limited=await options.rateLimiter.take(createHash('sha256').update('customer-mfa:source:v1\0')
        .update(req.socket.remoteAddress??'unknown').digest('hex'));}
      catch {throw new BoundaryError(503,'UNAVAILABLE');}
      if(limited!==undefined) {
        if(!Number.isSafeInteger(limited)||limited<1)throw new BoundaryError(503,'UNAVAILABLE');
        throw new BoundaryError(429,'RATE_LIMITED');
      }
      const proof=sessionProof(req);
      if(route==='status') {
        const value=await options.service.status(proof);reply(res,200,requestId,{enabled:value.enabled});return true;
      }
      const object=await body(req,route);
      try {
        if(route==='start') {
          const value=await options.service.start(proof,{password:text(object.password),
            ...(object.currentTotpCode===undefined?{}:{currentTotpCode:text(object.currentTotpCode)})});
          // Only authenticated enrollment returns plaintext once. No list/recovery API.
          reply(res,201,requestId,{confirmationToken:value.confirmationToken,secret:value.secret,
            otpauthUri:value.otpauthUri,expiresAt:value.expiresAt});
        } else {
          const value=route==='confirm'?await options.service.confirm(proof,{password:text(object.password),
            confirmationToken:text(object.confirmationToken),code:text(object.code),
            ...(object.currentTotpCode===undefined?{}:{currentTotpCode:text(object.currentTotpCode)})})
            :await options.service.revoke(proof,{password:text(object.password),code:text(object.code)});
          reply(res,200,requestId,{enabled:value.enabled,sessionsRevoked:value.sessionsRevoked,
            signInRequired:value.signInRequired},undefined,expiredCookies);
        }
      } finally {for(const key of Object.keys(object))object[key]=undefined;}
      return true;
    } catch(error) {
      if(!res.destroyed&&!res.writableEnded) {
        if(error instanceof BoundaryError)reply(res,error.status,requestId,null,error.code);
        else if(error instanceof CustomerMfaError)reply(res,error.status,requestId,null,error.code);
        else reply(res,503,requestId,null,'UNAVAILABLE');
      }
      return true;
    }
  };
}
