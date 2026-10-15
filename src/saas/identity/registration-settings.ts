/**
 * R4 registration admission (plan §R4): the runtime admission-switch surface.
 *
 * There is no platform settings store yet (the documented repo posture — see
 * the billing-groups `saas.payments.topup.amount_tier_discounts` precedent),
 * so this module follows the same two-part convention:
 *
 * 1. Reserved settings-key constants below name the future store keys, and
 *    `parseRegistrationAdmissionSettings` is the single strict normalizer for
 *    their values (fail-closed defaults, no silent coercion).
 * 2. Managed deployments source the values from the environment (the
 *    `src/saas/deployment.ts` settings surface). `environmentValues` adapts
 *    `process.env` to the parser's input; secrets (SMTP password, Turnstile
 *    secret) live only in the environment and are resolved at call time —
 *    the OAuth `OAuthSecretSource` posture — never embedded in config files.
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
