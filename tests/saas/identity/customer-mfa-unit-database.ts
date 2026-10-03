import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { CredentialKeyProvider } from '../../../src/saas/credentials/crypto.js';
import { hashPassword } from '../../../src/saas/identity/password.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { CustomerMfaSessionProof } from '../../../src/saas/identity/customer-mfa-types.js';

export const TEST_PASSWORD='synthetic-customer-password-not-a-real-key';
type Credential={id:string;user_id:string;encrypted_secret:Uint8Array;verified:boolean;revoked:boolean;last_used_step:string|null};
type Enrollment={id:string;user_id:string;session_id:string;credential_id:string;previous_credential_id:string|null;
  token_hash:string;password_digest:string;attempt_count:number;expires_at:number;closed:boolean;locked:boolean;consumed:boolean};
type Command={id:string;user_id:string;session_id:string;operation:string;expires_at:number;outcome:string|null};
type Session={id:string;user_id:string;token_hash:string;csrf_token_hash:string;revoked:boolean};
type State={passwordHash:string;disabled:boolean;platform:boolean;now:number;budget:number;
  sessions:Session[];credentials:Credential[];enrollments:Enrollment[];commands:Command[];
  events:Array<readonly unknown[]>;audits:Array<readonly unknown[]>;outbox:Array<readonly unknown[]>};
function string(v:unknown):string {if(typeof v!=='string')throw new Error('Unit SQL input contract');return v;}
function number(v:unknown):number {if(typeof v!=='number')throw new Error('Unit SQL input contract');return v;}
/** UNIT SQL adapter only. No native role/capability proof is inferred from it.
 * Real password, envelope and TOTP implementations are NEVER mocked.
 */
export class CustomerMfaUnitDatabase implements SaasDatabase {
  readonly userId=randomUUID();
  state:State;
  depth=0;
  trace:Array<{tag:string;tx:boolean;values:readonly unknown[]}>= [];
  failTag:string|undefined;
  failOutcome:string|undefined;
  private tail:Promise<void>=Promise.resolve();
  private constructor(passwordHash:string) {
    this.state={passwordHash,disabled:false,platform:false,now:Date.UTC(2026,9,3,12,0,5),budget:0,
      sessions:[],credentials:[],enrollments:[],commands:[],events:[],audits:[],outbox:[]};
  }
  static async create() {return new CustomerMfaUnitDatabase(await hashPassword(TEST_PASSWORD));}
  async session():Promise<CustomerMfaSessionProof> {
    const login=await new SaasIdentityService(this,{now:()=>new Date(this.state.now)}).login({
      email:'synthetic-customer@example.test',password:TEST_PASSWORD,ttlSeconds:1800});
    if(!login||login.session.userId!==this.userId)throw new Error('Unit identity login contract');
    return {sessionToken:login.token,csrfToken:login.csrfToken,requestId:randomUUID()};
  }
  next(p:CustomerMfaSessionProof):CustomerMfaSessionProof {return {...p,requestId:randomUUID()};}
  async transaction<T>(work:(tx:SqlExecutor)=>Promise<T>):Promise<T> {
    let release:()=>void=()=>{};
    const gate=new Promise<void>(r=>{release=r;});
    const prior=this.tail;this.tail=gate;await prior;
    const before=structuredClone(this.state);
    this.depth++;
    try {return await work(this);}catch(e){this.state=before;throw e;}
    finally {this.depth--;release();}
  }
  async migrate(){throw new Error('Unit adapter cannot migrate');}
  async verifySchema(){throw new Error('Unit adapter cannot verify native schema');}
  async ping(){throw new Error('Unit adapter cannot probe native database');}
  async close(){}
  async query<Row>(sql:string,args:readonly unknown[]=[]):Promise<SqlResult<Row>> {
    const tag=/customer-mfa:([a-z-]+)/.exec(sql)?.[1]??(sql.startsWith('SET ')?'isolation':sql.includes('set_config')?'timeouts'
      :sql.includes('pg_advisory_xact_lock(1396788563')?'writer':sql.includes('pg_advisory_xact_lock')?'user'
      :sql.includes('FROM saas_users WHERE email_canonical')?'identity-user'
      :sql.includes('SELECT id FROM saas_users')?'identity-authority'
      :sql.includes('INSERT INTO saas_sessions')?'identity-session':'unsupported');
    this.trace.push({tag,tx:this.depth>0,values:[...args]});
    if(tag===this.failTag&&(!this.failOutcome||this.state.events.at(-1)?.[6]===this.failOutcome))
      throw new Error('synthetic sensitive database detail MUST NOT SURFACE');
    const [a,b,c,d,e,f,g,h,i]=args;
    let rows:unknown[]=[];
    const session=this.state.sessions.find(x=>x.token_hash===a);
    const credential=this.state.credentials.find(x=>x.id===a&&x.user_id===b);
    const enrollment=this.state.enrollments.find(x=>x.id===a&&x.user_id===b);
    const active=(user:unknown)=>this.state.credentials.filter(x=>x.user_id===user&&x.verified&&!x.revoked);
    switch(tag) {
      case 'isolation':case 'timeouts':case 'writer':case 'user':break;
      case 'identity-user':rows=a==='synthetic-customer@example.test'?[{id:this.userId,email:a,
        display_name:'Synthetic customer',password_hash:this.state.passwordHash,disabled_at:this.state.disabled?'disabled':null,
        email_verified_at:null,created_at:new Date(this.state.now)}]:[];break;
      case 'identity-authority':rows=a===this.userId&&b==='synthetic-customer@example.test'
        &&c===this.state.passwordHash&&!this.state.disabled?[{id:a}]:[];break;
      case 'identity-session':this.state.sessions.push({id:string(a),user_id:string(b),token_hash:string(c),
        csrf_token_hash:string(d),revoked:false});break;
      case 'hint':rows=session?[{user_id:session.user_id}]:[];break;
      case 'current':rows=session&&!session.revoked&&!this.state.disabled&&session.csrf_token_hash===b&&session.user_id===c
        ?[{id:session.id,user_id:session.user_id,csrf_token_hash:session.csrf_token_hash,password_hash:this.state.passwordHash,
          email:'synthetic-customer@example.test',is_platform:this.state.platform,now_ms:String(this.state.now)}]:[];break;
      case 'active':rows=active(a).map(x=>({...x,customer_owned:this.state.enrollments.some(e=>e.credential_id===x.id&&e.consumed)}));break;
      case 'enrollment':{
        const row=this.state.enrollments.find(x=>x.user_id===a&&x.session_id===b&&x.token_hash===c);
        const cred=this.state.credentials.find(x=>x.id===row?.credential_id);
        if(row&&cred)rows=[{...row,encrypted_secret:cred.encrypted_secret,
          valid:!row.closed&&!row.locked&&!row.consumed&&row.expires_at>this.state.now
            &&row.attempt_count<5&&!cred.verified&&!cred.revoked}];
        break;
      }
      case 'budget':this.state.budget=Math.min(21,this.state.budget+1);rows=[{attempts:this.state.budget}];break;
      case 'pending':rows=this.state.enrollments.filter(x=>x.user_id===a&&!x.closed&&
        (!sql.includes('expires_at>')||x.expires_at>this.state.now)).map(x=>({id:x.id}));break;
      case 'command':this.state.commands.push({id:string(a),user_id:string(b),session_id:string(c),
        operation:string(d),expires_at:this.state.now+30000,outcome:null});rows=[{id:a}];break;
      case 'command-current':rows=this.state.commands.filter(x=>x.id===a&&x.user_id===b&&x.session_id===c&&x.operation===d)
        .map(x=>({valid:x.outcome===null&&x.expires_at>this.state.now}));break;
      case 'finish-command':{
        const cmd=this.state.commands.find(x=>x.id===a&&x.outcome===null);
        if(cmd){cmd.outcome=b===undefined?'denied':string(b);rows=[{id:a}];}break;
      }
      case 'audit':this.state.audits.push([...args]);rows=[{id:a}];break;
      case 'event':this.state.events.push([a,b,c,d,e,f,g,h,i]);rows=[{id:a}];break;
      case 'outbox':this.state.outbox.push([...args]);rows=[{event_id:a}];break;
      case 'insert-credential':
        if(!(c instanceof Uint8Array))throw new Error('Unit ciphertext contract');
        this.state.credentials.push({id:string(a),user_id:string(b),encrypted_secret:Buffer.from(c),verified:false,revoked:false,last_used_step:null});
        rows=[{id:a}];break;
      case 'insert-enrollment':this.state.enrollments.push({id:string(a),user_id:string(b),session_id:string(c),
        credential_id:string(d),previous_credential_id:e===null?null:string(e),token_hash:string(f),password_digest:string(g),
        attempt_count:0,expires_at:this.state.now+300000,closed:false,locked:false,consumed:false});
        rows=[{expires_at:new Date(this.state.now+300000)}];break;
      case 'expire':for(const row of this.state.enrollments)if(row.user_id===a&&!row.closed&&row.expires_at<=this.state.now){
        row.closed=true;rows.push({credential_id:row.credential_id});}break;
      case 'close-pending':for(const row of this.state.enrollments)if(row.user_id===a&&!row.closed){
        row.closed=true;rows.push({credential_id:row.credential_id});}break;
      case 'expire-credential':case 'lock-credential':
        if(credential&&!credential.verified&&!credential.revoked){credential.revoked=true;rows=[{id:a}];}break;
      case 'attempt':if(enrollment&&!enrollment.closed&&!enrollment.locked&&!enrollment.consumed
        &&enrollment.attempt_count===c&&enrollment.attempt_count<5&&enrollment.expires_at>this.state.now){
          enrollment.attempt_count++;rows=[{attempt_count:enrollment.attempt_count}];}break;
      case 'lock':if(enrollment&&enrollment.attempt_count===5&&!enrollment.closed){
        enrollment.locked=true;enrollment.closed=true;rows=[{id:a}];}break;
      case 'counter':if(credential&&credential.verified&&!credential.revoked&&credential.last_used_step===d
        &&(d===null||BigInt(string(d))<BigInt(string(c)))){
          credential.last_used_step=string(c);rows=[{id:a}];}break;
      case 'verify':if(credential&&!credential.verified&&!credential.revoked){
        credential.verified=true;credential.last_used_step=string(c);rows=[{id:a}];}break;
      case 'revoke-active':if(credential&&credential.verified&&!credential.revoked){
        credential.revoked=true;rows=[{id:a}];}break;
      case 'consume-enrollment':if(enrollment&&!enrollment.closed&&!enrollment.consumed
        &&enrollment.attempt_count===number(c)&&enrollment.expires_at>this.state.now){
          enrollment.closed=true;enrollment.consumed=true;rows=[{id:a}];}break;
      case 'revoke-sessions':for(const s of this.state.sessions)if(s.user_id===a&&!s.revoked){
        s.revoked=true;rows.push({id:s.id});}break;
      default:throw new Error('Unsupported customer MFA unit SQL');
    }
    // The ONLY generic cast is this test-owned SQL driver's row boundary,
    // equivalent to pg.query<Row>; it never casts a business proof or result.
    return {rows:structuredClone(rows) as Row[],rowCount:rows.length};
  }
}
export class CustomerMfaUnitKeys implements CredentialKeyProvider {
  calls=0;
  beforeLookup:(()=>void|Promise<void>)|undefined;
  fail=false;
  constructor(readonly db:CustomerMfaUnitDatabase,readonly key=Buffer.alloc(32,73)){}
  async getCurrentKey(){await this.lookup();return {keyId:'customer-mfa-unit-only',key:Buffer.from(this.key)};}
  async getKey(id:string){await this.lookup();return id==='customer-mfa-unit-only'?Buffer.from(this.key):undefined;}
  private async lookup(){
    if(this.db.depth!==0)throw new Error('Key lookup occurred while holding a DB transaction');
    this.calls++;await this.beforeLookup?.();
    if(this.fail)throw new Error('synthetic sensitive KMS detail MUST NOT SURFACE');
  }
}
