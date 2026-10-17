import type { AuthenticatedApiKey } from '../../keys/types.js';
import type { SaasGatewayQueryResult } from '../http-handler.js';
import type { SaasModelPlazaService } from './service.js';
import {
  createModelPlazaSettingsProvider,
  MODEL_PLAZA_SETTINGS_DEFAULTS,
  type ModelPlazaSettings,
} from './settings.js';
import type { ModelPlazaAccess } from './types.js';

/**
 * The plaza HTTP endpoint port (task #22): the three-tier authentication the
 * roadmap batch 5 §5.5 verification called out as missing (OptionalJWT does
 * not exist — the gateway only accepts proxy keys), modeled on sub2api's
 * OptionalJWT plaza route:
 *
 * - proxy key (Authorization: Bearer <proxy key>): full view — the publicly
 *   visible groups plus the key's authorized (effective billing) group;
 * - console session (the `mr_saas_session` cookie or the session token as a
 *   Bearer fallback): public groups plus the user's authorized groups
 *   (tenant defaults + their tenants' explicit key bindings);
 * - anonymous: public (non-exclusive) groups only.
 *
 * An invalid credential never widens access — a Bearer token that is neither
 * a live proxy key nor a live session, and an unvalidatable session (e.g. the
 * split-gateway deployment holds no saas_sessions grant), degrade to the
 * anonymous view. `require_auth` rejects anonymous callers with 401.
 */

const SESSION_COOKIE_NAME = 'mr_saas_session';
const MAX_SESSION_TOKEN_LENGTH = 4096;

/** In-process fixed-window limiter for unauthenticated-by-proxy-key callers. */
export interface ModelPlazaRateLimiter {
  take(key: string): boolean;
}

export function createModelPlazaRateLimiter(
  options: { readonly windowMs?: number; readonly limit?: number } = {},
): ModelPlazaRateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 30;
  const windows = new Map<string, number>();
  let currentWindow = 0;
  return {
    take(key: string): boolean {
      const now = Date.now();
      const window = Math.floor(now / windowMs);
      if (window !== currentWindow) {
        currentWindow = window;
        // Reset wholesale instead of per-key pruning: the map is bounded by
        // the previous window's distinct callers, and a hard cap protects
        // against key-space floods.
        windows.clear();
      }
      if (windows.size >= 10_000 && !windows.has(key)) return false;
      const count = (windows.get(key) ?? 0) + 1;
      windows.set(key, count);
      return count <= limit;
    },
  };
}

export interface SaasModelPlazaEndpointOptions {
  readonly service: SaasModelPlazaService;
  readonly settings?: () => Promise<ModelPlazaSettings>;
  /** Console-session validation; absent = the session tier degrades to anonymous. */
  readonly sessionAuth?: { readonly getSession: (token: string) => Promise<{ readonly userId: string } | null> };
  readonly rateLimiter?: ModelPlazaRateLimiter;
  readonly logError?: (message: string, error: unknown) => void;
}

export interface SaasModelPlazaServeInput {
  readonly requestId: string;
  readonly bearerToken: string | null;
  readonly sessionToken: string | null;
  readonly clientAddress: string | null;
  readonly authenticateProxyKey: (rawKey: string) => Promise<AuthenticatedApiKey | null>;
}

/** The port the gateway HTTP boundary calls for GET /v1/model-plaza. */
export interface SaasModelPlazaPort {
  serve(input: SaasModelPlazaServeInput): Promise<SaasGatewayQueryResult>;
}

export function createSaasModelPlazaEndpoint(options: SaasModelPlazaEndpointOptions): SaasModelPlazaPort {
  const settings = options.settings ?? createModelPlazaSettingsProvider({});
  const sessionAuth = options.sessionAuth;
  const rateLimiter = options.rateLimiter ?? createModelPlazaRateLimiter();
  const logError = options.logError ?? (() => {});
  return {
    async serve(input) {
      let resolved: ModelPlazaSettings;
      try {
        resolved = await settings();
      } catch (error) {
        logError('model-router model plaza settings resolution failed; failing closed', error);
        resolved = MODEL_PLAZA_SETTINGS_DEFAULTS;
      }
      if (!resolved.enabled) {
        return errorResult(404, 'PLAZA_DISABLED', 'The model plaza is not enabled', input.requestId);
      }

      const access = await resolveAccess(input, sessionAuth, logError);
      if (access === 'authentication-unavailable') {
        return errorResult(
          503,
          'AUTHENTICATION_UNAVAILABLE',
          'Proxy key authentication is temporarily unavailable',
          input.requestId,
        );
      }
      if (access.tier === 'anonymous' && resolved.requireAuth) {
        return errorResult(401, 'UNAUTHENTICATED', 'Authentication is required for the model plaza', input.requestId);
      }
      if (access.tier !== 'proxy_key') {
        const allowed = rateLimiter.take(input.clientAddress ?? 'unknown');
        if (!allowed) {
          return errorResult(429, 'PLAZA_RATE_LIMITED', 'The model plaza rate limit was exceeded', input.requestId);
        }
      }

      const response = await options.service.list({ access, settings: resolved });
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ description: response.description, groups: response.groups }),
      };
    },
  };
}

async function resolveAccess(
  input: SaasModelPlazaServeInput,
  sessionAuth: { readonly getSession: (token: string) => Promise<{ readonly userId: string } | null> } | undefined,
  logError: (message: string, error: unknown) => void,
): Promise<ModelPlazaAccess | 'authentication-unavailable'> {
  if (input.bearerToken !== null) {
    let authenticated: AuthenticatedApiKey | null = null;
    try {
      authenticated = await input.authenticateProxyKey(input.bearerToken);
    } catch (error) {
      // Key-authority storage failure is an availability problem, not an
      // invalid key: fail closed (503) rather than silently degrading.
      logError('model-router model plaza proxy key authentication failed', error);
      return 'authentication-unavailable';
    }
    if (authenticated !== null) {
      return {
        tier: 'proxy_key',
        proxyKeyCaller: {
          tenantId: authenticated.metadata.tenantId,
          projectId: authenticated.metadata.projectId,
          keyId: authenticated.metadata.id,
        },
        sessionUserId: null,
      };
    }
  }
  const sessionCandidates = [input.bearerToken, input.sessionToken].filter(
    (token): token is string => typeof token === 'string' && token !== '' && token.length <= MAX_SESSION_TOKEN_LENGTH,
  );
  if (sessionAuth !== undefined && sessionCandidates.length > 0) {
    for (const token of sessionCandidates) {
      try {
        const session = await sessionAuth.getSession(token);
        if (session !== null && typeof session.userId === 'string' && session.userId !== '') {
          return { tier: 'session', proxyKeyCaller: null, sessionUserId: session.userId };
        }
      } catch (error) {
        // Session-authority failure degrades to the anonymous view — the
        // least-privileged tier, never a widening.
        logError('model-router model plaza session validation failed; degrading to anonymous', error);
      }
    }
  }
  return { tier: 'anonymous', proxyKeyCaller: null, sessionUserId: null };
}

function errorResult(status: number, code: string, message: string, requestId: string): SaasGatewayQueryResult {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: { code, message, requestId } }),
  };
}

export { SESSION_COOKIE_NAME };
