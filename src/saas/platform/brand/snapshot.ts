import { randomBytes } from 'node:crypto';

/**
 * Batch 5 §5.2 OEM white-label (task #20; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.2; sub2api reference:
 * backend/internal/service/setting_public.go — the __APP_CONFIG__ injection
 * payload — and internal/handler/page_handler.go — custom pages).
 *
 * The public brand snapshot is the non-secret subset of the OEM brand
 * configuration that both the SaaS console and the BYOK admin UI may surface
 * to unauthenticated browsers:
 *
 * - Source of truth: the migration-110 platform settings store under the
 *   `saas.brand.*` key prefix (control-plane writes only, through the strict
 *   per-key registry parsers defined here).
 * - Serving plane: migration 126's `saas_public_brand_settings` single-row
 *   snapshot table. The control plane materializes the snapshot periodically
 *   (and eagerly after a brand-key admin write); the gateway reads it through
 *   its read-only grant for `GET /settings/public`, and the workload that
 *   serves the web console injects it into index.html as
 *   `window.__APP_CONFIG__`. No secret can enter the snapshot by
 *   construction — every field is one of the strictly parsed public fields
 *   below.
 *
 * Everything in this module is pure: parsing, URL sanitization, CSP
 * derivation and HTML injection are shared verbatim by the settings registry
 * (write-time validation), the materializer (read-time re-validation) and the
 * static-serving workloads (render time).
 */

/** Settings-key prefix every brand key shares (`saas.brand.`). */
export const BRAND_SETTINGS_KEY_PREFIX = 'saas.brand.' as const;

export const BRAND_SETTINGS_KEYS = {
  siteName: 'saas.brand.site_name',
  siteSubtitle: 'saas.brand.site_subtitle',
  siteLogo: 'saas.brand.site_logo',
  apiBaseUrl: 'saas.brand.api_base_url',
  contactUrl: 'saas.brand.contact_url',
  docUrl: 'saas.brand.doc_url',
  customMenuItems: 'saas.brand.custom_menu_items',
  customEndpoints: 'saas.brand.custom_endpoints',
  customPages: 'saas.brand.custom_pages',
  frameAncestors: 'saas.brand.frame_ancestors',
} as const;

export type BrandSettingsKey = (typeof BRAND_SETTINGS_KEYS)[keyof typeof BRAND_SETTINGS_KEYS];

/** Every registered brand settings key (the settings-registry input list). */
export const BRAND_SETTINGS_KEY_LIST: readonly BrandSettingsKey[] = Object.values(BRAND_SETTINGS_KEYS);

const MAX_URL_LENGTH = 2048;
const MAX_TEXT_LENGTH = 200;
const MAX_SITE_NAME_LENGTH = 64;
const MAX_SUBTITLE_LENGTH = 200;
const MAX_MENU_ITEMS = 20;
const MAX_ENDPOINTS = 20;
const MAX_PAGES = 20;
const MAX_PAGE_MARKDOWN_BYTES = 32 * 1024;
const MAX_FRAME_ANCESTORS = 8;
/**
 * Control-code-point classes (the repo idiom — code-point iteration, not
 * control-character regexes; biome noControlCharactersInRegex).
 */
export type BrandControlClass = 'text' | 'content' | 'url';

function containsControlCodePoints(value: string, klass: BrandControlClass): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || code === 0x7f;
    if (klass === 'url') {
      // URLs never carry inner whitespace either.
      if (code <= 0x20 || code === 0x7f) return true;
      continue;
    }
    if (klass === 'content') {
      // Markdown bodies keep tab/CR/LF; every other control code is invalid.
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
      if (isControl) return true;
      continue;
    }
    // Short text fields keep the space but no tab/CR/LF.
    if (isControl) return true;
  }
  return false;
}
const DATA_IMAGE_PATTERN = /^data:image\/[a-z0-9][a-z0-9.+-]*;base64,[a-z0-9+/=]+$/i;

/** Custom-page slug grammar (the sub2api page_handler pattern). */
export const BRAND_PAGE_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const BRAND_PAGE_SLUG_MAX_LENGTH = 64;

export class BrandSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandSettingsError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectControlCharacters(value: string, field: string, klass: BrandControlClass = 'text'): string {
  if (containsControlCodePoints(value, klass)) {
    throw new BrandSettingsError(`${field} must not contain control characters`);
  }
  return value;
}

/**
 * URL sanitization for every brand URL surface. Allowlist, never a denylist:
 *
 * - relative site paths (`/…`, but never protocol-relative `//…`),
 * - `https:` (and plain `http:` — deployments behind internal TLS terminators
 *   still need it; browsers enforce mixed-content themselves),
 * - `mailto:` for the contact surface only,
 * - `data:image/*;base64,…` for the image surface only (logo/favicon).
 *
 * `javascript:`, `vbscript:`, `file:`, unknown schemes, control characters,
 * inner whitespace and protocol-relative URLs are rejected fail-closed.
 */
export type BrandUrlContext = 'image' | 'link' | 'frame' | 'contact';

export function sanitizeBrandUrl(value: unknown, context: BrandUrlContext): string {
  if (typeof value !== 'string') throw new BrandSettingsError('the value must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new BrandSettingsError('the value must not be empty');
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new BrandSettingsError(`the value must be at most ${MAX_URL_LENGTH} characters`);
  }
  if (containsControlCodePoints(trimmed, 'url')) {
    throw new BrandSettingsError('the value must not contain whitespace or control characters');
  }
  if (trimmed.includes('\\')) throw new BrandSettingsError('the value must not contain backslashes');
  if (trimmed.startsWith('//')) throw new BrandSettingsError('protocol-relative URLs are not allowed');
  if (trimmed.startsWith('/')) return trimmed;
  if (context === 'image' && DATA_IMAGE_PATTERN.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BrandSettingsError(
      'the value must be an absolute http(s) URL, a relative path, or an allowed data: image',
    );
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
  if (context === 'contact' && parsed.protocol === 'mailto:') return parsed.toString();
  throw new BrandSettingsError(`the ${parsed.protocol} scheme is not allowed here`);
}

/** The http(s) origin of an absolute brand URL, or undefined for relative/data values. */
export function brandUrlOrigin(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function parseOptionalUrl(value: unknown, context: BrandUrlContext): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  return sanitizeBrandUrl(value, context);
}

function parseShortText(value: unknown, field: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string') throw new BrandSettingsError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw new BrandSettingsError(`${field} must be between ${minLength} and ${maxLength} characters`);
  }
  return rejectControlCharacters(trimmed, field);
}

export interface BrandMenuItem {
  readonly label: string;
  readonly url: string;
  readonly pageSlug?: string;
}

export interface BrandEndpoint {
  readonly name: string;
  readonly url: string;
  readonly description: string;
}

export type BrandCustomPageMode = 'markdown' | 'iframe';

export interface BrandCustomPage {
  readonly slug: string;
  readonly title: string;
  readonly mode: BrandCustomPageMode;
  /** Markdown mode only: the bounded page body. */
  readonly content: string;
  /** Iframe mode only: the sanitized embeddable URL. */
  readonly url: string;
  /**
   * Iframe mode parameter forwarding switches (the sub2api iframe protocol):
   * append the signed-in user id / theme / locale as query parameters.
   */
  readonly userIdParam: boolean;
  readonly themeParam: boolean;
  readonly langParam: boolean;
}

/** The public brand snapshot served to browsers (never a secret by construction). */
export interface PublicBrandSnapshot {
  readonly siteName: string;
  readonly siteSubtitle: string;
  readonly siteLogo: string;
  readonly apiBaseUrl: string;
  readonly contactUrl: string;
  readonly docUrl: string;
  readonly customMenuItems: readonly BrandMenuItem[];
  readonly customEndpoints: readonly BrandEndpoint[];
  readonly customPages: readonly BrandCustomPage[];
  readonly frameAncestors: readonly string[];
}

export const EMPTY_BRAND_SNAPSHOT: PublicBrandSnapshot = Object.freeze({
  siteName: '',
  siteSubtitle: '',
  siteLogo: '',
  apiBaseUrl: '',
  contactUrl: '',
  docUrl: '',
  customMenuItems: Object.freeze([]),
  customEndpoints: Object.freeze([]),
  customPages: Object.freeze([]),
  frameAncestors: Object.freeze([]),
});

export function isEmptyBrandSnapshot(snapshot: PublicBrandSnapshot): boolean {
  return (
    snapshot.siteName === '' &&
    snapshot.siteSubtitle === '' &&
    snapshot.siteLogo === '' &&
    snapshot.apiBaseUrl === '' &&
    snapshot.contactUrl === '' &&
    snapshot.docUrl === '' &&
    snapshot.customMenuItems.length === 0 &&
    snapshot.customEndpoints.length === 0 &&
    snapshot.customPages.length === 0 &&
    snapshot.frameAncestors.length === 0
  );
}

export function parseBrandPageSlug(value: unknown, field = 'page slug'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BRAND_PAGE_SLUG_MAX_LENGTH) {
    throw new BrandSettingsError(`${field} must be 1-${BRAND_PAGE_SLUG_MAX_LENGTH} characters`);
  }
  if (!BRAND_PAGE_SLUG_PATTERN.test(value)) {
    throw new BrandSettingsError(`${field} may contain only letters, digits, underscores and dashes`);
  }
  return value;
}

function parseBrandCustomMenuItem(value: unknown): BrandMenuItem {
  if (!isPlainObject(value)) throw new BrandSettingsError('each custom menu item must be an object');
  return {
    label: parseShortText(value.label, 'menu item label', 32),
    url: sanitizeBrandUrl(value.url, 'link'),
    ...(value.pageSlug === undefined || value.pageSlug === null
      ? {}
      : { pageSlug: parseBrandPageSlug(value.pageSlug) }),
  };
}

function parseBrandCustomEndpoint(value: unknown): BrandEndpoint {
  if (!isPlainObject(value)) throw new BrandSettingsError('each custom endpoint must be an object');
  const description =
    value.description === undefined || value.description === null
      ? ''
      : parseShortText(value.description, 'endpoint description', MAX_TEXT_LENGTH, 0);
  return {
    name: parseShortText(value.name, 'endpoint name', 64),
    url: sanitizeBrandUrl(value.url, 'link'),
    description,
  };
}

function parseBrandCustomPage(value: unknown): BrandCustomPage {
  if (!isPlainObject(value)) throw new BrandSettingsError('each custom page must be an object');
  const slug = parseBrandPageSlug(value.slug);
  const title = parseShortText(value.title, 'page title', 64);
  if (value.mode !== 'markdown' && value.mode !== 'iframe') {
    throw new BrandSettingsError('page mode must be "markdown" or "iframe"');
  }
  const mode: BrandCustomPageMode = value.mode;
  if (mode === 'markdown') {
    const content = typeof value.content === 'string' ? value.content : '';
    if (content.length === 0) throw new BrandSettingsError('a markdown page requires content');
    rejectControlCharacters(content, 'page content', 'content');
    if (Buffer.byteLength(content, 'utf8') > MAX_PAGE_MARKDOWN_BYTES) {
      throw new BrandSettingsError('markdown page content is limited to 32 KiB');
    }
    return { slug, title, mode, content, url: '', userIdParam: false, themeParam: false, langParam: false };
  }
  return {
    slug,
    title,
    mode,
    content: '',
    url: sanitizeBrandUrl(value.url, 'frame'),
    userIdParam: value.userIdParam === true,
    themeParam: value.themeParam === true,
    langParam: value.langParam === true,
  };
}

function parseBrandFrameAncestors(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new BrandSettingsError('frame_ancestors must be an array');
  if (value.length > MAX_FRAME_ANCESTORS) {
    throw new BrandSettingsError(`frame_ancestors is limited to ${MAX_FRAME_ANCESTORS} origins`);
  }
  return value.map((origin) => {
    if (typeof origin !== 'string') throw new BrandSettingsError('each frame ancestor must be a string');
    const trimmed = origin.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BrandSettingsError('each frame ancestor must be an absolute origin');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== trimmed) {
      throw new BrandSettingsError('each frame ancestor must be an exact https origin');
    }
    return parsed.origin;
  });
}

/*
 * Per-key strict parsers (the settings-registry contract). Each returns the
 * normalized stored value; a rejected value never reaches the store.
 */

export function parseBrandSiteNameSetting(value: unknown): string {
  // Empty clears the site name (the every-optional-field convention: brand
  // rows are never deleted, an empty value is the unset state).
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  return parseShortText(value, 'site name', MAX_SITE_NAME_LENGTH);
}

export function parseBrandSiteSubtitleSetting(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  return parseShortText(value, 'site subtitle', MAX_SUBTITLE_LENGTH);
}

export function parseBrandSiteLogoSetting(value: unknown): string {
  return parseOptionalUrl(value, 'image');
}

export function parseBrandApiBaseUrlSetting(value: unknown): string {
  return parseOptionalUrl(value, 'link');
}

export function parseBrandContactUrlSetting(value: unknown): string {
  return parseOptionalUrl(value, 'contact');
}

export function parseBrandDocUrlSetting(value: unknown): string {
  return parseOptionalUrl(value, 'link');
}

export function parseBrandCustomMenuItemsSetting(value: unknown): readonly BrandMenuItem[] {
  if (!Array.isArray(value)) throw new BrandSettingsError('custom_menu_items must be an array');
  if (value.length > MAX_MENU_ITEMS) {
    throw new BrandSettingsError(`custom_menu_items is limited to ${MAX_MENU_ITEMS} entries`);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const parsed = parseBrandCustomMenuItem(item);
    if (seen.has(parsed.label)) throw new BrandSettingsError('menu item labels must be unique');
    seen.add(parsed.label);
    return parsed;
  });
}

export function parseBrandCustomEndpointsSetting(value: unknown): readonly BrandEndpoint[] {
  if (!Array.isArray(value)) throw new BrandSettingsError('custom_endpoints must be an array');
  if (value.length > MAX_ENDPOINTS) {
    throw new BrandSettingsError(`custom_endpoints is limited to ${MAX_ENDPOINTS} entries`);
  }
  return value.map(parseBrandCustomEndpoint);
}

export function parseBrandCustomPagesSetting(value: unknown): readonly BrandCustomPage[] {
  if (!Array.isArray(value)) throw new BrandSettingsError('custom_pages must be an array');
  if (value.length > MAX_PAGES) throw new BrandSettingsError(`custom_pages is limited to ${MAX_PAGES} entries`);
  const seen = new Set<string>();
  return value.map((page) => {
    const parsed = parseBrandCustomPage(page);
    if (seen.has(parsed.slug)) throw new BrandSettingsError('page slugs must be unique');
    seen.add(parsed.slug);
    return parsed;
  });
}

export function parseBrandFrameAncestorsSetting(value: unknown): readonly string[] {
  return parseBrandFrameAncestors(value);
}

/**
 * Re-validates a whole snapshot object (the materialized jsonb row, or the
 * local BYOK brand.json) with the same strict grammars. Any deviation throws
 * fail-closed — a corrupted snapshot is never silently served.
 */
export function parsePublicBrandSnapshot(raw: unknown): PublicBrandSnapshot {
  if (!isPlainObject(raw)) throw new BrandSettingsError('the brand snapshot must be an object');
  const optional = <T>(present: boolean, parse: () => T, empty: T): T => (present ? parse() : empty);
  const has = (key: string): boolean => Object.hasOwn(raw, key) && raw[key] !== undefined;
  return {
    siteName: optional(has('siteName'), () => parseBrandSiteNameSetting(raw.siteName), ''),
    siteSubtitle: optional(has('siteSubtitle'), () => parseBrandSiteSubtitleSetting(raw.siteSubtitle), ''),
    siteLogo: optional(has('siteLogo'), () => parseBrandSiteLogoSetting(raw.siteLogo), ''),
    apiBaseUrl: optional(has('apiBaseUrl'), () => parseBrandApiBaseUrlSetting(raw.apiBaseUrl), ''),
    contactUrl: optional(has('contactUrl'), () => parseBrandContactUrlSetting(raw.contactUrl), ''),
    docUrl: optional(has('docUrl'), () => parseBrandDocUrlSetting(raw.docUrl), ''),
    customMenuItems: optional(has('customMenuItems'), () => parseBrandCustomMenuItemsSetting(raw.customMenuItems), []),
    customEndpoints: optional(has('customEndpoints'), () => parseBrandCustomEndpointsSetting(raw.customEndpoints), []),
    customPages: optional(has('customPages'), () => parseBrandCustomPagesSetting(raw.customPages), []),
    frameAncestors: optional(has('frameAncestors'), () => parseBrandFrameAncestorsSetting(raw.frameAncestors), []),
  };
}

/**
 * Composes the snapshot from a settings-key to stored-value map (the
 * materializer input). Absent keys fall back to the empty defaults, so an
 * unconfigured deployment materializes — and serves — the exact empty
 * snapshot.
 */
export function resolveBrandSnapshotFromSettings(values: Readonly<Record<string, unknown>>): PublicBrandSnapshot {
  const has = (key: BrandSettingsKey): boolean => Object.hasOwn(values, key) && values[key] !== undefined;
  const read = (key: BrandSettingsKey): unknown => (values as Record<string, unknown>)[key];
  return {
    siteName: has(BRAND_SETTINGS_KEYS.siteName) ? parseBrandSiteNameSetting(read(BRAND_SETTINGS_KEYS.siteName)) : '',
    siteSubtitle: has(BRAND_SETTINGS_KEYS.siteSubtitle)
      ? parseBrandSiteSubtitleSetting(read(BRAND_SETTINGS_KEYS.siteSubtitle))
      : '',
    siteLogo: has(BRAND_SETTINGS_KEYS.siteLogo) ? parseBrandSiteLogoSetting(read(BRAND_SETTINGS_KEYS.siteLogo)) : '',
    apiBaseUrl: has(BRAND_SETTINGS_KEYS.apiBaseUrl)
      ? parseBrandApiBaseUrlSetting(read(BRAND_SETTINGS_KEYS.apiBaseUrl))
      : '',
    contactUrl: has(BRAND_SETTINGS_KEYS.contactUrl)
      ? parseBrandContactUrlSetting(read(BRAND_SETTINGS_KEYS.contactUrl))
      : '',
    docUrl: has(BRAND_SETTINGS_KEYS.docUrl) ? parseBrandDocUrlSetting(read(BRAND_SETTINGS_KEYS.docUrl)) : '',
    customMenuItems: has(BRAND_SETTINGS_KEYS.customMenuItems)
      ? parseBrandCustomMenuItemsSetting(read(BRAND_SETTINGS_KEYS.customMenuItems))
      : [],
    customEndpoints: has(BRAND_SETTINGS_KEYS.customEndpoints)
      ? parseBrandCustomEndpointsSetting(read(BRAND_SETTINGS_KEYS.customEndpoints))
      : [],
    customPages: has(BRAND_SETTINGS_KEYS.customPages)
      ? parseBrandCustomPagesSetting(read(BRAND_SETTINGS_KEYS.customPages))
      : [],
    frameAncestors: has(BRAND_SETTINGS_KEYS.frameAncestors)
      ? parseBrandFrameAncestorsSetting(read(BRAND_SETTINGS_KEYS.frameAncestors))
      : [],
  };
}

/** The JSON body served by `GET /settings/public` and injected as `__APP_CONFIG__`. */
export function brandSnapshotJsonPayload(snapshot: PublicBrandSnapshot): Record<string, unknown> {
  return {
    siteName: snapshot.siteName,
    siteSubtitle: snapshot.siteSubtitle,
    siteLogo: snapshot.siteLogo,
    apiBaseUrl: snapshot.apiBaseUrl,
    contactUrl: snapshot.contactUrl,
    docUrl: snapshot.docUrl,
    customMenuItems: snapshot.customMenuItems.map((item) => ({
      label: item.label,
      url: item.url,
      ...(item.pageSlug === undefined ? {} : { pageSlug: item.pageSlug }),
    })),
    customEndpoints: snapshot.customEndpoints.map((endpoint) => ({
      name: endpoint.name,
      url: endpoint.url,
      description: endpoint.description,
    })),
    customPages: snapshot.customPages.map((page) => ({
      slug: page.slug,
      title: page.title,
      mode: page.mode,
      ...(page.mode === 'markdown'
        ? { content: page.content }
        : {
            url: page.url,
            ...(page.userIdParam ? { userIdParam: true } : {}),
            ...(page.themeParam ? { themeParam: true } : {}),
            ...(page.langParam ? { langParam: true } : {}),
          }),
    })),
    frameAncestors: [...snapshot.frameAncestors],
  };
}

/**
 * The static-serving CSP baseline (the exact managed-saas.ts / admin-server
 * header before OEM white-label). An empty snapshot must keep it
 * byte-identical — no deployment changes behavior until a brand is set.
 */
export const BRAND_CSP_BASELINE =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" as const;

/**
 * Derives the per-snapshot Content-Security-Policy:
 *
 * - baseline (byte-identical when no brand is configured and no injection
 *   nonce is supplied),
 * - the site logo's origin joins img-src,
 * - every iframe custom page's origin joins a frame-src allowlist,
 * - frame-ancestors is replaced by the configured origins (the default stays
 *   'none'; an OEM must opt in to being framed),
 * - an injection nonce adds `script-src 'self' 'nonce-…'` so the injected
 *   `__APP_CONFIG__` script and the static brand hook can run.
 *
 * Only validated http(s) origins ever enter the header (brandUrlOrigin), so a
 * configured URL can never inject CSP directives.
 */
export function buildBrandContentSecurityPolicy(
  snapshot: PublicBrandSnapshot,
  options: { readonly scriptNonce?: string } = {},
): string {
  const imageOrigins = new Set<string>();
  const logoOrigin = brandUrlOrigin(snapshot.siteLogo);
  if (logoOrigin !== undefined) imageOrigins.add(logoOrigin);

  const frameOrigins = new Set<string>();
  for (const page of snapshot.customPages) {
    if (page.mode !== 'iframe') continue;
    const origin = brandUrlOrigin(page.url);
    if (origin !== undefined) frameOrigins.add(origin);
  }

  const directives: string[] = ["default-src 'self'", "connect-src 'self'"];
  if (options.scriptNonce !== undefined) {
    directives.push(`script-src 'self' 'nonce-${options.scriptNonce}'`);
  }
  directives.push(`img-src 'self' data:${[...imageOrigins].map((origin) => ` ${origin}`).join('')}`);
  directives.push("style-src 'self' 'unsafe-inline'", "object-src 'none'", "base-uri 'self'");
  if (frameOrigins.size > 0) {
    directives.push(`frame-src 'self'${[...frameOrigins].map((origin) => ` ${origin}`).join('')}`);
  }
  directives.push(
    snapshot.frameAncestors.length === 0
      ? "frame-ancestors 'none'"
      : `frame-ancestors ${[...snapshot.frameAncestors].join(' ')}`,
  );
  return directives.join('; ');
}

/**
 * JSON serialization for inline script embedding. JSON.stringify alone does
 * not escape `<`, `>` or `&`, so a `</script>` inside any brand string would
 * break out of the script element (stored XSS). Every HTML breaker is
 * escaped to its JSON \\u form, plus the JS line separators U+2028/U+2029.
 */
export function serializeBrandAppConfigAssignment(snapshot: PublicBrandSnapshot): string {
  const json = JSON.stringify(brandSnapshotJsonPayload(snapshot));
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Placeholder nonce attribute shipped in web/index.html; rewritten per response. */
export const BRAND_CSP_NONCE_PLACEHOLDER = '__MR_CSP_NONCE__' as const;

export function generateBrandCspNonce(): string {
  return randomBytes(16).toString('base64url');
}

export interface BrandHtmlInjection {
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

/**
 * Injects the `window.__APP_CONFIG__` script before `</head>` and rewrites
 * the static hook's nonce placeholder. Returns the CSP to send alongside.
 * An empty snapshot returns the input unchanged with the baseline CSP — the
 * no-brand deployment is byte-identical by construction.
 */
export function injectBrandAppConfig(html: string, snapshot: PublicBrandSnapshot): BrandHtmlInjection {
  if (isEmptyBrandSnapshot(snapshot)) {
    return { html, contentSecurityPolicy: BRAND_CSP_BASELINE };
  }
  const nonce = generateBrandCspNonce();
  const assignment = serializeBrandAppConfigAssignment(snapshot);
  const script = `<script nonce="${nonce}">window.__APP_CONFIG__=${assignment};</script>`;
  const headClose = /<\/head>/i;
  const withConfig = headClose.test(html) ? html.replace(headClose, `${script}</head>`) : `${script}${html}`;
  return {
    html: withConfig.split(BRAND_CSP_NONCE_PLACEHOLDER).join(nonce),
    contentSecurityPolicy: buildBrandContentSecurityPolicy(snapshot, { scriptNonce: nonce }),
  };
}
