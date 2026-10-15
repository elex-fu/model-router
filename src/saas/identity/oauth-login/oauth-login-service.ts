import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { hashPassword as hashPasswordValue } from '../password.js';
import { createOidcProvider } from './oidc-provider.js';
import {
  type OAuthAdoptionInput,
  type OAuthFetch,
  type OAuthIdentity,
  type OAuthIdentityDirectory,
  type OAuthLoginCompletion,
  type OAuthLoginConfig,
  OAuthLoginError,
  type OAuthLoginProvider,
  type OAuthLoginSession,
  type OAuthLoginStart,
  type OAuthProviderClient,
  type OAuthRegistrationInput,
  oauthLoginFail,
} from './types.js';
import { createWechatProvider } from './wechat-provider.js';

const STATE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 5 * 60_000;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PENDING_ENTRIES = 10_000;
const MAX_STATE_ENTRIES = 10_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StateEntry {
  readonly key: string;
  readonly provider: OAuthLoginProvider;
  readonly redirectUri: string;
  readonly expiresAtMs: number;
}

interface PendingEntry {
  readonly key: string;
  readonly providerIdentity: OAuthIdentity;
  readonly email: string | undefined;
  readonly expiresAtMs: number;
}

/** Bounded insert-ordered expiring store; prune runs at most once per TTL window. */
class ExpiringStore<Entry extends { key: string; expiresAtMs: number }> {
  private readonly entries = new Map<string, Entry>();
  private nextPruneAt = 0;

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  private prune(now: number): void {
    if (now < this.nextPruneAt && this.entries.size <= this.limit) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(key);
    }
    this.nextPruneAt = now + this.ttlMs;
  }

  put(key: string, values: Omit<Entry, 'key' | 'expiresAtMs'>): void {
    const now = this.now();
    this.prune(now);
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { ...values, key, expiresAtMs: now + this.ttlMs } as Entry);
  }

  /** Constant-time single-use take: the stored key is compared with timingSafeEqual. */
  take(key: string): Entry | undefined {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) return undefined;
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const expected = Buffer.from(entry.key, 'utf8');
    const supplied = Buffer.from(key, 'utf8');
    const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
    if (!matches || entry.expiresAtMs <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    return entry;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
}

function validateRedirectUri(redirectUri: string): string {
  if (typeof redirectUri !== 'string' || redirectUri.length === 0 || redirectUri.length > 2048) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return oauthLoginFail(400, 'INVALID_INPUT');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
  return parsed.toString();
}

function normalizeProviderEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  if (typeof email !== 'string' || email.length > 254) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  const normalized = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Deterministic placeholder address for providers that expose no email
 * (WeChat). The `.invalid` TLD guarantees it can never collide with a real
 * provider address; the subject half is unique per (provider, subject).
 */
function synthesizedEmail(identity: OAuthIdentity): string {
  const subject = identity.providerSubject.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '');
  const local = `${subject || 'subject'}-${sha256(`${identity.providerType}:${identity.providerSubject}`).slice(0, 12)}`;
  return `${local}@oauth.${identity.providerType}.invalid`;
}

export interface OAuthLoginServiceOptions {
  readonly database: SaasDatabase;
  readonly identity: OAuthIdentityDirectory;
  readonly config: OAuthLoginConfig;
  readonly sessionTtlSeconds: number;
  readonly now?: () => Date;
  readonly fetch?: OAuthFetch;
}

interface BindingRow {
  user_id: string;
  disabled_at: string | null;
}

/**
 * sub2api parity Phase 2 social login orchestration: state-protected provider
 * redirects, the three-way binding decision (login / adoption / registration),
 * single-use 5-minute pending tokens, and session issuance through the
 * injected identity directory. Binding rows live in tenant_oauth_identities
 * (migration 101); state and pending tokens are process-local, single-use,
 * and short-lived by design.
 */
export class OAuthLoginService {
  private readonly now: () => Date;
  private readonly providers: Map<OAuthLoginProvider, OAuthProviderClient>;
  private readonly states: ExpiringStore<StateEntry>;
  private readonly pending: ExpiringStore<PendingEntry>;

  constructor(private readonly options: OAuthLoginServiceOptions) {
    if (
      !Number.isSafeInteger(options.sessionTtlSeconds) ||
      options.sessionTtlSeconds < 1 ||
      options.sessionTtlSeconds > MAX_SESSION_TTL_SECONDS
    ) {
      throw new TypeError('sessionTtlSeconds must be an integer from 1 to 2592000');
    }
    this.now = options.now ?? (() => new Date());
    const nowMs = () => this.now().getTime();
    this.states = new ExpiringStore<StateEntry>(MAX_STATE_ENTRIES, STATE_TTL_MS, nowMs);
    this.pending = new ExpiringStore<PendingEntry>(MAX_PENDING_ENTRIES, PENDING_TTL_MS, nowMs);

    const fetchImpl =
      options.fetch ??
      ((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => fetch(url, init));
    this.providers = new Map();
    if (options.config?.oidc !== undefined) {
      this.providers.set('oidc', createOidcProvider(options.config.oidc, { fetch: fetchImpl, now: nowMs }));
    }
    if (options.config?.wechat !== undefined) {
      this.providers.set('wechat', createWechatProvider(options.config.wechat, { fetch: fetchImpl }));
    }
    if (this.providers.size === 0) throw new TypeError('OAuthLoginConfig must enable at least one provider');
  }

  private client(provider: OAuthLoginProvider): OAuthProviderClient {
    if (provider !== 'oidc' && provider !== 'wechat') oauthLoginFail(400, 'PROVIDER_UNKNOWN');
    const client = this.providers.get(provider);
    if (!client) oauthLoginFail(400, 'PROVIDER_UNKNOWN');
    return client;
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
    uniqueCode: 'IDENTITY_CONFLICT' | 'EMAIL_ALREADY_EXISTS' = 'IDENTITY_CONFLICT',
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    try {
      return await executor.query<Row>(sql, values);
    } catch (error) {
      if (error instanceof OAuthLoginError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new OAuthLoginError(409, uniqueCode);
      }
      throw new OAuthLoginError(503, 'UNAVAILABLE');
    }
  }

  /** Begin a provider redirect: returns the authorize URL and the opaque state. */
  async startLogin(provider: OAuthLoginProvider, redirectUri: string): Promise<OAuthLoginStart> {
    const client = this.client(provider);
    const uri = validateRedirectUri(redirectUri);
    const state = randomBytes(32).toString('base64url');
    this.states.put(sha256(state), {
      provider,
      redirectUri: uri,
    });
    return { authorizeUrl: await client.authorizeUrl({ redirectUri: uri, state }), state };
  }

  /**
   * Complete a provider redirect. Constant-time, single-use, 10-minute state;
   * then the three-way decision: bound identity -> session, provider email
   * owned by an existing account -> adoption pending, otherwise registration
   * pending (5-minute single-use token).
   */
  async completeLogin(
    provider: OAuthLoginProvider,
    input: { state: string; code: string },
  ): Promise<OAuthLoginCompletion> {
    const client = this.client(provider);
    if (
      !input ||
      typeof input.state !== 'string' ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(input.state) ||
      typeof input.code !== 'string' ||
      input.code.length === 0 ||
      input.code.length > 2048
    ) {
      oauthLoginFail(400, 'INVALID_INPUT');
    }
    const entry = this.states.take(sha256(input.state));
    if (!entry || entry.provider !== provider) oauthLoginFail(400, 'STATE_INVALID');

    const identity = await client.exchangeCode({ code: input.code, redirectUri: entry.redirectUri });
    const email = normalizeProviderEmail(identity.email);

    const binding = await this.query<BindingRow>(
      this.options.database,
      `SELECT o.tenant_user_id AS user_id, u.disabled_at
       FROM tenant_oauth_identities o
       JOIN saas_users u ON u.id = o.tenant_user_id
       WHERE o.provider_type = $1 AND o.provider_subject = $2
       LIMIT 1`,
      [identity.providerType, identity.providerSubject],
    );
    const bound = binding.rows[0];
    if (bound && bound.disabled_at === null && UUID_PATTERN.test(bound.user_id)) {
      const session = await this.options.identity.issueSessionForUser(bound.user_id, this.options.sessionTtlSeconds);
      if (!session) throw new OAuthLoginError(503, 'UNAVAILABLE');
      return { kind: 'authenticated', token: session.token, csrfToken: session.csrfToken, session: session.session };
    }

    if (email !== undefined) {
      const account = await this.options.identity.findUserAccountByEmail(email);
      if (account) {
        return { kind: 'adoption-required', pendingToken: this.issuePending(identity, email), email };
      }
    }
    return {
      kind: 'registration-required',
      pendingToken: this.issuePending(identity, email),
      ...(email === undefined ? {} : { email }),
    };
  }

  private issuePending(identity: OAuthIdentity, email: string | undefined): string {
    const pendingToken = randomBytes(32).toString('base64url');
    this.pending.put(sha256(pendingToken), { providerIdentity: identity, email });
    return pendingToken;
  }

  private takePending(pendingToken: string): PendingEntry {
    if (typeof pendingToken !== 'string' || !OPAQUE_TOKEN_PATTERN.test(pendingToken)) {
      oauthLoginFail(400, 'PENDING_INVALID');
    }
    const entry = this.pending.take(sha256(pendingToken));
    if (!entry) oauthLoginFail(400, 'PENDING_INVALID');
    return entry;
  }

  /** Create the account, bind the provider identity, and issue a session. */
  async completeRegistration(pendingToken: string, input: OAuthRegistrationInput): Promise<OAuthLoginSession> {
    const entry = this.takePending(pendingToken);
    if (!input || typeof input !== 'object') oauthLoginFail(400, 'INVALID_INPUT');
    validatePassword(input.password);
    const displayName =
      input.displayName === undefined
        ? entry.providerIdentity.displayName
        : typeof input.displayName === 'string' &&
            input.displayName.trim().length >= 1 &&
            input.displayName.trim().length <= 120
          ? input.displayName.trim()
          : oauthLoginFail(400, 'INVALID_INPUT');
    const email = entry.email ?? synthesizedEmail(entry.providerIdentity);
    const userId = randomUUID();
    let passwordHash: string;
    try {
      passwordHash = await hashPasswordValue(input.password);
    } catch {
      throw new OAuthLoginError(503, 'UNAVAILABLE');
    }
    const now = this.now().toISOString();

    await this.options.database.transaction(async (tx) => {
      // Same fence family as login/bootstrap: global writer fence, then the
      // preallocated user key, before any user or binding INSERT.
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      await this.query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [userId]);
      const inserted = await this.query<{ id: string }>(
        tx,
        `INSERT INTO saas_users
         (id, email, password_hash, display_name, email_verified_at, disabled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $6)
         RETURNING id`,
        [userId, email, passwordHash, displayName ?? null, entry.email === undefined ? null : now, now],
        'EMAIL_ALREADY_EXISTS',
      );
      if (inserted.rows.length !== 1 || inserted.rows[0]?.id !== userId) throw new OAuthLoginError(503, 'UNAVAILABLE');
      const bound = await this.query<{ id: string }>(
        tx,
        `INSERT INTO tenant_oauth_identities
         (id, provider_type, provider_subject, tenant_user_id, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id`,
        [randomUUID(), entry.providerIdentity.providerType, entry.providerIdentity.providerSubject, userId, email, now],
      );
      if (bound.rows.length !== 1) throw new OAuthLoginError(503, 'UNAVAILABLE');
    });

    const session = await this.options.identity.issueSessionForUser(userId, this.options.sessionTtlSeconds);
    if (!session) throw new OAuthLoginError(503, 'UNAVAILABLE');
    return session;
  }

  /** Prove ownership of the email-conflicting account, bind, and issue a session. */
  async completeAdoption(pendingToken: string, input: OAuthAdoptionInput): Promise<OAuthLoginSession> {
    const entry = this.takePending(pendingToken);
    if (entry.email === undefined) oauthLoginFail(400, 'PENDING_INVALID');
    if (!input || typeof input !== 'object') oauthLoginFail(400, 'INVALID_INPUT');
    validatePassword(input.password);

    const account = await this.options.identity.verifyAccountPasswordByEmail(entry.email, input.password);
    if (!account || !UUID_PATTERN.test(account.userId)) oauthLoginFail(401, 'CREDENTIALS_REJECTED');
    const now = this.now().toISOString();

    await this.options.database.transaction(async (tx) => {
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      await this.query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [account.userId]);
      const bound = await this.query<{ id: string }>(
        tx,
        `INSERT INTO tenant_oauth_identities
         (id, provider_type, provider_subject, tenant_user_id, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id`,
        [
          randomUUID(),
          entry.providerIdentity.providerType,
          entry.providerIdentity.providerSubject,
          account.userId,
          entry.email,
          now,
        ],
      );
      if (bound.rows.length !== 1) throw new OAuthLoginError(503, 'UNAVAILABLE');
    });

    const session = await this.options.identity.issueSessionForUser(account.userId, this.options.sessionTtlSeconds);
    if (!session) throw new OAuthLoginError(503, 'UNAVAILABLE');
    return session;
  }
}
