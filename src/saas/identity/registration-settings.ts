/**
 * R4 registration admission (plan §R4): the runtime admission-switch surface.
 *
 * Since F1 (task #34) the platform settings store exists, and this module is
 * the single source of its registration grammar:
 *
 * 1. Reserved settings-key constants below name the store keys, and
 *    `parseRegistrationAdmissionSettings` is the single strict normalizer for
 *    their values (fail-closed defaults, no silent coercion).
 *    `parseRegistrationSettingValue` applies the same per-key grammar to one
 *    store value at a time, and `resolveRegistrationAdmissionSettings`
 *    resolves store-first (a present store value wins) with env fallback —
 *    an empty store keeps the exact pre-F1 env/default behavior.
 * 2. Secrets (SMTP password, Turnstile secret) live only in the environment
 *    and are resolved at call time — the OAuth `OAuthSecretSource` posture —
 *    never embedded in config files. The store accepts them only as KMS
 *    sealed envelopes and the control plane (which holds no credential-
 *    unsealing KMS) does not consume them (documented F1 deviation).
 *
 * Defaults are fail-closed: registration is CLOSED, Turnstile is off
 * (pass-through), the domain lists are empty, and all registration reward
 * amounts are zero (no wallet activity unless explicitly configured).
 */

export type RegistrationMode = 'open' | 'invite' | 'closed';

/**
 * Reserved future settings-store keys, exported as one frozen record (the
 * billing-groups `saas.payments.topup.amount_tier_discounts` precedent).
 */
export const REGISTRATION_SETTINGS_KEYS = Object.freeze({
  mode: 'saas.identity.registration.mode',
  emailVerificationRequired: 'saas.identity.registration.email_verification_required',
  emailDomainAllowlist: 'saas.identity.registration.email_domain_allowlist',
  emailDomainDenylist: 'saas.identity.registration.email_domain_denylist',
  turnstileEnabled: 'saas.identity.registration.turnstile.enabled',
  turnstileSiteKey: 'saas.identity.registration.turnstile.site_key',
  turnstileSecret: 'saas.identity.registration.turnstile.secret',
  smtpHost: 'saas.identity.registration.smtp.host',
  smtpPort: 'saas.identity.registration.smtp.port',
  smtpSecure: 'saas.identity.registration.smtp.secure',
  smtpUsername: 'saas.identity.registration.smtp.username',
  smtpPassword: 'saas.identity.registration.smtp.password',
  smtpFrom: 'saas.identity.registration.smtp.from',
  rewardCurrency: 'saas.identity.registration.reward.currency',
  rewardGrant: 'saas.identity.registration.reward.grant_minor_units',
  rewardCodeFiller: 'saas.identity.registration.reward.code_filler_minor_units',
  rewardCodeOwner: 'saas.identity.registration.reward.code_owner_minor_units',
  rewardCodeOwnerMinThreshold: 'saas.identity.registration.reward.code_owner_min_threshold_minor_units',
} as const);

/** Environment variable names backing each settings key in managed mode. */
export const REGISTRATION_ENV_VARS = Object.freeze({
  mode: 'MODEL_ROUTER_SAAS_REGISTRATION_MODE',
  emailVerification: 'MODEL_ROUTER_SAAS_REGISTRATION_EMAIL_VERIFICATION',
  domainAllowlist: 'MODEL_ROUTER_SAAS_REGISTRATION_EMAIL_DOMAIN_ALLOWLIST',
  domainDenylist: 'MODEL_ROUTER_SAAS_REGISTRATION_EMAIL_DOMAIN_DENYLIST',
  turnstileEnabled: 'MODEL_ROUTER_SAAS_REGISTRATION_TURNSTILE_ENABLED',
  turnstileSiteKey: 'MODEL_ROUTER_SAAS_REGISTRATION_TURNSTILE_SITE_KEY',
  turnstileSecret: 'MODEL_ROUTER_SAAS_REGISTRATION_TURNSTILE_SECRET',
  smtpHost: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_HOST',
  smtpPort: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_PORT',
  smtpSecure: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_SECURE',
  smtpUsername: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_USERNAME',
  smtpPassword: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_PASSWORD',
  smtpFrom: 'MODEL_ROUTER_SAAS_REGISTRATION_SMTP_FROM',
  rewardCurrency: 'MODEL_ROUTER_SAAS_REGISTRATION_REWARD_CURRENCY',
  rewardGrant: 'MODEL_ROUTER_SAAS_REGISTRATION_REWARD_GRANT_MINOR_UNITS',
  rewardCodeFiller: 'MODEL_ROUTER_SAAS_REGISTRATION_REWARD_CODE_FILLER_MINOR_UNITS',
  rewardCodeOwner: 'MODEL_ROUTER_SAAS_REGISTRATION_REWARD_CODE_OWNER_MINOR_UNITS',
  rewardCodeOwnerMinThreshold: 'MODEL_ROUTER_SAAS_REGISTRATION_REWARD_CODE_OWNER_MIN_THRESHOLD_MINOR_UNITS',
} as const);

export interface RegistrationSmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly from: string;
}

export interface RegistrationRewardSettings {
  readonly currency: string;
  readonly grantMinorUnits: string;
  readonly codeFillerMinorUnits: string;
  readonly codeOwnerMinorUnits: string;
  readonly codeOwnerMinThresholdMinorUnits: string;
}

export interface RegistrationAdmissionSettings {
  readonly mode: RegistrationMode;
  readonly emailVerificationRequired: boolean;
  readonly emailDomainAllowlist: readonly string[];
  readonly emailDomainDenylist: readonly string[];
  readonly turnstile: {
    readonly enabled: boolean;
    readonly siteKey?: string;
    readonly secret?: string;
  };
  readonly smtp?: RegistrationSmtpSettings;
  readonly rewards: RegistrationRewardSettings;
}

export class RegistrationSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationSettingsError';
  }
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new RegistrationSettingsError(`${name} must be "true" or "false"`);
}

function parseDomainList(value: string | undefined, name: string): readonly string[] {
  if (value === undefined || value === '') return [];
  const domains: string[] = [];
  for (const part of value.split(',')) {
    const domain = part.trim().toLowerCase().replace(/^@/, '');
    if (domain.length === 0) continue;
    if (!DOMAIN_PATTERN.test(domain)) throw new RegistrationSettingsError(`${name} contains an invalid domain`);
    if (domains.includes(domain)) throw new RegistrationSettingsError(`${name} contains a duplicate domain`);
    domains.push(domain);
  }
  return domains;
}

function parseMinorUnits(value: string | undefined, name: string): string {
  if (value === undefined || value === '') return '0';
  if (typeof value !== 'string' || !MINOR_UNITS_PATTERN.test(value.trim())) {
    throw new RegistrationSettingsError(`${name} must be a non-negative integer minor-units amount`);
  }
  return value.trim();
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 587;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RegistrationSettingsError(`${REGISTRATION_ENV_VARS.smtpPort} must be a TCP port`);
  }
  return port;
}

/** Strict normalizer for the admission settings values (fail-closed defaults). */
export function parseRegistrationAdmissionSettings(
  values: Readonly<Record<string, string | undefined>>,
): RegistrationAdmissionSettings {
  if (!values || typeof values !== 'object') throw new RegistrationSettingsError('Invalid settings source');

  const modeRaw = values[REGISTRATION_ENV_VARS.mode];
  let mode: RegistrationMode = 'closed';
  if (modeRaw !== undefined && modeRaw !== '') {
    if (modeRaw !== 'open' && modeRaw !== 'invite' && modeRaw !== 'closed') {
      throw new RegistrationSettingsError(`${REGISTRATION_ENV_VARS.mode} must be "open", "invite" or "closed"`);
    }
    mode = modeRaw;
  }

  const emailVerificationRaw = values[REGISTRATION_ENV_VARS.emailVerification];
  const emailVerificationRequired =
    emailVerificationRaw === undefined || emailVerificationRaw === ''
      ? true
      : parseBoolean(emailVerificationRaw, REGISTRATION_ENV_VARS.emailVerification);

  const emailDomainAllowlist = parseDomainList(
    values[REGISTRATION_ENV_VARS.domainAllowlist],
    REGISTRATION_ENV_VARS.domainAllowlist,
  );
  const emailDomainDenylist = parseDomainList(
    values[REGISTRATION_ENV_VARS.domainDenylist],
    REGISTRATION_ENV_VARS.domainDenylist,
  );
  for (const domain of emailDomainAllowlist) {
    if (emailDomainDenylist.includes(domain)) {
      throw new RegistrationSettingsError('A domain cannot be both allowlisted and denylisted');
    }
  }

  const turnstileEnabled = parseBoolean(
    values[REGISTRATION_ENV_VARS.turnstileEnabled],
    REGISTRATION_ENV_VARS.turnstileEnabled,
  );
  const turnstileSiteKey = values[REGISTRATION_ENV_VARS.turnstileSiteKey]?.trim() || undefined;
  const turnstileSecret = values[REGISTRATION_ENV_VARS.turnstileSecret]?.trim() || undefined;
  if (turnstileEnabled && (turnstileSecret === undefined || turnstileSiteKey === undefined)) {
    throw new RegistrationSettingsError('Turnstile requires both a site key and a secret');
  }

  const smtpHost = values[REGISTRATION_ENV_VARS.smtpHost]?.trim() || undefined;
  const smtpFrom = values[REGISTRATION_ENV_VARS.smtpFrom]?.trim() || undefined;
  const smtpUsername = values[REGISTRATION_ENV_VARS.smtpUsername]?.trim() || undefined;
  const smtpPassword = values[REGISTRATION_ENV_VARS.smtpPassword] ?? undefined;
  const smtp =
    smtpHost === undefined && smtpFrom === undefined
      ? undefined
      : smtpHost === undefined || smtpFrom === undefined
        ? (() => {
            throw new RegistrationSettingsError('SMTP configuration requires both a host and a From address');
          })()
        : smtpUsername !== undefined && smtpPassword === undefined
          ? (() => {
              throw new RegistrationSettingsError('SMTP username requires a password');
            })()
          : {
              host: smtpHost,
              port: parsePort(values[REGISTRATION_ENV_VARS.smtpPort]),
              secure: parseBoolean(values[REGISTRATION_ENV_VARS.smtpSecure], REGISTRATION_ENV_VARS.smtpSecure),
              ...(smtpUsername === undefined ? {} : { username: smtpUsername }),
              ...(smtpPassword === undefined ? {} : { password: smtpPassword }),
              from: smtpFrom,
            };

  const rewardCurrency = (values[REGISTRATION_ENV_VARS.rewardCurrency]?.trim() || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(rewardCurrency)) {
    throw new RegistrationSettingsError(`${REGISTRATION_ENV_VARS.rewardCurrency} must be an ISO-4217 code`);
  }
  const rewards: RegistrationRewardSettings = {
    currency: rewardCurrency,
    grantMinorUnits: parseMinorUnits(values[REGISTRATION_ENV_VARS.rewardGrant], REGISTRATION_ENV_VARS.rewardGrant),
    codeFillerMinorUnits: parseMinorUnits(
      values[REGISTRATION_ENV_VARS.rewardCodeFiller],
      REGISTRATION_ENV_VARS.rewardCodeFiller,
    ),
    codeOwnerMinorUnits: parseMinorUnits(
      values[REGISTRATION_ENV_VARS.rewardCodeOwner],
      REGISTRATION_ENV_VARS.rewardCodeOwner,
    ),
    codeOwnerMinThresholdMinorUnits: parseMinorUnits(
      values[REGISTRATION_ENV_VARS.rewardCodeOwnerMinThreshold],
      REGISTRATION_ENV_VARS.rewardCodeOwnerMinThreshold,
    ),
  };

  return {
    mode,
    emailVerificationRequired,
    emailDomainAllowlist,
    emailDomainDenylist,
    turnstile: {
      enabled: turnstileEnabled,
      ...(turnstileSiteKey === undefined ? {} : { siteKey: turnstileSiteKey }),
      ...(turnstileSecret === undefined ? {} : { secret: turnstileSecret }),
    },
    ...(smtp === undefined ? {} : { smtp }),
    rewards,
  };
}

/**
 * Admission decision for an email domain: denylist wins, then the allowlist
 * (an empty allowlist admits every non-denied domain).
 */
export function isEmailDomainAdmitted(
  settings: Pick<RegistrationAdmissionSettings, 'emailDomainAllowlist' | 'emailDomainDenylist'>,
  emailCanonical: string,
): boolean {
  const domain = emailCanonical.slice(emailCanonical.lastIndexOf('@') + 1);
  if (domain.length === 0) return false;
  if (settings.emailDomainDenylist.includes(domain)) return false;
  if (settings.emailDomainAllowlist.length > 0 && !settings.emailDomainAllowlist.includes(domain)) return false;
  return true;
}

/**
 * Settings keys whose values are secrets. In the platform settings store they
 * are stored only as KMS sealed envelopes and are never consumed by the
 * control plane (the control-plane workload holds no credential-unsealing
 * KMS): registration secrets remain env-only until a consumer with an
 * unsealing KMS exists (documented F1 deviation).
 */
export const REGISTRATION_SECRET_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  REGISTRATION_SETTINGS_KEYS.turnstileSecret,
  REGISTRATION_SETTINGS_KEYS.smtpPassword,
]);

/** Maps each reserved settings key to the env var backing it in managed mode. */
const REGISTRATION_SETTINGS_ENV_BY_KEY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['mode', 'mode'],
        ['emailVerificationRequired', 'emailVerification'],
        ['emailDomainAllowlist', 'domainAllowlist'],
        ['emailDomainDenylist', 'domainDenylist'],
        ['turnstileEnabled', 'turnstileEnabled'],
        ['turnstileSiteKey', 'turnstileSiteKey'],
        ['turnstileSecret', 'turnstileSecret'],
        ['smtpHost', 'smtpHost'],
        ['smtpPort', 'smtpPort'],
        ['smtpSecure', 'smtpSecure'],
        ['smtpUsername', 'smtpUsername'],
        ['smtpPassword', 'smtpPassword'],
        ['smtpFrom', 'smtpFrom'],
        ['rewardCurrency', 'rewardCurrency'],
        ['rewardGrant', 'rewardGrant'],
        ['rewardCodeFiller', 'rewardCodeFiller'],
        ['rewardCodeOwner', 'rewardCodeOwner'],
        ['rewardCodeOwnerMinThreshold', 'rewardCodeOwnerMinThreshold'],
      ] as const
    ).map(([settingsField, envField]) => [REGISTRATION_SETTINGS_KEYS[settingsField], REGISTRATION_ENV_VARS[envField]]),
  ),
);

const SETTINGS_DOMAIN_LIST_MAX_ENTRIES = 128;

function parseDomainListValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new RegistrationSettingsError(`${name} must be a string`);
  const domains = parseDomainList(value, name);
  if (domains.length > SETTINGS_DOMAIN_LIST_MAX_ENTRIES) {
    throw new RegistrationSettingsError(`${name} exceeds ${SETTINGS_DOMAIN_LIST_MAX_ENTRIES} domains`);
  }
  return domains.join(',');
}

function parseBooleanValue(value: unknown, name: string): string {
  if (value !== 'true' && value !== 'false') {
    throw new RegistrationSettingsError(`${name} must be "true" or "false"`);
  }
  return value;
}

function parseBoundedText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) {
    throw new RegistrationSettingsError(`${name} must be trimmed text between ${min} and ${max} characters`);
  }
  if ([...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) {
    throw new RegistrationSettingsError(`${name} contains control characters`);
  }
  return value;
}

/**
 * F1 platform settings store: the strict single-value normalizer for one
 * registration settings-store value. It enforces exactly the per-key grammar
 * of `parseRegistrationAdmissionSettings` (same helpers, fail-closed, no
 * silent coercion) so the store can never hold a value the full parser would
 * reject on its own merits.
 *
 * Cross-field rules (Turnstile needs site key + secret together, SMTP needs
 * host + From, allow/deny disjointness) are deliberately NOT enforced here:
 * the store mutates one key at a time, and the merged store+env configuration
 * is validated by the full parser at resolution time
 * (`resolveRegistrationAdmissionSettings`), which stays fail-closed.
 *
 * Secret-suffixed keys (Turnstile secret, SMTP password) have no plain-value
 * grammar — they are sealed envelopes in the store, never plaintext.
 */
export function parseRegistrationSettingValue(key: string, value: unknown): string {
  switch (key) {
    case REGISTRATION_SETTINGS_KEYS.mode:
      if (value !== 'open' && value !== 'invite' && value !== 'closed') {
        throw new RegistrationSettingsError(`${key} must be "open", "invite" or "closed"`);
      }
      return value;
    case REGISTRATION_SETTINGS_KEYS.emailVerificationRequired:
    case REGISTRATION_SETTINGS_KEYS.turnstileEnabled:
    case REGISTRATION_SETTINGS_KEYS.smtpSecure:
      return parseBooleanValue(value, key);
    case REGISTRATION_SETTINGS_KEYS.emailDomainAllowlist:
    case REGISTRATION_SETTINGS_KEYS.emailDomainDenylist:
      return parseDomainListValue(value, key);
    case REGISTRATION_SETTINGS_KEYS.turnstileSiteKey:
    case REGISTRATION_SETTINGS_KEYS.smtpHost:
    case REGISTRATION_SETTINGS_KEYS.smtpUsername:
      return parseBoundedText(value, key, 1, 255);
    case REGISTRATION_SETTINGS_KEYS.smtpFrom:
      return parseBoundedText(value, key, 3, 254);
    case REGISTRATION_SETTINGS_KEYS.smtpPort: {
      if (typeof value !== 'string' || !/^[0-9]{1,5}$/.test(value)) {
        throw new RegistrationSettingsError(`${key} must be a TCP port`);
      }
      const port = Number(value);
      if (port < 1 || port > 65535) throw new RegistrationSettingsError(`${key} must be a TCP port`);
      return value;
    }
    case REGISTRATION_SETTINGS_KEYS.rewardCurrency: {
      if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
        throw new RegistrationSettingsError(`${key} must be an ISO-4217 code`);
      }
      return value.toUpperCase();
    }
    case REGISTRATION_SETTINGS_KEYS.rewardGrant:
    case REGISTRATION_SETTINGS_KEYS.rewardCodeFiller:
    case REGISTRATION_SETTINGS_KEYS.rewardCodeOwner:
    case REGISTRATION_SETTINGS_KEYS.rewardCodeOwnerMinThreshold:
      if (typeof value !== 'string') {
        throw new RegistrationSettingsError(`${key} must be a non-negative integer minor-units amount`);
      }
      return parseMinorUnits(value, key);
    case REGISTRATION_SETTINGS_KEYS.turnstileSecret:
    case REGISTRATION_SETTINGS_KEYS.smtpPassword:
      throw new RegistrationSettingsError(`${key} is a secret settings key; secrets are stored as sealed envelopes`);
    default:
      throw new RegistrationSettingsError(`${key} is not a reserved registration settings key`);
  }
}

/**
 * F1 platform settings store: store-first registration settings resolution.
 *
 * `store` carries the platform settings store's plain (non-secret) values
 * keyed by settings key; `env` is the process environment (or an equivalent
 * record keyed by env var name). A present, non-empty store value wins over
 * the environment; an empty store keeps the current env/default behavior
 * exactly (the F1 fail-closed posture). The merged record then runs through
 * the unmodified strict parser, so every cross-field rule and every
 * fail-closed default of the env path applies identically.
 */
export function resolveRegistrationAdmissionSettings(
  store: Readonly<Record<string, string | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): RegistrationAdmissionSettings {
  const merged: Record<string, string | undefined> = {};
  for (const [settingsKey, envVar] of Object.entries(REGISTRATION_SETTINGS_ENV_BY_KEY)) {
    const storeValue = store[settingsKey];
    merged[envVar] = typeof storeValue === 'string' && storeValue !== '' ? storeValue : env[envVar];
  }
  return parseRegistrationAdmissionSettings(merged);
}
