import type {
  PaymentCheckoutAction,
  PaymentCheckoutOptions,
  PaymentCheckoutRedirectPolicy,
  PaymentCheckoutView,
} from './types.js';

const DEFAULT_MAX_QR_TEXT_LENGTH = 4096;
const MAX_REDIRECT_URL_LENGTH = 4096;
const MAX_PROVIDER_TEXT_LENGTH = 8192;
const MARKUP = /<\/?[a-z][^>]*>|<!--|-->|<!doctype\b|\b(?:src|href)\s*=|&(?:lt|gt|amp|quot|apos);/iu;
const REMOTE_RESOURCE_SCHEME = /^(?:javascript|vbscript|data|blob|file|about|chrome|chrome-extension):/iu;
const IMAGE_RESOURCE_PATH = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/iu;
const GENERIC_TRAMPOLINE_PATH =
  /(?:^|\/)(?:continue|destination|forward|go|link|out|redirect|redirect_url|url)(?:\/|$)/iu;
const TRAMPOLINE_QUERY_NAMES = new Set([
  'continue',
  'dest',
  'destination',
  'next',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'return',
  'return_to',
  'return_url',
  'target',
  'u',
  'url',
]);

export interface NormalizedCheckoutPolicy {
  readonly redirectsByProvider: ReadonlyMap<string, PaymentCheckoutRedirectPolicy>;
  readonly maxQrTextLength: number;
}

export interface StoredCheckoutFields {
  readonly checkoutKind?: unknown;
  readonly checkoutUrl?: unknown;
  readonly checkoutText?: unknown;
  readonly checkoutExpiresAt?: unknown;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029) {
      return true;
    }
  }
  return false;
}

function nonEmptyProviderKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value.trim() !== value) {
    throw new TypeError('checkout provider key is invalid');
  }
  if (hasControlCharacters(value)) throw new TypeError('checkout provider key is invalid');
  return value;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('checkout redirect origin is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('checkout redirect origin is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new TypeError('checkout redirect origin is invalid');
  }
  return parsed.origin;
}

function normalizePathPrefix(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.trim() !== value) {
    throw new TypeError('checkout redirect path prefix is invalid');
  }
  if (
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\') ||
    hasControlCharacters(value) ||
    /(?:^|\/)(?:\.\.?)(?:\/|$)/u.test(value) ||
    /%(?:00|2e|2f|5c)/iu.test(value)
  ) {
    throw new TypeError('checkout redirect path prefix is invalid');
  }
  return value;
}

export function normalizePaymentCheckoutOptions(
  options: PaymentCheckoutOptions | undefined,
  directPolicies: readonly PaymentCheckoutRedirectPolicy[] | undefined,
): NormalizedCheckoutPolicy {
  const configuredPolicies = options?.redirectPolicies ?? directPolicies ?? [];
  if (!Array.isArray(configuredPolicies)) throw new TypeError('checkout redirect policies are invalid');
  const redirectsByProvider = new Map<string, PaymentCheckoutRedirectPolicy>();
  for (const policy of configuredPolicies) {
    if (!policy || typeof policy !== 'object') throw new TypeError('checkout redirect policy is invalid');
    const providerKey = nonEmptyProviderKey(policy.providerKey);
    const origin = normalizeOrigin(policy.origin);
    if (!Array.isArray(policy.pathPrefixes) || policy.pathPrefixes.length === 0) {
      throw new TypeError('checkout redirect path prefixes are invalid');
    }
    const pathPrefixes = policy.pathPrefixes.map(normalizePathPrefix);
    if (redirectsByProvider.has(providerKey)) throw new TypeError('checkout redirect policy is duplicated');
    redirectsByProvider.set(providerKey, { providerKey, origin, pathPrefixes });
  }
  const maxQrTextLength = options?.maxQrTextLength ?? DEFAULT_MAX_QR_TEXT_LENGTH;
  if (!Number.isSafeInteger(maxQrTextLength) || maxQrTextLength < 1 || maxQrTextLength > MAX_PROVIDER_TEXT_LENGTH) {
    throw new TypeError('checkout QR text limit is invalid');
  }
  return { redirectsByProvider, maxQrTextLength };
}

function normalizeExpiry(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || hasControlCharacters(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasAbsoluteRemoteValue(value: string): boolean {
  return /(?:^|[\s"'=&])(?:https?:)?\/\//iu.test(value);
}

function isTrampolineUrl(parsed: URL): boolean {
  if (parsed.hash !== '' || GENERIC_TRAMPOLINE_PATH.test(parsed.pathname)) return true;
  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    if (TRAMPOLINE_QUERY_NAMES.has(normalizedKey)) return true;
    if (hasAbsoluteRemoteValue(value) && /(?:redirect|return|target|destination|continue|next|url)/iu.test(key)) {
      return true;
    }
  }
  return false;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function validRedirectUrl(value: string, providerKey: string, policy: NormalizedCheckoutPolicy): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_REDIRECT_URL_LENGTH ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    value.includes('\\') ||
    hasControlCharacters(value)
  ) {
    return null;
  }
  const providerPolicy = policy.redirectsByProvider.get(providerKey);
  if (!providerPolicy) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const pathAllowed = providerPolicy.pathPrefixes.some((prefix) => pathMatchesPrefix(parsed.pathname, prefix));
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== providerPolicy.origin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== new URL(providerPolicy.origin).port ||
    parsed.pathname.includes('\\') ||
    hasControlCharacters(parsed.pathname) ||
    /%(?:00|2e|2f|5c)/iu.test(parsed.pathname) ||
    !pathAllowed ||
    isTrampolineUrl(parsed)
  ) {
    return null;
  }
  return parsed.href;
}

function validQrText(value: string, maxLength: number): string | null {
  if (value.length === 0 || value.length > maxLength || value.length > MAX_PROVIDER_TEXT_LENGTH) return null;
  if (hasControlCharacters(value) || MARKUP.test(value) || REMOTE_RESOURCE_SCHEME.test(value)) return null;
  if (/\b(?:url|src|href)\s*\(/iu.test(value)) return null;
  try {
    if (new TextEncoder().encode(value).byteLength > maxLength * 4) return null;
  } catch {
    return null;
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && IMAGE_RESOURCE_PATH.test(parsed.pathname)) {
      return null;
    }
    if (parsed.username !== '' || parsed.password !== '') return null;
  } catch {
    // QR payloads are not required to be URLs. They are still returned as text only.
  }
  return value;
}

export function normalizeProviderCheckoutAction(
  value: unknown,
  providerKey: string,
  policy: NormalizedCheckoutPolicy,
): PaymentCheckoutAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const expiresAt = normalizeExpiry(candidate.expiresAt);
  if (!expiresAt) return null;
  if (candidate.kind === 'redirect') {
    if (typeof candidate.url !== 'string') return null;
    const url = validRedirectUrl(candidate.url, providerKey, policy);
    return url === null ? null : { kind: 'redirect', url, expiresAt };
  }
  if (candidate.kind === 'qr') {
    if (typeof candidate.text !== 'string') return null;
    const text = validQrText(candidate.text, policy.maxQrTextLength);
    return text === null ? null : { kind: 'qr', text, expiresAt };
  }
  return null;
}

export function checkoutActionColumns(action: PaymentCheckoutAction | null): {
  readonly kind: string | null;
  readonly url: string | null;
  readonly text: string | null;
  readonly expiresAt: string | null;
} {
  if (!action) return { kind: null, url: null, text: null, expiresAt: null };
  return action.kind === 'redirect'
    ? { kind: action.kind, url: action.url, text: null, expiresAt: action.expiresAt }
    : { kind: action.kind, url: null, text: action.text, expiresAt: action.expiresAt };
}

export function checkoutViewFromStored(
  fields: StoredCheckoutFields,
  providerKey: string,
  financialState: string,
  providerSubmissionState: unknown,
  policy: NormalizedCheckoutPolicy,
  now: Date,
): PaymentCheckoutView {
  if (['paid', 'fulfilling', 'fulfilled', 'cancelled', 'reconciliation_pending'].includes(financialState)) {
    return { status: 'closed', action: null };
  }
  const action =
    fields.checkoutKind === 'redirect'
      ? normalizeProviderCheckoutAction(
          { kind: 'redirect', url: fields.checkoutUrl, expiresAt: fields.checkoutExpiresAt },
          providerKey,
          policy,
        )
      : fields.checkoutKind === 'qr'
        ? normalizeProviderCheckoutAction(
            { kind: 'qr', text: fields.checkoutText, expiresAt: fields.checkoutExpiresAt },
            providerKey,
            policy,
          )
        : null;
  if (action) {
    if (new Date(action.expiresAt).getTime() <= now.getTime()) return { status: 'expired', action: null };
    return { status: 'ready', action };
  }
  if (providerSubmissionState === 'submitting') return { status: 'pending', action: null };
  return { status: 'unavailable', action: null };
}

export function unavailableCheckout(): PaymentCheckoutView {
  return { status: 'unavailable', action: null };
}
