/**
 * Model plaza settings (roadmap batch 5 §5.5, task #22).
 *
 * The plaza's runtime switches follow the F1 platform-settings pattern
 * (the registration-admission precedent, verbatim): reserved `saas.plaza.*`
 * store keys are the authoritative surface, resolved store-first with an
 * environment fallback, and defaults are fail-closed — the plaza is DISABLED
 * until the operator turns it on, anonymous access is allowed unless
 * `require_auth` is set, and no group is exclusive unless listed.
 *
 * Store coordination note (#20): the gateway workload role holds no grant on
 * `saas_platform_settings` (migration 110's fail-closed secret-isolation
 * stance), so a dedicated gateway deployment resolves these switches from the
 * environment only. Deployments whose database connection carries control-plane
 * grants (combined / control-plane workloads) read the store overlay live at
 * request time. The #20 OEM/white-label "public settings snapshot" face is the
 * planned single read path for gateway-role deployments; until it lands, the
 * split-gateway env fallback is the documented posture.
 */

export interface ModelPlazaSettings {
  /** Master switch; false serves 404 PLAZA_DISABLED. Default false. */
  readonly enabled: boolean;
  /** When true, unauthenticated callers receive 401 instead of the anonymous view. */
  readonly requireAuth: boolean;
  /** Free-text plaza description echoed at the top of the response. */
  readonly description: string;
  /**
   * Group ids treated as exclusive (专属分组): visible only to callers whose
   * access tier authorizes that group. Anonymous callers never see them.
   * Billing groups carry no exclusivity column (zero-migration plaza design),
   * so the showcase-level flag lives here; a future groups migration can move
   * it onto the row.
   */
  readonly exclusiveGroupIds: ReadonlySet<string>;
}

/** Reserved platform-settings store keys (closed registry, `saas.` prefix). */
export const MODEL_PLAZA_SETTINGS_KEYS = Object.freeze({
  enabled: 'saas.plaza.enabled',
  requireAuth: 'saas.plaza.require_auth',
  description: 'saas.plaza.description',
  exclusiveGroups: 'saas.plaza.exclusive_groups',
} as const);

/** Environment variable names backing each settings key in managed mode. */
export const MODEL_PLAZA_ENV_VARS = Object.freeze({
  enabled: 'MODEL_ROUTER_SAAS_MODEL_PLAZA_ENABLED',
  requireAuth: 'MODEL_ROUTER_SAAS_MODEL_PLAZA_REQUIRE_AUTH',
  description: 'MODEL_ROUTER_SAAS_MODEL_PLAZA_DESCRIPTION',
  exclusiveGroups: 'MODEL_ROUTER_SAAS_MODEL_PLAZA_EXCLUSIVE_GROUPS',
} as const);

export const MODEL_PLAZA_SETTINGS_DEFAULTS: Readonly<ModelPlazaSettings> = Object.freeze({
  enabled: false,
  requireAuth: false,
  description: '',
  exclusiveGroupIds: new Set<string>(),
});

const MAX_DESCRIPTION_LENGTH = 512;
const MAX_EXCLUSIVE_GROUPS = 64;
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ModelPlazaSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPlazaSettingsError';
  }
}

function fail(message: string): never {
  throw new ModelPlazaSettingsError(message);
}

/**
 * Strict per-key grammar for STORE values (the platform-settings registry
 * parser). Store values arrive typed (JSON envelope inner value); anything
 * outside the grammar is rejected so the store can never hold a value the
 * runtime resolver would silently misread.
 */
export function parseModelPlazaSettingValue(key: string, value: unknown): unknown {
  switch (key) {
    case MODEL_PLAZA_SETTINGS_KEYS.enabled:
    case MODEL_PLAZA_SETTINGS_KEYS.requireAuth:
      if (typeof value !== 'boolean') fail(`${key} must be a boolean`);
      return value;
    case MODEL_PLAZA_SETTINGS_KEYS.description:
      return parseDescription(value);
    case MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups:
      return [...parseExclusiveGroups(value)];
    default:
      fail(`${key} is not a model-plaza settings key`);
  }
}

function parseDescription(value: unknown): string {
  if (typeof value !== 'string') fail('the plaza description must be a string');
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    fail(`the plaza description is limited to ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if ([...trimmed].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) {
    fail('the plaza description must not contain control characters');
  }
  return trimmed;
}

function parseExclusiveGroups(value: unknown): ReadonlySet<string> {
  if (value === null || value === undefined) return MODEL_PLAZA_SETTINGS_DEFAULTS.exclusiveGroupIds;
  let source: readonly unknown[];
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return MODEL_PLAZA_SETTINGS_DEFAULTS.exclusiveGroupIds;
    source = trimmed.split(',');
  } else {
    fail('exclusive groups must be a list of group ids');
  }
  if (source.length > MAX_EXCLUSIVE_GROUPS) {
    fail(`at most ${MAX_EXCLUSIVE_GROUPS} exclusive groups may be listed`);
  }
  const ids = new Set<string>();
  for (const entry of source) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (!GROUP_ID_PATTERN.test(id)) fail(`"${entry}" is not a valid billing group id`);
    if (ids.has(id)) fail(`"${id}" is listed twice`);
    ids.add(id);
  }
  return ids;
}

/**
 * Store-first resolution with env fallback (the
 * `resolveRegistrationAdmissionSettings` contract). A present overlay value
 * wins; an invalid overlay value fails closed with an error so a
 * misconfigured store can never widen plaza visibility silently — callers
 * decide whether to degrade to the fail-closed defaults.
 */
export function resolveModelPlazaSettings(
  overlay: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): ModelPlazaSettings {
  const overlayValue = (key: string): unknown => (overlay !== undefined && key in overlay ? overlay[key] : undefined);
  const envValue = (name: string): string | undefined => {
    const value = env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  const enabled = overlayBoolean(overlayValue(MODEL_PLAZA_SETTINGS_KEYS.enabled), 'enabled');
  const requireAuth = overlayBoolean(overlayValue(MODEL_PLAZA_SETTINGS_KEYS.requireAuth), 'require_auth');
  const overlayDescription = overlayValue(MODEL_PLAZA_SETTINGS_KEYS.description);
  const envDescription = envValue(MODEL_PLAZA_ENV_VARS.description);
  const description =
    overlayDescription !== undefined
      ? parseDescription(overlayDescription)
      : envDescription === undefined
        ? MODEL_PLAZA_SETTINGS_DEFAULTS.description
        : parseDescription(envDescription);
  const overlayGroups = overlayValue(MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups);
  let exclusiveGroupIds: ReadonlySet<string>;
  if (overlayGroups !== undefined) {
    exclusiveGroupIds = parseExclusiveGroups(overlayGroups);
  } else {
    const envGroups = envValue(MODEL_PLAZA_ENV_VARS.exclusiveGroups);
    exclusiveGroupIds =
      envGroups === undefined ? MODEL_PLAZA_SETTINGS_DEFAULTS.exclusiveGroupIds : parseExclusiveGroups(envGroups);
  }
  return { enabled, requireAuth, description, exclusiveGroupIds };

  function overlayBoolean(value: unknown, name: 'enabled' | 'require_auth'): boolean {
    if (value !== undefined) {
      if (typeof value !== 'boolean') fail(`${name} must be a boolean`);
      return value;
    }
    const raw = envValue(name === 'enabled' ? MODEL_PLAZA_ENV_VARS.enabled : MODEL_PLAZA_ENV_VARS.requireAuth);
    if (raw === undefined) return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    fail(`${name} must be "true" or "false"`);
  }
}

/**
 * The production settings provider: store overlay (when the deployment's
 * database role can read the settings store) over the environment, failing
 * closed to the disabled-by-default posture on any resolution error. The
 * overlay reader is expected to swallow unreadable-store errors itself
 * (permission-denied on the split-gateway role is a documented posture, not
 * an incident) and return `{}`; a resolver failure here still degrades to
 * defaults rather than serving a possibly-stale visibility configuration.
 */
export function createModelPlazaSettingsProvider(options: {
  readonly overlay?: () => Promise<Readonly<Record<string, unknown>>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): () => Promise<ModelPlazaSettings> {
  const overlay = options.overlay;
  const env = options.env ?? process.env;
  return async () => {
    let overlayValues: Readonly<Record<string, unknown>> = {};
    try {
      overlayValues = overlay === undefined ? {} : await overlay();
    } catch {
      overlayValues = {};
    }
    try {
      return resolveModelPlazaSettings(overlayValues, env);
    } catch {
      return MODEL_PLAZA_SETTINGS_DEFAULTS;
    }
  };
}
