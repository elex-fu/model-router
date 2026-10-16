import { randomUUID } from 'node:crypto';
import type { CredentialKeyProvider } from '../../../src/saas/credentials/crypto.js';
import { encryptCredential } from '../../../src/saas/credentials/crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { customerMfaCredentialAad } from '../../../src/saas/identity/customer-mfa-crypto.js';
import type { CustomerPasskeySessionProof } from '../../../src/saas/identity/customer-passkey-types.js';
import { hashPassword } from '../../../src/saas/identity/password.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';

export const PASSKEY_TEST_PASSWORD = 'synthetic-customer-password-not-a-real-key';
type Credential = {
  id: string;
  user_id: string;
  kind: 'totp' | 'passkey';
  credential_id: string | null;
  public_key: Uint8Array | null;
  encrypted_secret: Uint8Array | null;
  sign_count: string | null;
  last_used_step: string | null;
  verified: boolean;
  revoked: boolean;
  created_at: string;
};
type Ceremony = {
  id: string;
  user_id: string;
  session_id: string;
  ceremony: 'registration' | 'assertion';
  challenge_hash: string;
  credential_id: string | null;
  password_digest: string;
  attempt_count: number;
  expires_at: number;
  consumed: boolean;
  closed: boolean;
};
type Session = {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  revoked: boolean;
  created_at: string;
  expires_at: string;
};
type State = {
  passwordHash: string;
  disabled: boolean;
  platform: boolean;
  now: number;
  sessions: Session[];
  credentials: Credential[];
  ceremonies: Ceremony[];
  audits: Array<readonly unknown[]>;
};
function string(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Unit SQL input contract');
  return v;
}
function number(v: unknown): number {
  if (typeof v !== 'number') throw new Error('Unit SQL input contract');
  return v;
}

/** UNIT SQL adapter only. No native role/capability proof is inferred from it.
 * Real password, envelope, TOTP and WebAuthn implementations are NEVER mocked.
 */
export class CustomerPasskeyUnitDatabase implements SaasDatabase {
  readonly userId = randomUUID();
  state: State;
  depth = 0;
  trace: Array<{ tag: string; tx: boolean; values: readonly unknown[] }> = [];
  failTag: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private constructor(passwordHash: string) {
    this.state = {
      passwordHash,
      disabled: false,
      platform: false,
      now: Date.UTC(2026, 9, 10, 12, 0, 5),
      sessions: [],
      credentials: [],
      ceremonies: [],
      audits: [],
    };
  }
  static async create() {
    return new CustomerPasskeyUnitDatabase(await hashPassword(PASSKEY_TEST_PASSWORD));
  }
  async session(): Promise<CustomerPasskeySessionProof> {
    const login = await new SaasIdentityService(this, { now: () => new Date(this.state.now) }).login({
      email: 'synthetic-customer@example.test',
      password: PASSKEY_TEST_PASSWORD,
      ttlSeconds: 1800,
    });
    if (!login || login.session.userId !== this.userId) throw new Error('Unit identity login contract');
    return { sessionToken: login.token, csrfToken: login.csrfToken, requestId: randomUUID() };
  }
  next(p: CustomerPasskeySessionProof): CustomerPasskeySessionProof {
    return { ...p, requestId: randomUUID() };
  }
  /** Seeds a REAL TOTP factor (encrypted with the unit KMS key) for cross-gate tests. */
  async seedTotp(secret: string, keys: CredentialKeyProvider): Promise<void> {
    const id = randomUUID();
    const envelope = await encryptCredential(secret, customerMfaCredentialAad(this.userId, id), keys);
    this.state.credentials.push({
      id,
      user_id: this.userId,
      kind: 'totp',
      credential_id: null,
      public_key: null,
      encrypted_secret: Buffer.from(JSON.stringify(envelope), 'utf8'),
      sign_count: null,
      last_used_step: null,
      verified: true,
      revoked: false,
      created_at: new Date(this.state.now).toISOString(),
    });
  }
  passkeys(): Credential[] {
    return this.state.credentials.filter((x) => x.kind === 'passkey' && x.verified && !x.revoked);
  }
  auditActions(): string[] {
    return this.state.audits.map((row) => string(row[2]));
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prior = this.tail;
    this.tail = gate;
    await prior;
    const before = structuredClone(this.state);
    this.depth++;
    try {
      return await work(this);
    } catch (e) {
      this.state = before;
      throw e;
    } finally {
      this.depth--;
      release();
    }
  }
  async migrate() {
    throw new Error('Unit adapter cannot migrate');
  }
  async verifySchema() {
    throw new Error('Unit adapter cannot verify native schema');
  }
  async ping() {
    throw new Error('Unit adapter cannot probe native database');
  }
  async close() {}
  async query<Row>(sql: string, args: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const tag =
      /customer-passkey:([a-z-]+)/.exec(sql)?.[1] ??
      (sql.startsWith('SET ')
        ? 'isolation'
        : sql.includes('set_config')
          ? 'timeouts'
          : sql.includes('pg_advisory_xact_lock(1396788563')
            ? 'writer'
            : sql.includes('pg_advisory_xact_lock')
              ? 'user'
              : sql.includes('FROM saas_users WHERE email_canonical')
                ? 'identity-user'
                : sql.includes('SELECT id FROM saas_users')
                  ? 'identity-authority'
                  : sql.includes('INSERT INTO saas_sessions')
                    ? 'identity-session'
                    : sql.includes('SELECT s.user_id, s.expires_at, s.created_at')
                      ? 'identity-session-read'
                      : sql.includes('SELECT s.csrf_token_hash FROM saas_sessions')
                        ? 'identity-csrf-read'
                        : 'unsupported');
    this.trace.push({ tag, tx: this.depth > 0, values: [...args] });
    if (tag === this.failTag) throw new Error('synthetic sensitive database detail MUST NOT SURFACE');
    const [a, b, c, d] = args;
    let rows: unknown[] = [];
    const session = this.state.sessions.find((x) => x.token_hash === a);
    const credential = this.state.credentials.find((x) => x.id === a && x.user_id === b);
    const ceremony = this.state.ceremonies.find((x) => x.id === a && x.user_id === b);
    switch (tag) {
      case 'isolation':
      case 'timeouts':
      case 'writer':
      case 'user':
        break;
      case 'identity-user':
        rows =
          a === 'synthetic-customer@example.test'
            ? [
                {
                  id: this.userId,
                  email: a,
                  display_name: 'Synthetic customer',
                  password_hash: this.state.passwordHash,
                  disabled_at: this.state.disabled ? 'disabled' : null,
                  email_verified_at: null,
                  created_at: new Date(this.state.now),
                },
              ]
            : [];
        break;
      case 'identity-authority':
        rows =
          a === this.userId &&
          b === 'synthetic-customer@example.test' &&
          c === this.state.passwordHash &&
          !this.state.disabled
            ? [{ id: a }]
            : [];
        break;
      case 'identity-session':
        this.state.sessions.push({
          id: string(a),
          user_id: string(b),
          token_hash: string(c),
          csrf_token_hash: string(d),
          revoked: false,
          created_at: string(args[4]),
          expires_at: string(args[5]),
        });
        break;
      case 'identity-session-read':
      case 'identity-csrf-read':
        if (
          session &&
          !session.revoked &&
          !this.state.disabled &&
          Date.parse(session.expires_at) > Date.parse(string(b))
        ) {
          rows =
            tag === 'identity-csrf-read'
              ? [{ csrf_token_hash: session.csrf_token_hash }]
              : [{ user_id: session.user_id, created_at: session.created_at, expires_at: session.expires_at }];
        }
        break;
      case 'hint':
        rows = session ? [{ user_id: session.user_id }] : [];
        break;
      case 'current':
        rows =
          session && !session.revoked && !this.state.disabled && session.csrf_token_hash === b && session.user_id === c
            ? [
                {
                  id: session.id,
                  user_id: session.user_id,
                  password_hash: this.state.passwordHash,
                  email: 'synthetic-customer@example.test',
                  display_name: 'Synthetic customer',
                  is_platform: this.state.platform,
                  now_ms: String(this.state.now),
                },
              ]
            : [];
        break;
      case 'totp':
        rows = this.state.credentials
          .filter((x) => x.user_id === a && x.kind === 'totp' && x.verified && !x.revoked)
          .map((x) => ({ id: x.id, encrypted_secret: x.encrypted_secret, last_used_step: x.last_used_step }));
        break;
      case 'credential':
        rows = this.state.credentials
          .filter((x) => x.user_id === a && x.kind === 'passkey' && x.credential_id === b && x.verified && !x.revoked)
          .map((x) => ({
            id: x.id,
            credential_id: x.credential_id,
            public_key: x.public_key,
            sign_count: x.sign_count,
          }));
        break;
      case 'ceremony': {
        const row = this.state.ceremonies.find(
          (x) => x.user_id === a && x.session_id === b && x.ceremony === c && x.challenge_hash === d,
        );
        if (row)
          rows = [
            {
              id: row.id,
              ceremony: row.ceremony,
              credential_id: row.credential_id,
              password_digest: row.password_digest,
              attempt_count: row.attempt_count,
              valid: !row.closed && !row.consumed && row.expires_at > this.state.now && row.attempt_count < 5,
            },
          ];
        break;
      }
      case 'ceremony-id':
        if (ceremony && ceremony.session_id === c)
          rows = [
            {
              id: ceremony.id,
              ceremony: ceremony.ceremony,
              credential_id: ceremony.credential_id,
              password_digest: ceremony.password_digest,
              attempt_count: ceremony.attempt_count,
              valid:
                !ceremony.closed &&
                !ceremony.consumed &&
                ceremony.expires_at > this.state.now &&
                ceremony.attempt_count < 5,
            },
          ];
        break;
      case 'open':
        rows = this.state.ceremonies
          .filter((x) => x.user_id === a && x.ceremony === b && !x.closed && x.expires_at > this.state.now)
          .map((x) => ({ id: x.id }));
        break;
      case 'close-kind':
        for (const row of this.state.ceremonies)
          if (row.user_id === a && row.ceremony === b && !row.closed && !row.consumed) {
            row.closed = true;
            rows.push({ id: row.id });
          }
        break;
      case 'close-all':
        for (const row of this.state.ceremonies)
          if (row.user_id === a && !row.closed && !row.consumed) {
            row.closed = true;
            rows.push({ id: row.id });
          }
        break;
      case 'audit':
        this.state.audits.push([...args]);
        rows = [{ id: a }];
        break;
      case 'insert-ceremony': {
        // Registration inlines credential_id NULL (5 values); assertion binds it (6).
        const assertion = args.length === 6;
        this.state.ceremonies.push({
          id: string(a),
          user_id: string(b),
          session_id: string(c),
          ceremony: assertion ? 'assertion' : 'registration',
          challenge_hash: string(d),
          credential_id: assertion ? string(args[4]) : null,
          password_digest: string(assertion ? args[5] : args[4]),
          attempt_count: 0,
          expires_at: this.state.now + 300000,
          consumed: false,
          closed: false,
        });
        rows = [{ expires_at: new Date(this.state.now + 300000) }];
        break;
      }
      case 'insert-credential': {
        if (!(args[3] instanceof Uint8Array)) throw new Error('Unit public key contract');
        this.state.credentials.push({
          id: string(a),
          user_id: string(b),
          kind: 'passkey',
          credential_id: string(c),
          public_key: Buffer.from(args[3] as Uint8Array),
          encrypted_secret: null,
          sign_count: args[4] === undefined || args[4] === null ? null : String(args[4] as unknown),
          last_used_step: null,
          verified: true,
          revoked: false,
          created_at: new Date(this.state.now).toISOString(),
        });
        rows = [{ id: a }];
        break;
      }
      case 'consume-ceremony':
        if (
          ceremony &&
          !ceremony.closed &&
          !ceremony.consumed &&
          ceremony.attempt_count === number(c) &&
          ceremony.expires_at > this.state.now
        ) {
          ceremony.closed = true;
          ceremony.consumed = true;
          if (args[3] !== undefined && ceremony.ceremony === 'registration') ceremony.credential_id = string(args[3]);
          rows = [{ id: a }];
        }
        break;
      case 'attempt':
        if (
          ceremony &&
          !ceremony.closed &&
          !ceremony.consumed &&
          ceremony.attempt_count === c &&
          ceremony.attempt_count < 5 &&
          ceremony.expires_at > this.state.now
        ) {
          ceremony.attempt_count++;
          rows = [{ attempt_count: ceremony.attempt_count }];
        }
        break;
      case 'totp-counter':
        if (
          credential &&
          credential.kind === 'totp' &&
          credential.verified &&
          !credential.revoked &&
          credential.last_used_step === d &&
          (d === null || BigInt(string(d)) < BigInt(string(c)))
        ) {
          credential.last_used_step = string(c);
          rows = [{ id: a }];
        }
        break;
      case 'counter':
        if (
          credential &&
          credential.kind === 'passkey' &&
          credential.verified &&
          !credential.revoked &&
          credential.sign_count === d
        ) {
          credential.sign_count = typeof c === 'number' ? String(c) : string(c);
          rows = [{ id: a }];
        }
        break;
      case 'revoke':
        if (credential && credential.kind === 'passkey' && credential.verified && !credential.revoked) {
          credential.revoked = true;
          rows = [{ id: a }];
        }
        break;
      case 'revoke-sessions':
        for (const s of this.state.sessions)
          if (s.user_id === a && !s.revoked) {
            s.revoked = true;
            rows.push({ id: s.id });
          }
        break;
      case 'list':
        rows = this.state.credentials
          .filter((x) => x.user_id === a && x.kind === 'passkey' && x.verified && !x.revoked)
          .map((x) => ({
            credential_id: x.credential_id,
            created_at: new Date(x.created_at),
            verified_at: new Date(x.created_at),
          }));
        break;
      default:
        throw new Error('Unsupported customer passkey unit SQL');
    }
    // The ONLY generic cast is this test-owned SQL driver's row boundary,
    // equivalent to pg.query<Row>; it never casts a business proof or result.
    return { rows: structuredClone(rows) as Row[], rowCount: rows.length };
  }
}
export class CustomerPasskeyUnitKeys implements CredentialKeyProvider {
  calls = 0;
  beforeLookup: (() => void | Promise<void>) | undefined;
  fail = false;
  constructor(
    readonly db: CustomerPasskeyUnitDatabase,
    readonly key = Buffer.alloc(32, 74),
  ) {}
  async getCurrentKey() {
    await this.lookup();
    return { keyId: 'customer-passkey-unit-only', key: Buffer.from(this.key) };
  }
  async getKey(id: string) {
    await this.lookup();
    return id === 'customer-passkey-unit-only' ? Buffer.from(this.key) : undefined;
  }
  private async lookup() {
    if (this.db.depth !== 0) throw new Error('Key lookup occurred while holding a DB transaction');
    this.calls++;
    await this.beforeLookup?.();
    if (this.fail) throw new Error('synthetic sensitive KMS detail MUST NOT SURFACE');
  }
}
