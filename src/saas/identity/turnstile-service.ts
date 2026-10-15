/**
 * R4 registration admission (plan §R4): human-verification proof abstraction
 * for the public auth surfaces (register / login / password reset).
 *
 * sub2api semantics: the captcha layer is one of three independently optional
 * admission gates. When the switch is off, verification passes through — no
 * captcha is required and nothing is verified. When the switch is on, the
 * proof fails closed: a missing token, a network failure, or an upstream
 * rejection all reject the request.
 *
 * `CaptchaProof` is the backend-neutral normalization seam. Turnstile is the
 * first backend; a Tencent-captcha backend is reserved as the second (the
 * config type carries the selector, construction fails closed until a real
 * implementation exists).
 */

/** Minimal fetch seam so tests inject canned siteverify responses. */
export type CaptchaFetch = (url: string, init?: CaptchaFetchRequestInit) => Promise<CaptchaFetchResponse>;

export interface CaptchaFetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface CaptchaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface CaptchaProofInput {
  /** Client-issued verification token (e.g. the Turnstile widget response). */
  readonly token: string | undefined;
  /** Best-effort client IP forwarded to the provider for risk scoring. */
  readonly remoteIp?: string;
}

/** Backend-neutral proof contract mounted at each admission surface. */
export interface CaptchaProof {
  /** Backend selector reserved for the Tencent captcha implementation. */
  readonly backend: 'turnstile' | 'tencent' | 'disabled';
  verify(input: CaptchaProofInput): Promise<boolean>;
}

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,2048}$/;
const REMOTE_IP_MAX = 45;

export interface TurnstileServiceOptions {
  /** Shared secret; never the public site key. */
  readonly secret: string;
  readonly siteVerifyUrl?: string;
  readonly fetch?: CaptchaFetch;
  readonly timeoutMs?: number;
}

/**
 * Cloudflare Turnstile verification. One stateless POST per proof: the secret,
 * the widget token, and the client IP go to siteverify; only `success: true`
 * passes. Any transport or parsing failure rejects (fail-closed).
 */
export class TurnstileService {
  private readonly secret: string;
  private readonly siteVerifyUrl: string;
  private readonly fetchImpl: CaptchaFetch;
  private readonly timeoutMs: number;

  constructor(options: TurnstileServiceOptions) {
    if (
      !options ||
      typeof options.secret !== 'string' ||
      options.secret.length < 1 ||
      options.secret.length > 256 ||
      (options.siteVerifyUrl !== undefined &&
        (typeof options.siteVerifyUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(options.siteVerifyUrl))) ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000))
    ) {
      throw new TypeError('Invalid Turnstile configuration');
    }
    this.secret = options.secret;
    this.siteVerifyUrl = options.siteVerifyUrl ?? TURNSTILE_SITEVERIFY_URL;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async VerifyToken(token: string | undefined, remoteIp: string | undefined): Promise<boolean> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (typeof remoteIp === 'string' && remoteIp.length > 0 && remoteIp.length <= REMOTE_IP_MAX) {
      body.set('remoteip', remoteIp);
    }
    let payload: unknown;
    try {
      const response = await this.fetchImpl(this.siteVerifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      payload = await response.json();
    } catch {
      // Fail closed: a network or parsing failure never admits a request.
      return false;
    }
    return payload !== null && typeof payload === 'object' && (payload as { success?: unknown }).success === true;
  }
}

/**
 * sub2api pass-through proof: the captcha switch is off. Every input passes
 * without verification; this is the default so an unconfigured deployment
 * behaves exactly like the pre-R4 auth surfaces.
 */
export const DISABLED_CAPTCHA_PROOF: CaptchaProof = Object.freeze({
  backend: 'disabled',
  verify: async () => true,
});

export type CaptchaProofConfig =
  | { readonly backend: 'disabled' }
  | { readonly backend: 'turnstile'; readonly secret: string }
  | {
      /** Reserved second backend; construction fails closed until implemented. */
      readonly backend: 'tencent';
      readonly secret: string;
      readonly captchaAppId?: string;
    };

/**
 * Normalization factory. Unknown or reserved-but-unimplemented backends throw
 * at construction (startup), never silently degrade into pass-through.
 */
export function createCaptchaProof(config: CaptchaProofConfig): CaptchaProof {
  if (!config || typeof config !== 'object') throw new TypeError('Invalid captcha proof configuration');
  if (config.backend === 'disabled') return DISABLED_CAPTCHA_PROOF;
  if (config.backend === 'turnstile') {
    return {
      backend: 'turnstile',
      verify: (input) => new TurnstileService({ secret: config.secret }).VerifyToken(input.token, input.remoteIp),
    };
  }
  // Reserved: fail closed rather than admitting unverified traffic.
  throw new TypeError('Captcha backend not implemented');
}
