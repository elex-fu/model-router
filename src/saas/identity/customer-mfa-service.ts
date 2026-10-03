import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decryptCredential, encryptCredential } from '../credentials/crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/types.js';
import { SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL } from '../db/advisory-lock-keys.js';
import { verifyPassword } from './password.js';
import { encodeBase32, totpUri } from '../platform/auth/totp.js';
import { customerMfaCredentialAad, customerMfaEnvelope, customerMfaMatchingStep } from './customer-mfa-crypto.js';
import { checkCustomerMfaSchema } from './customer-mfa-schema-readiness.js';
import { CustomerMfaError, customerMfaFail, type CustomerMfaCode, type CustomerMfaOperations,
  type CustomerMfaOptions, type CustomerMfaSessionProof, type CustomerMfaStartInput,
  type CustomerMfaConfirmInput, type CustomerMfaRevokeInput, type CustomerMfaEnrollment,
  type CustomerMfaChanged, type CustomerMfaStatus } from './customer-mfa-types.js';

type Op = 'start' | 'confirm' | 'revoke';
type Outcome = 'authorized' | 'started' | 'confirmed' | 'revoked' | 'denied';
type Current = { id: string; user_id: string; csrf_token_hash: string; password_hash: string;
  email: string; is_platform: boolean; now_ms: string };
type Credential = { id: string; user_id: string; encrypted_secret: Uint8Array;
  last_used_step: string | null; customer_owned: boolean };
type Enrollment = { id: string; session_id: string; credential_id: string; previous_credential_id: string | null;
  password_digest: string; encrypted_secret: Uint8Array; attempt_count: number; valid: boolean };
type Preflight = { commandId: string; current: Current; active: Credential | null; setup: Enrollment | null };
type Material = { passwordMatches: boolean; currentSecret: string; pendingSecret: string;
  encrypted: Buffer | null; credentialId: string; token: string };
type Result<T> = { value: T } | { denied: CustomerMfaCode };

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function proofValid(proof: CustomerMfaSessionProof): void {
  if (!proof || Object.keys(proof).sort().join(',') !== 'csrfToken,requestId,sessionToken'
    || typeof proof.requestId !== 'string' || !UUID.test(proof.requestId)
    || typeof proof.sessionToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(proof.sessionToken)
    || typeof proof.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(proof.csrfToken)) customerMfaFail('INVALID_INPUT');
}
function inputValid(input: CustomerMfaStartInput, op: Op): void {
  const allowed = op === 'confirm' ? ['password', 'currentTotpCode', 'confirmationToken', 'code']
    : op === 'revoke' ? ['password', 'code'] : ['password', 'currentTotpCode'];
  if (!input || Object.keys(input).some(k => !allowed.includes(k))
    || typeof input.password !== 'string' || !input.password.length || Buffer.byteLength(input.password) > 1024)
    customerMfaFail('INVALID_INPUT');
}
function milliseconds(value: string): number {
  if (!/^[0-9]+$/.test(value)) return customerMfaFail('UNAVAILABLE');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) return customerMfaFail('UNAVAILABLE');
  return result;
}
function acknowledged<Row>(result: SqlResult<Row>): void {
  if (result.rowCount !== 1 || result.rows.length !== 1) customerMfaFail('UNAVAILABLE');
}

/** Genuine customer self-service, not a platform enrollment facade.
 * No runtime password/approval DTO is trusted. Each public mutation performs
 * actual scrypt outside PG locks, then checks the ORIGINAL hash after a fresh
 * global-writer -> exclusive-user fence. KMS is entirely outside short TXs.
 */
export class CustomerMfaService implements CustomerMfaOperations {
  constructor(private readonly database: SaasDatabase, private readonly options: CustomerMfaOptions) {
    if (!options || typeof options.issuer !== 'string' || !options.issuer.trim()
      || options.issuer.length > 120 || /[\x00-\x1f\x7f]/.test(options.issuer)) customerMfaFail('INVALID_INPUT');
  }
  async checkReady():Promise<void> { await checkCustomerMfaSchema(this.database); }
  private async q<Row>(tx: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    try { return await tx.query<Row>(sql, values); } catch { return customerMfaFail('UNAVAILABLE'); }
  }
  private async tx<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(work); }
    catch (e) { if (e instanceof CustomerMfaError) throw e; return customerMfaFail('UNAVAILABLE'); }
  }
  private async fenced(tx: SqlExecutor, proof: CustomerMfaSessionProof): Promise<Current | null> {
    // Before ANY SELECT; not SET TRANSACTION after a lookup. No auth row locks.
    await this.q(tx, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await this.q(tx, "SELECT set_config('lock_timeout','2s',true), set_config('statement_timeout','10s',true)");
    await this.q(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    const hint = (await this.q<{ user_id: string }>(tx,
      '/* customer-mfa:hint */ SELECT user_id FROM model_router_saas.saas_sessions WHERE token_hash=$1',
      [sha(proof.sessionToken)])).rows[0];
    if (!hint) return null;
    if (!UUID.test(hint.user_id)) return customerMfaFail('UNAVAILABLE');
    await this.q(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))', [hint.user_id]);
    // Separate fresh READ COMMITTED statement AFTER waiting, same key as046/047.
    const rows = await this.q<Current>(tx,
      `/* customer-mfa:current */ SELECT s.id,s.user_id,s.csrf_token_hash,u.password_hash,
         u.email_canonical AS email,
         EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=u.id) AS is_platform,
         floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms
       FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.csrf_token_hash=$2 AND s.user_id=$3::uuid
         AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
         AND u.disabled_at IS NULL AND u.anonymized_at IS NULL`,
      [sha(proof.sessionToken), sha(proof.csrfToken), hint.user_id]);
    if (!rows.rows.length) return null;
    acknowledged(rows);
    const r = rows.rows[0];
    if (!r || !UUID.test(r.id) || !UUID.test(r.user_id) || typeof r.password_hash !== 'string'
      || r.password_hash.length > 512 || typeof r.email !== 'string' || r.email.length > 254
      || typeof r.is_platform !== 'boolean') return customerMfaFail('UNAVAILABLE');
    milliseconds(r.now_ms);
    return r;
  }
  private async active(tx: SqlExecutor, userId: string): Promise<Credential | null> {
    const rows = (await this.q<Credential>(tx,
      `/* customer-mfa:active */ SELECT c.id,c.user_id,c.encrypted_secret,c.last_used_step::text,
         EXISTS(SELECT 1 FROM model_router_saas.saas_customer_mfa_enrollments e
           WHERE e.user_id=c.user_id AND e.credential_id=c.id AND e.consumed_at IS NOT NULL) AS customer_owned
       FROM model_router_saas.saas_mfa_credentials c
       WHERE c.user_id=$1::uuid AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL`,
      [userId])).rows;
    if (rows.length > 1) return customerMfaFail('MFA_STATE_CONFLICT');
    const r = rows[0];
    if (!r) return null;
    if (r.customer_owned !== true) return customerMfaFail('MFA_STATE_CONFLICT');
    if (!UUID.test(r.id) || !(r.encrypted_secret instanceof Uint8Array)
      || !r.encrypted_secret.byteLength || r.encrypted_secret.byteLength > 4096
      || (r.last_used_step !== null && !/^[0-9]+$/.test(r.last_used_step))) return customerMfaFail('UNAVAILABLE');
    return { ...r, encrypted_secret: Buffer.from(r.encrypted_secret) };
  }
  private async enrollment(tx: SqlExecutor, c: Current, token: string): Promise<Enrollment | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const rows = await this.q<Enrollment>(tx,
      `/* customer-mfa:enrollment */ SELECT e.id,e.session_id,e.credential_id,e.previous_credential_id,
         e.password_digest,e.attempt_count,c.encrypted_secret,
         (e.consumed_at IS NULL AND e.closed_at IS NULL AND e.locked_at IS NULL
           AND e.expires_at>clock_timestamp() AND e.attempt_count<5
           AND c.kind='totp' AND c.verified_at IS NULL AND c.revoked_at IS NULL) AS valid
       FROM model_router_saas.saas_customer_mfa_enrollments e
       JOIN model_router_saas.saas_mfa_credentials c ON c.id=e.credential_id AND c.user_id=e.user_id
       WHERE e.user_id=$1::uuid AND e.session_id=$2::uuid AND e.token_hash=$3`,
      [c.user_id, c.id, sha(token)]);
    if (!rows.rows.length) return null;
    acknowledged(rows);
    const r = rows.rows[0];
    if (!r || !UUID.test(r.id) || !UUID.test(r.credential_id)
      || !(r.encrypted_secret instanceof Uint8Array) || r.encrypted_secret.byteLength > 4096
      || !Number.isInteger(r.attempt_count) || r.attempt_count < 0 || r.attempt_count > 5
      || typeof r.valid !== 'boolean') return customerMfaFail('UNAVAILABLE');
    return { ...r, encrypted_secret: Buffer.from(r.encrypted_secret) };
  }
  private async event(tx: SqlExecutor, proof: CustomerMfaSessionProof, op: Op,
    current: Current | null, commandId: string | null, outcome: Outcome, reason: CustomerMfaCode | null): Promise<void> {
    const eventId = randomUUID(), auditId = randomUUID();
    acknowledged(await this.q(tx,
      `/* customer-mfa:audit */ INSERT INTO model_router_saas.saas_audit_events
        (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
       VALUES($1::uuid,NULL,$2::uuid,$3::text,'customer_mfa_command',$4::text,clock_timestamp(),'customer_mfa',$5::uuid::text)
       RETURNING id`, [auditId, current?.user_id ?? null, 'customer_mfa.' + op + '.' + outcome,
        commandId, proof.requestId]));
    acknowledged(await this.q(tx,
      `/* customer-mfa:event */ INSERT INTO model_router_saas.saas_customer_mfa_events
        (id,audit_id,command_id,user_id,session_id,operation,outcome,reason_code,request_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::text,$8::text,$9::uuid) RETURNING id`,
      [eventId,auditId,commandId,current?.user_id ?? null,current?.id ?? null,op,outcome,reason,proof.requestId]));
    acknowledged(await this.q(tx,
      `/* customer-mfa:outbox */ INSERT INTO model_router_saas.saas_customer_mfa_outbox(event_id)
       VALUES($1::uuid) RETURNING event_id`, [eventId]));
  }
  private async unwrap<T>(result: Result<T>): Promise<T> {
    if ('denied' in result) return customerMfaFail(result.denied);
    return result.value;
  }
  private async preflight(proof: CustomerMfaSessionProof, op: Op, token?: string): Promise<Preflight> {
    return this.unwrap(await this.tx<Result<Preflight>>(async tx => {
      const c = await this.fenced(tx, proof);
      const deny = async (code: CustomerMfaCode): Promise<Result<Preflight>> => {
        await this.event(tx, proof, op, c, null, 'denied', code); return { denied: code };
      };
      if (!c) return deny('UNAUTHENTICATED');
      // Customer MFA cannot replace a platform-admin credential or its sessions.
      if (c.is_platform) return deny('MFA_STATE_CONFLICT');
      const budget = await this.q<{ attempts: number }>(tx,
        `/* customer-mfa:budget */ INSERT INTO model_router_saas.saas_customer_mfa_rate_windows
          (user_id,window_started_at,attempts) VALUES($1::uuid,clock_timestamp(),1)
         ON CONFLICT(user_id) DO UPDATE SET
           window_started_at=CASE WHEN saas_customer_mfa_rate_windows.window_started_at<=clock_timestamp()-interval '15 minutes'
             THEN clock_timestamp() ELSE saas_customer_mfa_rate_windows.window_started_at END,
           attempts=CASE WHEN saas_customer_mfa_rate_windows.window_started_at<=clock_timestamp()-interval '15 minutes'
             THEN 1 ELSE least(21,saas_customer_mfa_rate_windows.attempts+1) END
         RETURNING attempts`, [c.user_id]);
      acknowledged(budget);
      if ((budget.rows[0]?.attempts ?? 21) > 20) return deny('RATE_LIMITED');
      let active: Credential | null;
      try { active = await this.active(tx, c.user_id); }
      catch (e) { if (e instanceof CustomerMfaError && e.code === 'MFA_STATE_CONFLICT') return deny(e.code); throw e; }
      let setup: Enrollment | null = null;
      if (op === 'confirm') {
        setup = await this.enrollment(tx, c, token ?? '');
        if (!setup?.valid || setup.password_digest !== sha(c.password_hash)) return deny('ENROLLMENT_INVALID');
      }
      if (op === 'revoke' && !active) return deny('MFA_STATE_CONFLICT');
      if (op === 'start') {
        const pending = await this.q(tx,
          `/* customer-mfa:pending */ SELECT id FROM model_router_saas.saas_customer_mfa_enrollments
           WHERE user_id=$1::uuid AND closed_at IS NULL AND expires_at>clock_timestamp()`, [c.user_id]);
        if (pending.rows.length) return deny('ENROLLMENT_PENDING');
      }
      const commandId = randomUUID();
      acknowledged(await this.q(tx,
        `/* customer-mfa:command */ WITH issued AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO model_router_saas.saas_customer_mfa_commands
          (id,user_id,session_id,operation,request_id,created_at,expires_at)
         SELECT $1::uuid,$2::uuid,$3::uuid,$4::text,$5::uuid,issued.at,
           least(issued.at+interval '30 seconds',s.expires_at)
         FROM issued JOIN model_router_saas.saas_sessions s ON s.id=$3::uuid AND s.user_id=$2::uuid
         WHERE s.revoked_at IS NULL AND s.expires_at>issued.at RETURNING id`,
        [commandId,c.user_id,c.id,op,proof.requestId]));
      await this.event(tx,proof,op,c,commandId,'authorized',null);
      return { value: { commandId,current:c,active,setup } };
    }));
  }
  private dispose(m: Material): void {
    m.currentSecret = ''; m.pendingSecret = ''; m.token = ''; m.encrypted?.fill(0); m.encrypted = null;
    // JS strings/password/otpauth/Headers cannot be guaranteed wiped. No persistence/logging.
  }
  private async material(p: Preflight, input: CustomerMfaStartInput, op: Op): Promise<Material> {
    const m: Material = { passwordMatches:false,currentSecret:'',pendingSecret:'',encrypted:null,
      credentialId:randomUUID(),token:'' };
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    const work = async (): Promise<Material> => {
      try {
        m.passwordMatches = await verifyPassword(input.password, p.current.password_hash);
        if (expired || !m.passwordMatches) return m;
        const provider = this.options.keyProvider;
        if (!provider) return customerMfaFail('UNAVAILABLE');
        if (p.active) {
          m.currentSecret = await decryptCredential(customerMfaEnvelope(p.active.encrypted_secret),
            customerMfaCredentialAad(p.current.user_id,p.active.id),provider);
          if (expired) return m;
        }
        if (op === 'confirm' && p.setup) {
          m.pendingSecret = await decryptCredential(customerMfaEnvelope(p.setup.encrypted_secret),
            customerMfaCredentialAad(p.current.user_id,p.setup.credential_id),provider);
        } else if (op === 'start') {
          const raw = randomBytes(20);
          try { m.pendingSecret = encodeBase32(raw); } finally { raw.fill(0); }
          m.token = randomBytes(32).toString('base64url');
          const encrypted = await encryptCredential(m.pendingSecret,
            customerMfaCredentialAad(p.current.user_id,m.credentialId),provider);
          m.encrypted = Buffer.from(JSON.stringify(encrypted),'utf8');
          if (m.encrypted.length > 4096) return customerMfaFail('UNAVAILABLE');
        }
        return m;
      } catch { this.dispose(m); return customerMfaFail('UNAVAILABLE'); }
      finally { if (expired) this.dispose(m); }
    };
    try {
      return await Promise.race([work(), new Promise<never>((_resolve,reject) => {
        timer = setTimeout(() => { expired = true; this.dispose(m); reject(new CustomerMfaError('UNAVAILABLE')); },10000);
        timer.unref();
      })]);
    } catch { expired = true; this.dispose(m); return customerMfaFail('UNAVAILABLE'); }
    finally { if (timer) clearTimeout(timer); }
    // Timeout blocks any final write; late lookup is disposed, NOT cancelled KMS.
  }
  private async consumeCurrent(tx: SqlExecutor, c: Current, active: Credential, secret: string, code: string): Promise<boolean> {
    const step = customerMfaMatchingStep(secret,code,milliseconds(c.now_ms));
    if (step === null || (active.last_used_step !== null && BigInt(active.last_used_step) >= BigInt(step))) return false;
    const r = await this.q(tx,
      `/* customer-mfa:counter */ UPDATE model_router_saas.saas_mfa_credentials SET last_used_step=$3::bigint
       WHERE id=$1::uuid AND user_id=$2::uuid AND kind='totp' AND verified_at IS NOT NULL AND revoked_at IS NULL
         AND last_used_step IS NOT DISTINCT FROM $4::bigint
         AND (last_used_step IS NULL OR last_used_step<$3::bigint) RETURNING id`,
      [active.id,c.user_id,step,active.last_used_step]);
    return r.rowCount === 1 && r.rows.length === 1;
  }
  private async expirePending(tx: SqlExecutor, userId: string): Promise<void> {
    const rows = await this.q<{ credential_id: string }>(tx,
      `/* customer-mfa:expire */ UPDATE model_router_saas.saas_customer_mfa_enrollments
       SET closed_at=clock_timestamp() WHERE user_id=$1::uuid AND closed_at IS NULL
         AND expires_at<=clock_timestamp() RETURNING credential_id`, [userId]);
    for (const row of rows.rows) {
      acknowledged(await this.q(tx,
        `/* customer-mfa:expire-credential */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
         WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NULL AND revoked_at IS NULL RETURNING id`,
        [row.credential_id,userId]));
    }
  }
  private async countConfirmation(tx: SqlExecutor, setup: Enrollment, userId: string): Promise<Enrollment | null> {
    const rows = await this.q<{ attempt_count: number }>(tx,
      `/* customer-mfa:attempt */ UPDATE model_router_saas.saas_customer_mfa_enrollments
       SET attempt_count=attempt_count+1
       WHERE id=$1::uuid AND user_id=$2::uuid AND attempt_count=$3 AND attempt_count<5
         AND closed_at IS NULL AND locked_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp()
       RETURNING attempt_count`, [setup.id,userId,setup.attempt_count]);
    if (rows.rowCount !== 1 || rows.rows.length !== 1) return null;
    return { ...setup, attempt_count: rows.rows[0]?.attempt_count ?? 5 };
  }
  private async lockFailedSetup(tx: SqlExecutor, setup: Enrollment | null, c: Current): Promise<void> {
    if (!setup || setup.attempt_count < 5) return;
    acknowledged(await this.q(tx,
      `/* customer-mfa:lock */ UPDATE model_router_saas.saas_customer_mfa_enrollments
       SET locked_at=clock_timestamp(),closed_at=clock_timestamp()
       WHERE id=$1::uuid AND user_id=$2::uuid AND attempt_count=5 AND closed_at IS NULL RETURNING id`,
      [setup.id,c.user_id]));
    acknowledged(await this.q(tx,
      `/* customer-mfa:lock-credential */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
       WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [setup.credential_id,c.user_id]));
  }
  private async finish<T>(proof: CustomerMfaSessionProof,p: Preflight,op: Op,m: Material,
    work: (tx: SqlExecutor,c: Current,active: Credential | null,setup: Enrollment | null) => Promise<Result<T>>,
    materialFailure?: 'UNAVAILABLE'): Promise<T> {
    const result = await this.tx<Result<T>>(async tx => {
      const c = await this.fenced(tx,proof);
      let setup: Enrollment | null = null;
      const deny = async (code: CustomerMfaCode): Promise<Result<T>> => {
        if (c) await this.lockFailedSetup(tx,setup,c);
        acknowledged(await this.q(tx,
          `/* customer-mfa:finish-command */ UPDATE model_router_saas.saas_customer_mfa_commands
           SET completed_at=clock_timestamp(),outcome='denied'
           WHERE id=$1::uuid AND completed_at IS NULL RETURNING id`, [p.commandId]));
        await this.event(tx,proof,op,c ?? p.current,p.commandId,'denied',code);
        return { denied: code };
      };
      const command = await this.q<{ valid: boolean }>(tx,
        `/* customer-mfa:command-current */ SELECT (completed_at IS NULL AND expires_at>clock_timestamp()) AS valid
         FROM model_router_saas.saas_customer_mfa_commands
         WHERE id=$1::uuid AND user_id=$2::uuid AND session_id=$3::uuid AND operation=$4::text`,
        [p.commandId,p.current.user_id,p.current.id,op]);
      if (!c || c.id !== p.current.id || c.user_id !== p.current.user_id || c.is_platform
        || c.password_hash !== p.current.password_hash || command.rows.length !== 1 || command.rows[0]?.valid !== true)
        return deny('AUTHORITY_CHANGED');
      let active: Credential | null;
      try { active = await this.active(tx,c.user_id); }
      catch (e) { if (e instanceof CustomerMfaError && e.code === 'MFA_STATE_CONFLICT') return deny('AUTHORITY_CHANGED'); throw e; }
      if (active?.id !== p.active?.id || (active && p.active && sha(active.encrypted_secret) !== sha(p.active.encrypted_secret)))
        return deny('AUTHORITY_CHANGED');
      if (op === 'confirm') {
        setup = await this.enrollment(tx,c,m.token);
        if (!setup?.valid || !p.setup || setup.id !== p.setup.id || setup.password_digest !== sha(c.password_hash)
          || sha(setup.encrypted_secret) !== sha(p.setup.encrypted_secret)
          || setup.previous_credential_id !== (active?.id ?? null)) return deny('ENROLLMENT_INVALID');
        setup = await this.countConfirmation(tx,setup,c.user_id);
        if (!setup) return deny('ENROLLMENT_INVALID');
      }
      if (materialFailure) return deny(materialFailure);
      if (!m.passwordMatches) return deny('REAUTH_REQUIRED');
      const result = await work(tx,c,active,setup);
      if ('denied' in result) return deny(result.denied);
      acknowledged(await this.q(tx,
        `/* customer-mfa:finish-command */ UPDATE model_router_saas.saas_customer_mfa_commands
         SET completed_at=clock_timestamp(),outcome=$2::text
         WHERE id=$1::uuid AND completed_at IS NULL RETURNING id`,
        [p.commandId,op === 'start' ? 'started' : op === 'confirm' ? 'confirmed' : 'revoked']));
      await this.event(tx,proof,op,c,p.commandId,op === 'start' ? 'started' : op === 'confirm' ? 'confirmed' : 'revoked',null);
      return result;
    });
    return this.unwrap(result);
  }
  private async operation<T>(proof: CustomerMfaSessionProof,input: CustomerMfaStartInput,op: Op,token: string | undefined,
    work: (tx: SqlExecutor,c: Current,active: Credential | null,setup: Enrollment | null,m: Material) => Promise<Result<T>>): Promise<T> {
    proofValid(proof); inputValid(input,op);
    const p = await this.preflight(proof,op,token);
    let m: Material;
    try { m = await this.material(p,input,op); }
    catch {
      // Failed/timeout key lookup produces no enrollment; commit bounded denial
      // in a NEW short authorization TX, never claim cancellation of the KMS call.
      const denied: Material = { passwordMatches:false,currentSecret:'',pendingSecret:'',encrypted:null,credentialId:'',token:token ?? '' };
      try {
        await this.finish<T>(proof,p,op,denied,async () => ({ denied: 'UNAVAILABLE' }),'UNAVAILABLE');
        return customerMfaFail('UNAVAILABLE');
      } finally { this.dispose(denied); p.active?.encrypted_secret.fill(0); p.setup?.encrypted_secret.fill(0); }
    }
    if (op === 'confirm') m.token = token ?? '';
    try { return await this.finish(proof,p,op,m,(tx,c,a,e) => work(tx,c,a,e,m)); }
    finally { this.dispose(m); p.active?.encrypted_secret.fill(0); p.setup?.encrypted_secret.fill(0); }
  }
  async status(proof: CustomerMfaSessionProof): Promise<CustomerMfaStatus> {
    proofValid(proof);
    return this.tx(async tx => {
      const c = await this.fenced(tx,proof);
      if (!c) return customerMfaFail('UNAUTHENTICATED');
      if (c.is_platform) return customerMfaFail('MFA_STATE_CONFLICT');
      const active = await this.active(tx,c.user_id);
      try { return { enabled: active !== null }; } finally { active?.encrypted_secret.fill(0); }
    });
  }
  async start(proof: CustomerMfaSessionProof,input: CustomerMfaStartInput): Promise<CustomerMfaEnrollment> {
    return this.operation<CustomerMfaEnrollment>(proof,input,'start',undefined,async (tx,c,active,_setup,m) => {
      if (active && !await this.consumeCurrent(tx,c,active,m.currentSecret,input.currentTotpCode ?? ''))
        return { denied:'MFA_CODE_REJECTED' };
      await this.expirePending(tx,c.user_id);
      const pending = await this.q(tx,
        `/* customer-mfa:pending */ SELECT id FROM model_router_saas.saas_customer_mfa_enrollments
         WHERE user_id=$1::uuid AND closed_at IS NULL`, [c.user_id]);
      if (pending.rows.length) return { denied:'ENROLLMENT_PENDING' };
      if (!m.encrypted || !m.pendingSecret || !m.token) return customerMfaFail('UNAVAILABLE');
      acknowledged(await this.q(tx,
        `/* customer-mfa:insert-credential */ INSERT INTO model_router_saas.saas_mfa_credentials
          (id,user_id,kind,encrypted_secret,verified_at,revoked_at)
         VALUES($1::uuid,$2::uuid,'totp',$3,NULL,NULL) RETURNING id`, [m.credentialId,c.user_id,m.encrypted]));
      const rows = await this.q<{ expires_at: Date | string }>(tx,
        `/* customer-mfa:insert-enrollment */ WITH issued AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO model_router_saas.saas_customer_mfa_enrollments
          (id,user_id,session_id,credential_id,previous_credential_id,token_hash,password_digest,created_at,expires_at)
         SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::text,issued.at,issued.at+interval '5 minutes' FROM issued
         RETURNING expires_at`, [randomUUID(),c.user_id,c.id,m.credentialId,active?.id ?? null,sha(m.token),sha(c.password_hash)]);
      acknowledged(rows);
      const expiry = rows.rows[0]?.expires_at;
      const date = expiry instanceof Date ? expiry : new Date(expiry ?? '');
      if (!Number.isFinite(date.getTime())) return customerMfaFail('UNAVAILABLE');
      return { value: { confirmationToken:m.token,secret:m.pendingSecret,
        otpauthUri:totpUri(m.pendingSecret,this.options.issuer,c.email),expiresAt:date.toISOString() } };
    });
  }
  private async revokeSessions(tx: SqlExecutor,userId: string): Promise<number> {
    const result = await this.q(tx,
      `/* customer-mfa:revoke-sessions */ UPDATE model_router_saas.saas_sessions
       SET revoked_at=clock_timestamp() WHERE user_id=$1::uuid AND revoked_at IS NULL RETURNING id`, [userId]);
    if (result.rowCount !== result.rows.length || !result.rows.length) return customerMfaFail('UNAVAILABLE');
    // Finance-purpose authenticate/current re-read these exact rows AND the
    // revoked credential under the SAME user fence. No fabricated purpose epoch.
    return result.rows.length;
  }
  async confirm(proof: CustomerMfaSessionProof,input: CustomerMfaConfirmInput): Promise<CustomerMfaChanged> {
    return this.operation<CustomerMfaChanged>(proof,input,'confirm',input.confirmationToken,async (tx,c,active,setup,m) => {
      if (!setup) return { denied:'ENROLLMENT_INVALID' };
      const step = customerMfaMatchingStep(m.pendingSecret,input.code,milliseconds(c.now_ms));
      if (step === null) return { denied:'MFA_CODE_REJECTED' };
      if (active && !await this.consumeCurrent(tx,c,active,m.currentSecret,input.currentTotpCode ?? ''))
        return { denied:'MFA_CODE_REJECTED' };
      if (active) acknowledged(await this.q(tx,
        `/* customer-mfa:revoke-active */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
         WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NOT NULL AND revoked_at IS NULL RETURNING id`,
        [active.id,c.user_id]));
      acknowledged(await this.q(tx,
        `/* customer-mfa:verify */ UPDATE model_router_saas.saas_mfa_credentials
         SET verified_at=clock_timestamp(),last_used_step=$3::bigint
         WHERE id=$1::uuid AND user_id=$2::uuid AND kind='totp'
           AND verified_at IS NULL AND revoked_at IS NULL RETURNING id`, [setup.credential_id,c.user_id,step]));
      acknowledged(await this.q(tx,
        `/* customer-mfa:consume-enrollment */ UPDATE model_router_saas.saas_customer_mfa_enrollments
         SET consumed_at=clock_timestamp(),closed_at=clock_timestamp()
         WHERE id=$1::uuid AND user_id=$2::uuid AND closed_at IS NULL AND expires_at>clock_timestamp()
           AND attempt_count=$3 AND consumed_at IS NULL RETURNING id`, [setup.id,c.user_id,setup.attempt_count]));
      return { value: { enabled:true,sessionsRevoked:await this.revokeSessions(tx,c.user_id),signInRequired:true } };
    });
  }
  async revoke(proof: CustomerMfaSessionProof,input: CustomerMfaRevokeInput): Promise<CustomerMfaChanged> {
    return this.operation<CustomerMfaChanged>(proof,input,'revoke',undefined,async (tx,c,active,_setup,m) => {
      if (!active || !await this.consumeCurrent(tx,c,active,m.currentSecret,input.code)) return { denied:'MFA_CODE_REJECTED' };
      acknowledged(await this.q(tx,
        `/* customer-mfa:revoke-active */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
         WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NOT NULL AND revoked_at IS NULL RETURNING id`,
        [active.id,c.user_id]));
      const pending = await this.q<{ credential_id: string }>(tx,
        `/* customer-mfa:close-pending */ UPDATE model_router_saas.saas_customer_mfa_enrollments
         SET closed_at=clock_timestamp() WHERE user_id=$1::uuid AND closed_at IS NULL RETURNING credential_id`, [c.user_id]);
      for (const e of pending.rows) acknowledged(await this.q(tx,
        `/* customer-mfa:expire-credential */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
         WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NULL AND revoked_at IS NULL RETURNING id`, [e.credential_id,c.user_id]));
      return { value: { enabled:false,sessionsRevoked:await this.revokeSessions(tx,c.user_id),signInRequired:true } };
    });
  }
}
