import {
  parseTopupAmountTierDiscounts,
  TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
} from '../../billing/groups/multiplier.js';
import type { TopupAmountTier } from '../../billing/groups/types.js';
import { MODEL_PLAZA_SETTINGS_KEYS, parseModelPlazaSettingValue } from '../../gateway/model-plaza/settings.js';
import {
  parseRegistrationSettingValue,
  REGISTRATION_SECRET_SETTINGS_KEYS,
  REGISTRATION_SETTINGS_KEYS,
} from '../../identity/registration-settings.js';
import {
  parseBrandApiBaseUrlSetting,
  parseBrandContactUrlSetting,
  parseBrandCustomEndpointsSetting,
  parseBrandCustomMenuItemsSetting,
  parseBrandCustomPagesSetting,
  parseBrandDocUrlSetting,
  parseBrandFrameAncestorsSetting,
  parseBrandSiteLogoSetting,
  parseBrandSiteNameSetting,
  parseBrandSiteSubtitleSetting,
} from '../brand/snapshot.js';

/**
 * F1 platform settings store (task #34): the typed key registry.
 *
 * The key space is closed: only registered keys can be written, and every
 * registered key carries a strict fail-closed parser (the R4
 * registration-settings grammar and the R1 billing-groups amount-tier
 * grammar, verbatim). This consolidates the two reserved-key records that
 * previously lived apart (registration-settings.ts's
 * REGISTRATION_SETTINGS_KEYS and multiplier.ts's
 * TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY) into one registry the service
 * and the admin API share.
 *
 * Secret-suffixed keys (kind 'sealed') accept only KMS sealed envelopes in
 * the store — never plaintext — mirroring the egress-proxy
 * auth_sealed_envelope convention.
 */

export type PlatformSettingKind = 'plain' | 'sealed';

export interface PlatformSettingDefinition {
  readonly key: string;
  readonly kind: PlatformSettingKind;
  readonly description: string;
  /**
   * Strict single-value normalizer (fail-closed). Returns the JSON-serialized
   * form stored under the {"value": ...} envelope.
   */
  readonly parse: (value: unknown) => unknown;
  /**
   * Sealed keys only: the closed allowlist of designated runtime consumer
   * labels permitted to unseal the value (G4 consumption path). Absent or
   * empty means no consumer may unseal the key.
   */
  readonly consumers?: readonly string[];
}

/**
 * G4 sealed-secret consumption: the designated consumer label for the R4
 * registration admission runtime (Turnstile siteverify secret, SMTP AUTH
 * password). It is recorded as the audit entry_point on every unseal.
 */
export const PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION = 'registration-admission' as const;

/**
 * P0-1 codex version auto-sync (sub2api version-sync port): the reserved
 * `saas.codex.*` keys. All plain, all strictly parsed locally (the
 * parseTopupAmountTierDiscountsSetting precedent — no feature-module
 * import needed for a two-rule grammar).
 */
export const CODEX_CLIENT_VERSION_SETTINGS_KEY = 'saas.codex.client_version';
export const CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY = 'saas.codex.client_version_synced';
export const CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY = 'saas.codex.version_auto_sync_enabled';

/** Registration reward amounts are already covered by the per-key grammar above. */

const MAX_TOPUP_TIER_DISCOUNTS = 16;

function parseTopupAmountTierDiscountsSetting(value: unknown): unknown {
  const tiers = parseTopupAmountTierDiscounts(value);
  if (tiers.length > MAX_TOPUP_TIER_DISCOUNTS) {
    throw new Error(`amount-tier discounts are limited to ${MAX_TOPUP_TIER_DISCOUNTS} tiers`);
  }
  return tiers.map((tier) => ({
    thresholdMinorUnits: tier.thresholdMinorUnits.toString(),
    discountNumerator: tier.discountMultiplier.numerator.toString(),
    discountDenominator: tier.discountMultiplier.denominator.toString(),
  }));
}

function registrationPlainDefinition(key: string, description: string): PlatformSettingDefinition {
  return {
    key,
    kind: 'plain',
    description,
    parse: (value) => parseRegistrationSettingValue(key, value),
  };
}

const CODEX_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Strict grammar for the two codex client-version keys (admin override and
 * the worker-synced value): trim, empty is allowed (= follow the synced
 * value), otherwise a bare `MAJOR.MINOR.PATCH` semver with no prerelease
 * suffix. Throws on anything else.
 */
export function parseCodexClientVersionSetting(value: unknown): string {
  if (typeof value !== 'string') throw new Error('the codex client version must be a string');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!CODEX_CLIENT_VERSION_PATTERN.test(trimmed)) {
    throw new Error('the codex client version must be a bare semver such as 0.150.0 (no prerelease suffix)');
  }
  return trimmed;
}

/**
 * Strict grammar for the codex version auto-sync switch: the strings
 * "true"/"false" (normalized to booleans); actual booleans pass through.
 * Absent means the default true (resolved by the reader, not the parser).
 */
export function parseCodexVersionAutoSyncEnabledSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('the codex version auto-sync switch must be "true" or "false"');
}

const REGISTRATION_SETTING_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  [REGISTRATION_SETTINGS_KEYS.mode]: 'Registration admission mode: open, invite or closed (default closed).',
  [REGISTRATION_SETTINGS_KEYS.emailVerificationRequired]:
    'Whether registration and password reset require an emailed verification code (default true).',
  [REGISTRATION_SETTINGS_KEYS.emailDomainAllowlist]:
    'Comma-separated email-domain allowlist; empty admits every non-denied domain.',
  [REGISTRATION_SETTINGS_KEYS.emailDomainDenylist]: 'Comma-separated email-domain denylist; the denylist always wins.',
  [REGISTRATION_SETTINGS_KEYS.turnstileEnabled]:
    'Cloudflare Turnstile switch; enabling requires a site key and a secret at resolution time.',
  [REGISTRATION_SETTINGS_KEYS.turnstileSiteKey]: 'Cloudflare Turnstile site key (public).',
  [REGISTRATION_SETTINGS_KEYS.smtpHost]: 'SMTP relay hostname for verification emails.',
  [REGISTRATION_SETTINGS_KEYS.smtpPort]: 'SMTP relay port (default 587).',
  [REGISTRATION_SETTINGS_KEYS.smtpSecure]: 'Implicit TLS from the first byte (port 465 style).',
  [REGISTRATION_SETTINGS_KEYS.smtpUsername]: 'SMTP AUTH username.',
  [REGISTRATION_SETTINGS_KEYS.smtpFrom]: 'From address for verification emails.',
  [REGISTRATION_SETTINGS_KEYS.rewardCurrency]: 'ISO-4217 currency for registration rewards (default USD).',
  [REGISTRATION_SETTINGS_KEYS.rewardGrant]: 'Registration grant in minor units (default 0).',
  [REGISTRATION_SETTINGS_KEYS.rewardCodeFiller]: 'Invite-code filler reward in minor units (default 0).',
  [REGISTRATION_SETTINGS_KEYS.rewardCodeOwner]: 'Invite-code owner reward in minor units (default 0).',
  [REGISTRATION_SETTINGS_KEYS.rewardCodeOwnerMinThreshold]:
    'Minimum converted spend before the code-owner reward posts, in minor units (default 0).',
});

const DEFINITIONS: readonly PlatformSettingDefinition[] = [
  ...Object.values(REGISTRATION_SETTINGS_KEYS)
    .filter((key) => !REGISTRATION_SECRET_SETTINGS_KEYS.has(key))
    .map((key) => registrationPlainDefinition(key, REGISTRATION_SETTING_DESCRIPTIONS[key] ?? key)),
  {
    key: REGISTRATION_SETTINGS_KEYS.turnstileSecret,
    kind: 'sealed',
    description:
      'Cloudflare Turnstile siteverify secret (sealed envelope; consumed store-first by the registration-admission runtime when an unsealing KMS is wired, env-only otherwise).',
    parse: () => {
      throw new Error('sealed settings keys have no plain-value grammar');
    },
    consumers: [PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION],
  },
  {
    key: REGISTRATION_SETTINGS_KEYS.smtpPassword,
    kind: 'sealed',
    description:
      'SMTP AUTH password (sealed envelope; consumed store-first by the registration-admission runtime when an unsealing KMS is wired, env-only otherwise).',
    parse: () => {
      throw new Error('sealed settings keys have no plain-value grammar');
    },
    consumers: [PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION],
  },
  {
    key: TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY,
    kind: 'plain',
    description:
      'Wallet-topup amount-tier discounts: an ascending list of { thresholdMinorUnits, discountNumerator, discountDenominator } entries; at or above a threshold the credit is multiplied by numerator/denominator (no greater than one).',
    parse: parseTopupAmountTierDiscountsSetting,
  },
  // Batch-5 §5.5 model plaza (task #22): the `saas.plaza.*` runtime
  // switches, parsed by the plaza settings grammar (store-first, env
  // fallback, fail-closed defaults).
  {
    key: MODEL_PLAZA_SETTINGS_KEYS.enabled,
    kind: 'plain',
    description:
      'Model plaza master switch (default false = the GET /v1/model-plaza showcase answers 404 PLAZA_DISABLED).',
    parse: (value: unknown) => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.enabled, value),
  },
  {
    key: MODEL_PLAZA_SETTINGS_KEYS.requireAuth,
    kind: 'plain',
    description:
      'When true, the model plaza requires authentication (proxy key or console session) instead of serving the anonymous view.',
    parse: (value: unknown) => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.requireAuth, value),
  },
  {
    key: MODEL_PLAZA_SETTINGS_KEYS.description,
    kind: 'plain',
    description: 'Model plaza description echoed at the top of the plaza response (0-512 characters).',
    parse: (value: unknown) => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.description, value),
  },
  {
    key: MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups,
    kind: 'plain',
    description:
      'Billing group ids treated as exclusive: visible only to callers whose access tier authorizes the group; anonymous callers never see them (max 64 ids).',
    parse: (value: unknown) => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups, value),
  },
  // Batch-5 §5.2 OEM white-label (task #20): the `saas.brand.*` public brand
  // keys. All plain, all strictly parsed by the shared brand grammar in
  // src/saas/platform/brand/snapshot.ts (the same parsers the snapshot
  // materializer re-runs), so a stored row can only ever hold values the
  // public snapshot plane would accept. The control-plane materializer
  // copies these into the gateway-readable saas_public_brand_settings row.
  {
    key: 'saas.brand.site_name',
    kind: 'plain',
    description: 'OEM site name (1-64 characters); replaces the default document title and header brand.',
    parse: parseBrandSiteNameSetting,
  },
  {
    key: 'saas.brand.site_subtitle',
    kind: 'plain',
    description: 'OEM site subtitle (0-200 characters); empty clears it.',
    parse: parseBrandSiteSubtitleSetting,
  },
  {
    key: 'saas.brand.site_logo',
    kind: 'plain',
    description:
      'OEM logo URL: a relative site path, an https/http URL, or a data:image/*;base64 payload (max 2048 characters). The origin of an absolute URL joins the console CSP img-src allowlist.',
    parse: parseBrandSiteLogoSetting,
  },
  {
    key: 'saas.brand.api_base_url',
    kind: 'plain',
    description: 'Public API base URL shown to customers (relative path or http(s) URL); empty clears it.',
    parse: parseBrandApiBaseUrlSetting,
  },
  {
    key: 'saas.brand.contact_url',
    kind: 'plain',
    description: 'Contact surface: an https/http or mailto: URL; empty clears it.',
    parse: parseBrandContactUrlSetting,
  },
  {
    key: 'saas.brand.doc_url',
    kind: 'plain',
    description: 'Documentation URL (relative path or http(s) URL); empty clears it.',
    parse: parseBrandDocUrlSetting,
  },
  {
    key: 'saas.brand.custom_menu_items',
    kind: 'plain',
    description:
      'Custom console menu items (max 20): [{ label (1-32 chars), url, pageSlug? }]. pageSlug links the item to a custom page.',
    parse: parseBrandCustomMenuItemsSetting,
  },
  {
    key: 'saas.brand.custom_endpoints',
    kind: 'plain',
    description: 'Custom API endpoints for quick copy (max 20): [{ name, url, description? }].',
    parse: parseBrandCustomEndpointsSetting,
  },
  {
    key: 'saas.brand.custom_pages',
    kind: 'plain',
    description:
      'Custom pages (max 20): markdown pages [{ slug, title, mode: "markdown", content (≤32 KiB) }] or iframe embeds [{ slug, title, mode: "iframe", url, userIdParam?, themeParam?, langParam? }]. Iframe origins join the console CSP frame-src allowlist.',
    parse: parseBrandCustomPagesSetting,
  },
  {
    key: 'saas.brand.frame_ancestors',
    kind: 'plain',
    description:
      'Exact https origins allowed to embed the console (max 8); empty keeps frame-ancestors none (the default).',
    parse: parseBrandFrameAncestorsSetting,
  },
  // P0-1 codex version auto-sync (sub2api version-sync port): the
  // `saas.codex.*` keys consumed by the codex-version-sync worker and the
  // codex outbound identity. Plain keys carry no consumer allowlist (the
  // registration/plaza/brand precedent); the synced key is worker-exclusive
  // on the write side, which the description states for the admin console.
  {
    key: CODEX_CLIENT_VERSION_SETTINGS_KEY,
    kind: 'plain',
    description:
      'Pinned Codex CLI client version for the canonical outbound identity (bare semver, e.g. 0.150.0); empty follows the auto-synced value. Values below the upstream minimum still degrade to the baseline at resolution time.',
    parse: parseCodexClientVersionSetting,
  },
  {
    key: CODEX_CLIENT_VERSION_SYNCED_SETTINGS_KEY,
    kind: 'plain',
    description:
      'Auto-synced Codex CLI client version (bare semver, e.g. 0.150.0) tracked from the openai/codex GitHub releases. Written exclusively by the codex-version-sync worker; the admin console must treat it as read-only.',
    parse: parseCodexClientVersionSetting,
  },
  {
    key: CODEX_VERSION_AUTO_SYNC_ENABLED_SETTINGS_KEY,
    kind: 'plain',
    description:
      'Codex client-version auto-sync switch ("true"/"false", default true); "false" pauses the codex-version-sync worker fetch cycles.',
    parse: parseCodexVersionAutoSyncEnabledSetting,
  },
];

const DEFINITIONS_BY_KEY: ReadonlyMap<string, PlatformSettingDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** All registered settings definitions (admin listing surface). */
export const PLATFORM_SETTING_DEFINITIONS: readonly PlatformSettingDefinition[] = Object.freeze([...DEFINITIONS]);

/** The reserved registration settings keys that consume the store store-first. */
export const PLATFORM_REGISTRATION_SETTINGS_KEYS: readonly string[] = Object.freeze(
  Object.values(REGISTRATION_SETTINGS_KEYS).filter((key) => !REGISTRATION_SECRET_SETTINGS_KEYS.has(key)),
);

/** The sealed registration settings keys consumed through the G4 unseal path. */
export const PLATFORM_REGISTRATION_SECRET_SETTINGS_KEYS: readonly string[] = Object.freeze(
  Object.values(REGISTRATION_SETTINGS_KEYS).filter((key) => REGISTRATION_SECRET_SETTINGS_KEYS.has(key)),
);

export function getPlatformSettingDefinition(key: string): PlatformSettingDefinition | undefined {
  if (typeof key !== 'string') return undefined;
  return DEFINITIONS_BY_KEY.get(key);
}

/** Re-parses a stored topup-tier value into the billing-groups tier shape. */
export function parseStoredTopupAmountTierDiscounts(value: unknown): readonly TopupAmountTier[] {
  return parseTopupAmountTierDiscounts(value);
}
