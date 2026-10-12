import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decryptCredential } from '../credentials/crypto.js';
import { SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/types.js';
import { customerMfaCredentialAad, customerMfaEnvelope, customerMfaMatchingStep } from './customer-mfa-crypto.js';
import { checkCustomerPasskeySchema } from './customer-passkey-schema-readiness.js';
import {
  type CustomerPasskeyAssertionFinishInput,
  type CustomerPasskeyAssertionStart,
  type CustomerPasskeyAssertionVerified,
  type CustomerPasskeyChanged,
  type CustomerPasskeyCode,
  CustomerPasskeyError,
  type CustomerPasskeyList,
  type CustomerPasskeyOperations,
  type CustomerPasskeyOptions,
  type CustomerPasskeyRegistrationFinishInput,
  type CustomerPasskeyRegistrationStart,
  type CustomerPasskeyRemoveInput,
  type CustomerPasskeySessionProof,
  type CustomerPasskeyStartInput,
  customerPasskeyFail,
} from './customer-passkey-types.js';
import {
  PasskeyVerificationError,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from './customer-passkey-webauthn.js';
import { verifyPassword } from './password.js';

type CeremonyKind = 'registration' | 'assertion';
type Op = 'list' | 'start-registration' | 'finish-registration' | 'start-assertion' | 'finish-assertion' | 'remove';
type Current = {
  id: string;
  user_id: string;
  password_hash: string;
  email: string;
  display_name: string | null;
  is_platform: boolean;
  now_ms: string;
};
type Ceremony = {
  id: string;
  ceremony: CeremonyKind;
  credential_id: string | null;
  password_digest: string;
  attempt_count: number;
  valid: boolean;
};
type TotpFactor = { id: string; encrypted_secret: Uint8Array; last_used_step: string | null };
type PasskeyRow = { id: string; credential_id: string; public_key: Uint8Array; sign_count: string | null };
type Preflight = { current: Current; ceremony: Ceremony | null; totp: TotpFactor | null; passkey: PasskeyRow | null };
type Material = {
  passwordMatches: boolean;
  totpSecret: string;
  registration: VerifiedRegistration | null;
  assertion: VerifiedAssertion | null;
};
type VerifiedRegistration = { credentialId: string; coseKey: Buffer; signCount: number };
type VerifiedAssertion = { signCount: number };
type Result<T> = { value: T } | { denied: CustomerPasskeyCode };

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1364}$/;
const BOUNDED_B64URL = /^[A-Za-z0-9_-]{1,5500}$/;

function proofValid(proof: CustomerPasskeySessionProof): void {
  if (
    !proof ||
    Object.keys(proof).sort().join(',') !== 'csrfToken,requestId,sessionToken' ||
    typeof proof.requestId !== 'string' ||
    !UUID.test(proof.requestId) ||
    typeof proof.sessionToken !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(proof.sessionToken) ||
    typeof proof.csrfToken !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(proof.csrfToken)
  )
    customerPasskeyFail('INVALID_INPUT');
}
function passwordValid(input: { password?: unknown }): void {
  if (typeof input.password !== 'string' || !input.password.length || Buffer.byteLength(input.password) > 1024)
    customerPasskeyFail('INVALID_INPUT');
}
function totpCodeValid(input: { currentTotpCode?: unknown }): void {
  if (
    input.currentTotpCode !== undefined &&
    (typeof input.currentTotpCode !== 'string' || !/^[0-9]{6}$/.test(input.currentTotpCode))
  )
    customerPasskeyFail('INVALID_INPUT');
}
function milliseconds(value: string): number {
  if (!/^[0-9]+$/.test(value)) return customerPasskeyFail('UNAVAILABLE');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) return customerPasskeyFail('UNAVAILABLE');
  return result;
}
function acknowledged<Row>(result: SqlResult<Row>): void {
  if (result.rowCount !== 1 || result.rows.length !== 1) customerPasskeyFail('UNAVAILABLE');
}

/**
 * Customer passkey (WebAuthn) ceremonies as a second factor, parallel to the
 * TOTP customer MFA factor. Genuine self-service, not a platform enrollment
 * facade: no runtime password/ceremony DTO is trusted, scrypt and KMS stay
 * outside PG locks, every mutation re-reads the ORIGINAL authority facts
 * after a fresh global-writer -> exclusive-user fence, and the ceremony
 * ledger (085) makes challenges single-use with DB-side transition guards.
 */
export class CustomerPasskeyService implements CustomerPasskeyOperations {
  private readonly requireUserVerification: boolean;
  constructor(
    private readonly database: SaasDatabase,
    private readonly options: CustomerPasskeyOptions,
  ) {
    if (
      !options ||
      typeof options.rpId !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{0,252}\.[a-z]{2,}$/.test(options.rpId) ||
      typeof options.rpName !== 'string' ||
      !options.rpName.trim() ||
      options.rpName.length > 120 ||
      [...options.rpName].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
      !Array.isArray(options.origins) ||
      options.origins.length === 0 ||
      options.origins.length > 8 ||
      options.origins.some(
        (origin) =>
          typeof origin !== 'string' || !/^https:\/\/[a-z0-9][a-z0-9.:-]{0,252}$/.test(origin) || origin.length > 200,
      )
    )
      customerPasskeyFail('INVALID_INPUT');
    this.requireUserVerification = options.requireUserVerification !== false;
  }
  async checkReady(): Promise<void> {
    await checkCustomerPasskeySchema(this.database);
  }
  private party() {
    return {
      rpId: this.options.rpId,
      origins: this.options.origins,
      requireUserVerification: this.requireUserVerification,
    };
  }
  private async q<Row>(tx: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    try {
      return await tx.query<Row>(sql, values);
    } catch {
      return customerPasskeyFail('UNAVAILABLE');
    }
  }
  private async tx<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (e) {
      if (e instanceof CustomerPasskeyError) throw e;
      return customerPasskeyFail('UNAVAILABLE');
    }
  }
  private async fenced(tx: SqlExecutor, proof: CustomerPasskeySessionProof): Promise<Current | null> {
    // Before ANY SELECT; not SET TRANSACTION after a lookup. No auth row locks.
    await this.q(tx, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await this.q(tx, "SELECT set_config('lock_timeout','2s',true), set_config('statement_timeout','10s',true)");
    await this.q(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    const hint = (
      await this.q<{ user_id: string }>(
        tx,
        '/* customer-passkey:hint */ SELECT user_id FROM model_router_saas.saas_sessions WHERE token_hash=$1',
        [sha(proof.sessionToken)],
      )
    ).rows[0];
    if (!hint) return null;
    if (!UUID.test(hint.user_id)) return customerPasskeyFail('UNAVAILABLE');
    await this.q(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))', [hint.user_id]);
    // Separate fresh READ COMMITTED statement AFTER waiting, same key as 046/047.
    const rows = await this.q<Current>(
      tx,
      `/* customer-passkey:current */ SELECT s.id,s.user_id,u.password_hash,
         u.email_canonical AS email,u.display_name,
         EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=u.id) AS is_platform,
         floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms
       FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.csrf_token_hash=$2 AND s.user_id=$3::uuid
         AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
         AND u.disabled_at IS NULL AND u.anonymized_at IS NULL`,
      [sha(proof.sessionToken), sha(proof.csrfToken), hint.user_id],
    );
    if (!rows.rows.length) return null;
    acknowledged(rows);
    const r = rows.rows[0];
    if (
      !r ||
      !UUID.test(r.id) ||
      !UUID.test(r.user_id) ||
      typeof r.password_hash !== 'string' ||
      r.password_hash.length > 512 ||
      typeof r.email !== 'string' ||
      r.email.length > 254 ||
      (r.display_name !== null && (typeof r.display_name !== 'string' || r.display_name.length > 120)) ||
      typeof r.is_platform !== 'boolean'
    )
      return customerPasskeyFail('UNAVAILABLE');
    milliseconds(r.now_ms);
    return r;
  }
  private async activeTotp(tx: SqlExecutor, userId: string): Promise<TotpFactor | null> {
    const rows = (
      await this.q<TotpFactor>(
        tx,
        `/* customer-passkey:totp */ SELECT c.id,c.encrypted_secret,c.last_used_step::text
       FROM model_router_saas.saas_mfa_credentials c
       WHERE c.user_id=$1::uuid AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL`,
        [userId],
      )
    ).rows;
    if (rows.length > 1) return customerPasskeyFail('MFA_STATE_CONFLICT');
    const r = rows[0];
    if (!r) return null;
    if (
      !UUID.test(r.id) ||
      !(r.encrypted_secret instanceof Uint8Array) ||
      !r.encrypted_secret.byteLength ||
      r.encrypted_secret.byteLength > 4096 ||
      (r.last_used_step !== null && !/^[0-9]+$/.test(r.last_used_step))
    )
      return customerPasskeyFail('UNAVAILABLE');
    return { ...r, encrypted_secret: Buffer.from(r.encrypted_secret) };
  }
  private async passkey(tx: SqlExecutor, userId: string, credentialId: string): Promise<PasskeyRow | null> {
    if (!CREDENTIAL_ID.test(credentialId)) return null;
    const rows = (
      await this.q<PasskeyRow>(
        tx,
        `/* customer-passkey:credential */ SELECT c.id,c.credential_id,c.public_key,c.sign_count::text
       FROM model_router_saas.saas_mfa_credentials c
       WHERE c.user_id=$1::uuid AND c.kind='passkey' AND c.credential_id=$2
         AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL`,
        [userId, credentialId],
      )
    ).rows;
    if (rows.length > 1) return customerPasskeyFail('UNAVAILABLE');
    const r = rows[0];
    if (!r) return null;
    if (
      !UUID.test(r.id) ||
      !CREDENTIAL_ID.test(r.credential_id) ||
      !(r.public_key instanceof Uint8Array) ||
      !r.public_key.byteLength ||
      r.public_key.byteLength > 4096 ||
      (r.sign_count !== null && !/^[0-9]+$/.test(r.sign_count))
    )
      return customerPasskeyFail('UNAVAILABLE');
    return { ...r, public_key: Buffer.from(r.public_key) };
  }
  private async ceremony(tx: SqlExecutor, c: Current, kind: CeremonyKind, challenge: string): Promise<Ceremony | null> {
    if (!CHALLENGE.test(challenge)) return null;
    const rows = await this.q<Ceremony>(
      tx,
      `/* customer-passkey:ceremony */ SELECT e.id,e.ceremony,e.credential_id,e.password_digest,e.attempt_count,
         (e.closed_at IS NULL AND e.consumed_at IS NULL AND e.expires_at>clock_timestamp() AND e.attempt_count<5) AS valid
       FROM model_router_saas.saas_customer_passkey_ceremonies e
       WHERE e.user_id=$1::uuid AND e.session_id=$2::uuid AND e.ceremony=$3 AND e.challenge_hash=$4`,
      [c.user_id, c.id, kind, sha(challenge)],
    );
    if (!rows.rows.length) return null;
    acknowledged(rows);
    const r = rows.rows[0];
    if (
      !r ||
      !UUID.test(r.id) ||
      r.ceremony !== kind ||
      (r.credential_id !== null && !CREDENTIAL_ID.test(r.credential_id)) ||
      !/^[0-9a-f]{64}$/.test(r.password_digest) ||
      !Number.isInteger(r.attempt_count) ||
      r.attempt_count < 0 ||
      r.attempt_count > 5 ||
      typeof r.valid !== 'boolean'
    )
      return customerPasskeyFail('UNAVAILABLE');
    return r;
  }
  private async audit(
    tx: SqlExecutor,
    proof: CustomerPasskeySessionProof,
    current: Current | null,
    action: string,
    targetType: 'customer_passkey_ceremony' | 'saas_mfa_credential',
    targetId: string | null,
  ): Promise<void> {
    acknowledged(
      await this.q(
        tx,
        `/* customer-passkey:audit */ INSERT INTO model_router_saas.saas_audit_events
        (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
       VALUES($1::uuid,NULL,$2::uuid,$3::text,$4::text,$5::text,clock_timestamp(),'customer_passkey',$6::uuid::text)
       RETURNING id`,
        [randomUUID(), current?.user_id ?? null, action, targetType, targetId, proof.requestId],
      ),
    );
  }
  private async closeOpenCeremonies(tx: SqlExecutor, userId: string, kind?: CeremonyKind): Promise<void> {
    if (kind) {
      await this.q(
        tx,
        `/* customer-passkey:close-kind */ UPDATE model_router_saas.saas_customer_passkey_ceremonies
         SET closed_at=clock_timestamp()
         WHERE user_id=$1::uuid AND ceremony=$2 AND closed_at IS NULL AND consumed_at IS NULL RETURNING id`,
        [userId, kind],
      );
      return;
    }
    await this.q(
      tx,
      `/* customer-passkey:close-all */ UPDATE model_router_saas.saas_customer_passkey_ceremonies
       SET closed_at=clock_timestamp()
       WHERE user_id=$1::uuid AND closed_at IS NULL AND consumed_at IS NULL RETURNING id`,
      [userId],
    );
  }
  private async preflight(
    proof: CustomerPasskeySessionProof,
    op: Op,
    binding: { challenge?: string; credentialId?: string },
  ): Promise<Result<Preflight>> {
    return this.tx<Result<Preflight>>(async (tx) => {
      const deny = async (code: CustomerPasskeyCode, current: Current | null): Promise<Result<Preflight>> => {
        await this.audit(tx, proof, current, `customer_passkey.${op}.denied`, 'customer_passkey_ceremony', null);
        return { denied: code };
      };
      const c = await this.fenced(tx, proof);
      if (!c) return deny('UNAUTHENTICATED', null);
      // Customer passkeys cannot touch a platform-admin credential or its sessions.
      if (c.is_platform) return deny('MFA_STATE_CONFLICT', c);
      let totp: TotpFactor | null = null;
      try {
        totp = await this.activeTotp(tx, c.user_id);
      } catch (e) {
        if (e instanceof CustomerPasskeyError) return deny(e.code, c);
        throw e;
      }
      let passkey: PasskeyRow | null = null;
      if (op === 'start-assertion' || op === 'remove') {
        passkey = await this.passkey(tx, c.user_id, binding.credentialId ?? '');
        if (!passkey) return deny('PASSKEY_NOT_FOUND', c);
      }
      let ceremony: Ceremony | null = null;
      if (op === 'finish-registration' || op === 'finish-assertion') {
        ceremony = await this.ceremony(
          tx,
          c,
          op === 'finish-registration' ? 'registration' : 'assertion',
          binding.challenge ?? '',
        );
        if (!ceremony?.valid || ceremony.password_digest !== sha(c.password_hash)) return deny('CEREMONY_INVALID', c);
        if (op === 'finish-assertion') {
          if (!ceremony.credential_id) return deny('CEREMONY_INVALID', c);
          passkey = await this.passkey(tx, c.user_id, ceremony.credential_id);
          if (!passkey) return deny('CEREMONY_INVALID', c);
        }
      }
      if (op === 'start-registration' || op === 'start-assertion') {
        const open = await this.q(
          tx,
          `/* customer-passkey:open */ SELECT id FROM model_router_saas.saas_customer_passkey_ceremonies
           WHERE user_id=$1::uuid AND ceremony=$2 AND closed_at IS NULL AND expires_at>clock_timestamp()`,
          [c.user_id, op === 'start-registration' ? 'registration' : 'assertion'],
        );
        if (open.rows.length) return deny('CEREMONY_INVALID', c);
      }
      return { value: { current: c, ceremony, totp, passkey } };
    });
  }
  private dispose(m: Material): void {
    m.totpSecret = '';
    m.registration = null;
    m.assertion = null;
    // JS strings cannot be guaranteed wiped. No persistence/logging.
  }
  private async material(
    p: Preflight,
    op: Op,
    input:
      | CustomerPasskeyRegistrationFinishInput
      | CustomerPasskeyAssertionFinishInput
      | CustomerPasskeyStartInput
      | CustomerPasskeyRemoveInput,
  ): Promise<Material> {
    const m: Material = { passwordMatches: false, totpSecret: '', registration: null, assertion: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const crossGate = op === 'start-registration' || op === 'finish-registration' || op === 'remove';
    const work = async (): Promise<Material> => {
      try {
        m.passwordMatches = await verifyPassword(input.password, p.current.password_hash);
        if (expired || !m.passwordMatches) return m;
        if (crossGate && p.totp) {
          const provider = this.options.keyProvider;
          if (!provider) return customerPasskeyFail('UNAVAILABLE');
          m.totpSecret = await decryptCredential(
            customerMfaEnvelope(p.totp.encrypted_secret),
            customerMfaCredentialAad(p.current.user_id, p.totp.id),
            provider,
          );
          if (expired) return m;
        }
        if (op === 'finish-registration' && p.ceremony) {
          const finish = input as CustomerPasskeyRegistrationFinishInput;
          m.registration = verifyPasskeyRegistration(
            {
              clientDataJSON: finish.credential.clientDataJSON,
              attestationObject: finish.credential.attestationObject,
            },
            this.party(),
            finish.challenge,
          );
          if (m.registration.credentialId !== finish.credential.id) return customerPasskeyFail('INVALID_INPUT');
        }
        if (op === 'finish-assertion' && p.ceremony && p.passkey) {
          const finish = input as CustomerPasskeyAssertionFinishInput;
          if (finish.credential.id !== p.ceremony.credential_id) return customerPasskeyFail('INVALID_INPUT');
          const expectedHandle = Buffer.from(p.current.user_id, 'utf8').toString('base64url');
          if (
            finish.credential.userHandle !== undefined &&
            finish.credential.userHandle !== null &&
            finish.credential.userHandle !== expectedHandle
          )
            return customerPasskeyFail('INVALID_INPUT');
          m.assertion = verifyPasskeyAssertion(
            {
              clientDataJSON: finish.credential.clientDataJSON,
              authenticatorData: finish.credential.authenticatorData,
              signature: finish.credential.signature,
            },
            this.party(),
            finish.challenge,
            p.passkey.public_key,
            p.passkey.sign_count === null ? null : Number(p.passkey.sign_count),
          );
        }
        return m;
      } catch (e) {
        this.dispose(m);
        if (e instanceof CustomerPasskeyError) throw e;
        if (e instanceof PasskeyVerificationError) return customerPasskeyFail('PASSKEY_REJECTED');
        return customerPasskeyFail('UNAVAILABLE');
      } finally {
        if (expired) this.dispose(m);
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            this.dispose(m);
            reject(new CustomerPasskeyError('UNAVAILABLE'));
          }, 10000);
          timer.unref();
        }),
      ]);
    } catch (e) {
      expired = true;
      this.dispose(m);
      if (e instanceof CustomerPasskeyError) throw e;
      return customerPasskeyFail('UNAVAILABLE');
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Timeout blocks any final write; late lookup is disposed, NOT cancelled KMS.
  }
  private async consumeTotp(
    tx: SqlExecutor,
    c: Current,
    totp: TotpFactor,
    secret: string,
    code: string,
  ): Promise<boolean> {
    const step = customerMfaMatchingStep(secret, code, milliseconds(c.now_ms));
    if (step === null || (totp.last_used_step !== null && BigInt(totp.last_used_step) >= BigInt(step))) return false;
    const r = await this.q(
      tx,
      `/* customer-passkey:totp-counter */ UPDATE model_router_saas.saas_mfa_credentials SET last_used_step=$3::bigint
       WHERE id=$1::uuid AND user_id=$2::uuid AND kind='totp' AND verified_at IS NOT NULL AND revoked_at IS NULL
         AND last_used_step IS NOT DISTINCT FROM $4::bigint
         AND (last_used_step IS NULL OR last_used_step<$3::bigint) RETURNING id`,
      [totp.id, c.user_id, step, totp.last_used_step],
    );
    return r.rowCount === 1 && r.rows.length === 1;
  }
  private async countAttempt(tx: SqlExecutor, ceremony: Ceremony, userId: string): Promise<Ceremony | null> {
    const rows = await this.q<{ attempt_count: number }>(
      tx,
      `/* customer-passkey:attempt */ UPDATE model_router_saas.saas_customer_passkey_ceremonies
       SET attempt_count=attempt_count+1
       WHERE id=$1::uuid AND user_id=$2::uuid AND attempt_count=$3 AND attempt_count<5
         AND closed_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp()
       RETURNING attempt_count`,
      [ceremony.id, userId, ceremony.attempt_count],
    );
    if (rows.rowCount !== 1 || rows.rows.length !== 1) return null;
    return { ...ceremony, attempt_count: rows.rows[0]?.attempt_count ?? 5 };
  }
  private async revokeSessions(tx: SqlExecutor, userId: string): Promise<number> {
    const result = await this.q(
      tx,
      `/* customer-passkey:revoke-sessions */ UPDATE model_router_saas.saas_sessions
       SET revoked_at=clock_timestamp() WHERE user_id=$1::uuid AND revoked_at IS NULL RETURNING id`,
      [userId],
    );
    if (result.rowCount !== result.rows.length || !result.rows.length) return customerPasskeyFail('UNAVAILABLE');
    return result.rows.length;
  }
  private async finish<T>(
    proof: CustomerPasskeySessionProof,
    p: Preflight,
    op: Op,
    m: Material | null,
    work: (tx: SqlExecutor, c: Current, ceremony: Ceremony | null, passkey: PasskeyRow | null) => Promise<Result<T>>,
    materialFailure?: CustomerPasskeyCode,
  ): Promise<T> {
    const result = await this.tx<Result<T>>(async (tx) => {
      let ceremony: Ceremony | null = null;
      const deny = async (code: CustomerPasskeyCode, c: Current | null): Promise<Result<T>> => {
        await this.audit(
          tx,
          proof,
          c ?? p.current,
          `customer_passkey.${op}.denied`,
          'customer_passkey_ceremony',
          ceremony?.id ?? p.ceremony?.id ?? null,
        );
        return { denied: code };
      };
      const c = await this.fenced(tx, proof);
      if (
        !c ||
        c.id !== p.current.id ||
        c.user_id !== p.current.user_id ||
        c.is_platform ||
        c.password_hash !== p.current.password_hash
      )
        return deny('AUTHORITY_CHANGED', c);
      if (op === 'finish-registration' || op === 'finish-assertion') {
        if (!p.ceremony) return deny('CEREMONY_INVALID', c);
        // Re-read by id for the CAS attempt path.
        const byId = (
          await this.q<Ceremony>(
            tx,
            `/* customer-passkey:ceremony-id */ SELECT e.id,e.ceremony,e.credential_id,e.password_digest,e.attempt_count,
             (e.closed_at IS NULL AND e.consumed_at IS NULL AND e.expires_at>clock_timestamp() AND e.attempt_count<5) AS valid
           FROM model_router_saas.saas_customer_passkey_ceremonies e
           WHERE e.id=$1::uuid AND e.user_id=$2::uuid AND e.session_id=$3::uuid`,
            [p.ceremony.id, c.user_id, c.id],
          )
        ).rows;
        const fresh = byId[0];
        if (
          !fresh?.valid ||
          fresh.id !== p.ceremony.id ||
          fresh.password_digest !== sha(c.password_hash) ||
          fresh.credential_id !== p.ceremony.credential_id
        )
          return deny('CEREMONY_INVALID', c);
        ceremony = await this.countAttempt(tx, fresh, c.user_id);
        if (!ceremony) return deny('CEREMONY_INVALID', c);
      }
      if (op === 'start-assertion' || op === 'finish-assertion' || op === 'remove') {
        const passkey = await this.passkey(tx, c.user_id, p.passkey?.credential_id ?? '');
        if (!passkey || passkey.id !== p.passkey?.id) return deny('AUTHORITY_CHANGED', c);
      }
      if (m === null) return deny(materialFailure ?? 'UNAVAILABLE', c);
      if (!m.passwordMatches) return deny('REAUTH_REQUIRED', c);
      const crossGate = op === 'start-registration' || op === 'finish-registration' || op === 'remove';
      if (crossGate && p.totp) {
        // Fresh TOTP facts: replacement/revocation since preflight flips authority.
        const totp = await this.activeTotp(tx, c.user_id);
        if (!totp || totp.id !== p.totp.id) return deny('AUTHORITY_CHANGED', c);
        const code = (m as unknown as { totpCode?: string }).totpCode;
        if (!code || !(await this.consumeTotp(tx, c, totp, m.totpSecret, code))) return deny('PASSKEY_REJECTED', c);
      }
      const result = await work(
        tx,
        c,
        ceremony,
        op === 'start-assertion' || op === 'remove' || op === 'finish-assertion' ? p.passkey : null,
      );
      if ('denied' in result) return deny(result.denied, c);
      return result;
    });
    if ('denied' in result) return customerPasskeyFail(result.denied);
    return result.value;
  }
  private async operation<T>(
    proof: CustomerPasskeySessionProof,
    op: Op,
    binding: { challenge?: string; credentialId?: string },
    input:
      | CustomerPasskeyRegistrationFinishInput
      | CustomerPasskeyAssertionFinishInput
      | CustomerPasskeyStartInput
      | CustomerPasskeyRemoveInput,
    work: (
      tx: SqlExecutor,
      c: Current,
      ceremony: Ceremony | null,
      passkey: PasskeyRow | null,
      m: Material,
    ) => Promise<Result<T>>,
  ): Promise<T> {
    const preflight = await this.preflight(proof, op, binding);
    if ('denied' in preflight) return customerPasskeyFail(preflight.denied);
    const p = preflight.value;
    let m: Material;
    try {
      m = await this.material(p, op, input);
      (m as unknown as { totpCode?: string }).totpCode = 'currentTotpCode' in input ? input.currentTotpCode : undefined;
    } catch (e) {
      // Verification/binding rejections are client-facing PASSKEY_REJECTED; the
      // bounded denial still commits in a NEW short authorization TX.
      const raw = e instanceof CustomerPasskeyError ? e.code : 'UNAVAILABLE';
      const code = raw === 'INVALID_INPUT' ? ('PASSKEY_REJECTED' as const) : raw;
      try {
        await this.finish<T>(proof, p, op, null, async () => ({ denied: code }), code);
      } finally {
        p.totp?.encrypted_secret.fill(0);
        p.passkey?.public_key.fill(0);
      }
      return customerPasskeyFail(code);
    }
    try {
      return await this.finish(proof, p, op, m, (tx, c, ceremony, passkey) => work(tx, c, ceremony, passkey, m));
    } finally {
      this.dispose(m);
      p.totp?.encrypted_secret.fill(0);
      p.passkey?.public_key.fill(0);
    }
  }

  async list(proof: CustomerPasskeySessionProof): Promise<CustomerPasskeyList> {
    proofValid(proof);
    return this.tx(async (tx) => {
      const c = await this.fenced(tx, proof);
      if (!c) return customerPasskeyFail('UNAUTHENTICATED');
      if (c.is_platform) return customerPasskeyFail('MFA_STATE_CONFLICT');
      const rows = (
        await this.q<{ credential_id: string; created_at: Date | string; verified_at: Date | string }>(
          tx,
          `/* customer-passkey:list */ SELECT c.credential_id,c.created_at,c.verified_at
         FROM model_router_saas.saas_mfa_credentials c
         WHERE c.user_id=$1::uuid AND c.kind='passkey' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
         ORDER BY c.created_at,c.credential_id`,
          [c.user_id],
        )
      ).rows;
      if (rows.length > 100) return customerPasskeyFail('UNAVAILABLE');
      const passkeys = rows.map((row) => {
        const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
        const verified = row.verified_at instanceof Date ? row.verified_at : new Date(row.verified_at);
        if (
          !CREDENTIAL_ID.test(row.credential_id) ||
          !Number.isFinite(created.getTime()) ||
          !Number.isFinite(verified.getTime())
        )
          return customerPasskeyFail('UNAVAILABLE');
        return {
          credentialId: row.credential_id,
          createdAt: created.toISOString(),
          verifiedAt: verified.toISOString(),
        };
      });
      return { passkeys };
    });
  }

  async startRegistration(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyStartInput,
  ): Promise<CustomerPasskeyRegistrationStart> {
    proofValid(proof);
    if (!input || Object.keys(input).some((k) => !['password', 'currentTotpCode'].includes(k)))
      customerPasskeyFail('INVALID_INPUT');
    passwordValid(input);
    totpCodeValid(input);
    const challenge = randomBytes(32).toString('base64url');
    const preflight = await this.preflight(proof, 'start-registration', {});
    if ('denied' in preflight) return customerPasskeyFail(preflight.denied);
    const p = preflight.value;
    let m: Material;
    try {
      m = await this.material(p, 'start-registration', input);
    } catch (e) {
      p.totp?.encrypted_secret.fill(0);
      throw e;
    }
    (m as unknown as { totpCode?: string }).totpCode = input.currentTotpCode;
    try {
      return await this.finish<CustomerPasskeyRegistrationStart>(proof, p, 'start-registration', m, async (tx, c) => {
        await this.closeOpenCeremonies(tx, c.user_id, 'registration');
        const ceremonyId = randomUUID();
        const rows = await this.q<{ expires_at: Date | string }>(
          tx,
          `/* customer-passkey:insert-ceremony */ WITH issued AS MATERIALIZED (SELECT clock_timestamp() AS at)
           INSERT INTO model_router_saas.saas_customer_passkey_ceremonies
            (id,user_id,session_id,ceremony,challenge_hash,credential_id,password_digest,created_at,expires_at)
           SELECT $1::uuid,$2::uuid,$3::uuid,'registration',$4,NULL,$5,issued.at,issued.at+interval '5 minutes' FROM issued
           RETURNING expires_at`,
          [ceremonyId, c.user_id, c.id, sha(challenge), sha(c.password_hash)],
        );
        acknowledged(rows);
        const expiry = rows.rows[0]?.expires_at;
        const date = expiry instanceof Date ? expiry : new Date(expiry ?? '');
        if (!Number.isFinite(date.getTime())) return customerPasskeyFail('UNAVAILABLE');
        await this.audit(
          tx,
          proof,
          c,
          'customer_passkey.start-registration.started',
          'customer_passkey_ceremony',
          ceremonyId,
        );
        return {
          value: {
            challenge,
            rp: { id: this.options.rpId, name: this.options.rpName },
            user: {
              id: Buffer.from(c.user_id, 'utf8').toString('base64url'),
              name: c.email,
              displayName: c.display_name ?? c.email,
            },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            timeout: 300000,
            attestation: 'none',
            authenticatorSelection: {
              residentKey: 'preferred',
              userVerification: this.requireUserVerification ? 'required' : 'discouraged',
            },
            expiresAt: date.toISOString(),
          },
        };
      });
    } finally {
      this.dispose(m);
      p.totp?.encrypted_secret.fill(0);
    }
  }

  async finishRegistration(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyRegistrationFinishInput,
  ): Promise<CustomerPasskeyChanged> {
    proofValid(proof);
    if (
      !input ||
      (Object.keys(input).sort().join(',') !== 'challenge,credential,password' &&
        Object.keys(input).sort().join(',') !== 'challenge,credential,currentTotpCode,password')
    )
      customerPasskeyFail('INVALID_INPUT');
    passwordValid(input);
    totpCodeValid(input);
    if (!CHALLENGE.test(input.challenge)) customerPasskeyFail('INVALID_INPUT');
    const cred = input.credential;
    if (
      !cred ||
      Object.keys(cred).sort().join(',') !== 'attestationObject,clientDataJSON,id' ||
      !CREDENTIAL_ID.test(cred.id) ||
      typeof cred.clientDataJSON !== 'string' ||
      !cred.clientDataJSON.length ||
      cred.clientDataJSON.length > 4096 ||
      typeof cred.attestationObject !== 'string' ||
      !BOUNDED_B64URL.test(cred.attestationObject)
    )
      customerPasskeyFail('INVALID_INPUT');
    return this.operation<CustomerPasskeyChanged>(
      proof,
      'finish-registration',
      { challenge: input.challenge },
      input,
      async (tx, c, ceremony, _passkey, m) => {
        if (!ceremony || !m.registration) return { denied: 'CEREMONY_INVALID' };
        const credentialUuid = randomUUID();
        acknowledged(
          await this.q(
            tx,
            `/* customer-passkey:insert-credential */ INSERT INTO model_router_saas.saas_mfa_credentials
            (id,user_id,kind,credential_id,public_key,encrypted_secret,sign_count,verified_at,revoked_at)
           VALUES($1::uuid,$2::uuid,'passkey',$3,$4,NULL,$5,clock_timestamp(),NULL) RETURNING id`,
            [credentialUuid, c.user_id, m.registration.credentialId, m.registration.coseKey, m.registration.signCount],
          ),
        );
        acknowledged(
          await this.q(
            tx,
            `/* customer-passkey:consume-ceremony */ UPDATE model_router_saas.saas_customer_passkey_ceremonies
           SET consumed_at=clock_timestamp(),closed_at=clock_timestamp(),credential_id=$4
           WHERE id=$1::uuid AND user_id=$2::uuid AND ceremony='registration' AND closed_at IS NULL
             AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempt_count=$3 RETURNING id`,
            [ceremony.id, c.user_id, ceremony.attempt_count, m.registration.credentialId],
          ),
        );
        await this.audit(
          tx,
          proof,
          c,
          'customer_passkey.finish-registration.completed',
          'saas_mfa_credential',
          credentialUuid,
        );
        return {
          value: {
            credentialId: m.registration.credentialId,
            sessionsRevoked: await this.revokeSessions(tx, c.user_id),
            signInRequired: true,
          },
        };
      },
    );
  }

  async startAssertion(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyStartInput,
  ): Promise<CustomerPasskeyAssertionStart> {
    proofValid(proof);
    if (!input || Object.keys(input).some((k) => !['password', 'currentTotpCode', 'credentialId'].includes(k)))
      customerPasskeyFail('INVALID_INPUT');
    passwordValid(input);
    if (input.currentTotpCode !== undefined) customerPasskeyFail('INVALID_INPUT');
    if (typeof input.credentialId !== 'string' || !CREDENTIAL_ID.test(input.credentialId))
      customerPasskeyFail('INVALID_INPUT');
    const challenge = randomBytes(32).toString('base64url');
    const preflight = await this.preflight(proof, 'start-assertion', { credentialId: input.credentialId });
    if ('denied' in preflight) return customerPasskeyFail(preflight.denied);
    const p = preflight.value;
    let m: Material;
    try {
      m = await this.material(p, 'start-assertion', input);
    } catch (e) {
      p.totp?.encrypted_secret.fill(0);
      p.passkey?.public_key.fill(0);
      throw e;
    }
    try {
      return await this.finish<CustomerPasskeyAssertionStart>(
        proof,
        p,
        'start-assertion',
        m,
        async (tx, c, _ceremony, passkey) => {
          if (!passkey) return { denied: 'PASSKEY_NOT_FOUND' };
          await this.closeOpenCeremonies(tx, c.user_id, 'assertion');
          const ceremonyId = randomUUID();
          const rows = await this.q<{ expires_at: Date | string }>(
            tx,
            `/* customer-passkey:insert-ceremony */ WITH issued AS MATERIALIZED (SELECT clock_timestamp() AS at)
           INSERT INTO model_router_saas.saas_customer_passkey_ceremonies
            (id,user_id,session_id,ceremony,challenge_hash,credential_id,password_digest,created_at,expires_at)
           SELECT $1::uuid,$2::uuid,$3::uuid,'assertion',$4,$5,$6,issued.at,issued.at+interval '5 minutes' FROM issued
           RETURNING expires_at`,
            [ceremonyId, c.user_id, c.id, sha(challenge), passkey.credential_id, sha(c.password_hash)],
          );
          acknowledged(rows);
          const expiry = rows.rows[0]?.expires_at;
          const date = expiry instanceof Date ? expiry : new Date(expiry ?? '');
          if (!Number.isFinite(date.getTime())) return customerPasskeyFail('UNAVAILABLE');
          await this.audit(
            tx,
            proof,
            c,
            'customer_passkey.start-assertion.started',
            'customer_passkey_ceremony',
            ceremonyId,
          );
          return {
            value: {
              challenge,
              rpId: this.options.rpId,
              allowCredentials: [{ type: 'public-key', id: passkey.credential_id }],
              timeout: 300000,
              userVerification: this.requireUserVerification ? 'required' : 'discouraged',
              expiresAt: date.toISOString(),
            },
          };
        },
      );
    } finally {
      this.dispose(m);
      p.totp?.encrypted_secret.fill(0);
      p.passkey?.public_key.fill(0);
    }
  }

  async finishAssertion(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyAssertionFinishInput,
  ): Promise<CustomerPasskeyAssertionVerified> {
    proofValid(proof);
    if (!input || Object.keys(input).some((k) => !['password', 'challenge', 'credential'].includes(k)))
      customerPasskeyFail('INVALID_INPUT');
    passwordValid(input);
    if (!CHALLENGE.test(input.challenge)) customerPasskeyFail('INVALID_INPUT');
    const cred = input.credential;
    if (
      !cred ||
      Object.keys(cred).some(
        (k) => !['id', 'clientDataJSON', 'authenticatorData', 'signature', 'userHandle'].includes(k),
      ) ||
      !CREDENTIAL_ID.test(cred.id) ||
      typeof cred.clientDataJSON !== 'string' ||
      !cred.clientDataJSON.length ||
      cred.clientDataJSON.length > 4096 ||
      typeof cred.authenticatorData !== 'string' ||
      !BOUNDED_B64URL.test(cred.authenticatorData) ||
      typeof cred.signature !== 'string' ||
      !BOUNDED_B64URL.test(cred.signature) ||
      (cred.userHandle !== undefined &&
        cred.userHandle !== null &&
        (typeof cred.userHandle !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cred.userHandle)))
    )
      customerPasskeyFail('INVALID_INPUT');
    return this.operation<CustomerPasskeyAssertionVerified>(
      proof,
      'finish-assertion',
      { challenge: input.challenge },
      input,
      async (tx, c, ceremony, passkey, m) => {
        if (!ceremony || !passkey || !m.assertion) return { denied: 'CEREMONY_INVALID' };
        const counter = await this.q(
          tx,
          `/* customer-passkey:counter */ UPDATE model_router_saas.saas_mfa_credentials SET sign_count=$3::bigint
           WHERE id=$1::uuid AND user_id=$2::uuid AND kind='passkey' AND verified_at IS NOT NULL AND revoked_at IS NULL
             AND sign_count IS NOT DISTINCT FROM $4::bigint RETURNING id`,
          [passkey.id, c.user_id, m.assertion.signCount, passkey.sign_count],
        );
        if (counter.rowCount !== 1) return { denied: 'AUTHORITY_CHANGED' };
        acknowledged(
          await this.q(
            tx,
            `/* customer-passkey:consume-ceremony */ UPDATE model_router_saas.saas_customer_passkey_ceremonies
           SET consumed_at=clock_timestamp(),closed_at=clock_timestamp()
           WHERE id=$1::uuid AND user_id=$2::uuid AND ceremony='assertion' AND closed_at IS NULL
             AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempt_count=$3 RETURNING id`,
            [ceremony.id, c.user_id, ceremony.attempt_count],
          ),
        );
        await this.audit(
          tx,
          proof,
          c,
          'customer_passkey.finish-assertion.completed',
          'saas_mfa_credential',
          passkey.id,
        );
        return { value: { verified: true, credentialId: passkey.credential_id } };
      },
    );
  }

  async remove(proof: CustomerPasskeySessionProof, input: CustomerPasskeyRemoveInput): Promise<CustomerPasskeyChanged> {
    proofValid(proof);
    if (!input || Object.keys(input).some((k) => !['password', 'currentTotpCode', 'credentialId'].includes(k)))
      customerPasskeyFail('INVALID_INPUT');
    passwordValid(input);
    totpCodeValid(input);
    if (typeof input.credentialId !== 'string' || !CREDENTIAL_ID.test(input.credentialId))
      customerPasskeyFail('INVALID_INPUT');
    return this.operation<CustomerPasskeyChanged>(
      proof,
      'remove',
      { credentialId: input.credentialId },
      input,
      async (tx, c, _ceremony, passkey) => {
        if (!passkey) return { denied: 'PASSKEY_NOT_FOUND' };
        const revoked = await this.q(
          tx,
          `/* customer-passkey:revoke */ UPDATE model_router_saas.saas_mfa_credentials SET revoked_at=clock_timestamp()
           WHERE id=$1::uuid AND user_id=$2::uuid AND kind='passkey' AND verified_at IS NOT NULL AND revoked_at IS NULL
           RETURNING id`,
          [passkey.id, c.user_id],
        );
        if (revoked.rowCount !== 1) return { denied: 'AUTHORITY_CHANGED' };
        await this.closeOpenCeremonies(tx, c.user_id);
        await this.audit(tx, proof, c, 'customer_passkey.remove.completed', 'saas_mfa_credential', passkey.id);
        return {
          value: {
            credentialId: passkey.credential_id,
            sessionsRevoked: await this.revokeSessions(tx, c.user_id),
            signInRequired: true,
          },
        };
      },
    );
  }
}
