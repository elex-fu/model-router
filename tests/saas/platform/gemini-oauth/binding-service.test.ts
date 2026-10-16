import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_BINDING_SESSION_TTL_MS,
  GeminiOAuthBindingService,
  type GeminiOauthFetch,
  InMemoryBindingSessionStore,
  parseLoadCodeAssistResponse,
} from '../../../../src/saas/platform/gemini-oauth/binding-service.js';
import { GeminiOAuthError } from '../../../../src/saas/platform/gemini-oauth/oauth.js';

const NOW_MS = 1_700_000_000_000;
const CLIENT_SECRET = 'test-installed-app-secret';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly form: URLSearchParams | null;
}

function tokenResponseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'accs-gemini',
    refresh_token: 'rfrsh-gemini',
    expires_in: 3_600,
    ...overrides,
  });
}

function loadCodeAssistBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cloudaicompanionProject: 'project-4242',
    allowedTiers: [{ id: 'standard-tier', isDefault: true }],
    ...overrides,
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch double that answers the fixed endpoints in call order: the
 * form-urlencoded token POST at oauth2.googleapis.com and the JSON
 * loadCodeAssist/onboardUser POSTs at cloudcode-pa.googleapis.com.
 */
function harness(
  responses: Array<Response | Error> = [jsonResponse(tokenResponseBody()), jsonResponse(loadCodeAssistBody())],
): {
  service: GeminiOAuthBindingService;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const queue = [...responses];
  const fetcher = (async (url: URL, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const bodyText = String(init.body);
    const isForm = (headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
    seen.push({
      url: url.href,
      method: init.method ?? 'POST',
      headers,
      body: isForm ? {} : JSON.parse(bodyText),
      form: isForm ? new URLSearchParams(bodyText) : null,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as GeminiOauthFetch;
  const service = new GeminiOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(() => NOW_MS),
    fetch: fetcher,
    nowMs: () => NOW_MS,
    clientSecret: CLIENT_SECRET,
  });
  return { service, seen };
}

test('generateBindingSession stores PKCE state with the 30-minute TTL', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  assert.match(start.state, /^[0-9a-f]{64}$/);
  const url = start.authorizeUrl;
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('state'), start.state);
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  // Distinct sessions never share state.
  const second = await h.service.generateBindingSession();
  assert.notEqual(second.state, start.state);
});

test('completeBinding exchanges the code as a form POST then resolves the project', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const envelope = await h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  assert.equal(h.seen.length, 2);

  // 1. The token exchange is a form-urlencoded POST to Google's token endpoint.
  const tokenRequest = h.seen[0] as Seen;
  assert.equal(tokenRequest.url, 'https://oauth2.googleapis.com/token');
  assert.equal(tokenRequest.method, 'POST');
  assert.equal(tokenRequest.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tokenRequest.headers['user-agent'], 'model-router');
  assert.ok(tokenRequest.form);
  assert.equal(tokenRequest.form.get('grant_type'), 'authorization_code');
  assert.equal(
    tokenRequest.form.get('client_id'),
    '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  );
  assert.equal(tokenRequest.form.get('client_secret'), CLIENT_SECRET);
  assert.equal(tokenRequest.form.get('code'), 'c'.repeat(40));
  assert.equal(typeof tokenRequest.form.get('code_verifier'), 'string');
  assert.equal(tokenRequest.form.get('redirect_uri'), 'https://codeassist.google.com/authcode');

  // 2. The loadCodeAssist call carries the CLI metadata block and pinned UA.
  const codeAssist = h.seen[1] as Seen;
  assert.equal(codeAssist.url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal(codeAssist.method, 'POST');
  assert.equal(codeAssist.headers.authorization, 'Bearer accs-gemini');
  assert.equal(codeAssist.headers['user-agent'], 'GeminiCLI/0.1.5 (Windows; AMD64)');
  assert.equal(codeAssist.headers['content-type'], 'application/json');
  assert.deepEqual(codeAssist.body, {
    metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  });

  // The envelope carries the project/tier coordinates, no token echoes
  // beyond the material itself.
  assert.deepEqual(envelope, {
    accessToken: 'accs-gemini',
    refreshToken: 'rfrsh-gemini',
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    projectId: 'project-4242',
    tierId: 'standard-tier',
    email: null,
  });
});

test('the state is single-use: a replayed binding session is not found', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  await h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  await assert.rejects(h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof GeminiOAuthError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
});

test('an expired session, bad state shape and bad code shape fail closed', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const expired = new GeminiOAuthBindingService({
    sessionStore: {
      put: async () => undefined,
      take: async () => ({ state: start.state, codeVerifier: 'v', expiresAtMs: NOW_MS - 1 }),
    },
    nowMs: () => NOW_MS,
    fetch: async () => jsonResponse(tokenResponseBody()),
    clientSecret: CLIENT_SECRET,
  });
  await assert.rejects(expired.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof GeminiOAuthError);
    assert.equal(error.code, 'SESSION_EXPIRED');
    return true;
  });
  for (const bad of [
    { state: 'short', code: 'c'.repeat(40) },
    { state: start.state, code: 'too-short' },
    { state: start.state, code: 'x'.repeat(2_049) },
  ]) {
    await assert.rejects(h.service.completeBinding(bad), (error: unknown) => {
      assert.ok(error instanceof GeminiOAuthError);
      assert.equal(error.code, bad.state === 'short' ? 'STATE_INVALID' : 'CODE_INVALID');
      return true;
    });
  }
});

test('a missing installed-app client secret fails closed before any upstream call', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const noSecret = new GeminiOAuthBindingService({
    // clientSecret: null explicitly — undefined would read the environment.
    clientSecret: null,
    sessionStore: {
      put: async () => undefined,
      take: async () => ({ state: start.state, codeVerifier: 'v', expiresAtMs: NOW_MS + 60_000 }),
    },
    nowMs: () => NOW_MS,
    fetch: async () => jsonResponse(tokenResponseBody()),
  });
  await assert.rejects(noSecret.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof GeminiOAuthError);
    assert.equal(error.code, 'CLIENT_SECRET_MISSING');
    return true;
  });
  assert.equal(h.seen.length, 0);
});

test('token endpoint rejections and malformed responses never leak material', async () => {
  for (const [responses, code] of [
    [[new Response('{"error":"invalid_grant"}', { status: 400 })], 'TOKEN_EXCHANGE_FAILED'],
    [[jsonResponse('not json')], 'TOKEN_RESPONSE_INVALID'],
    [[jsonResponse(tokenResponseBody({ expires_in: 0 }))], 'TOKEN_RESPONSE_INVALID'],
    [[jsonResponse(tokenResponseBody({ refresh_token: undefined }))], 'TOKEN_RESPONSE_INVALID'],
    [[new Error('network down')], 'TOKEN_EXCHANGE_FAILED'],
  ] as const) {
    const h = harness(responses as Array<Response | Error>);
    const start = await h.service.generateBindingSession();
    await assert.rejects(h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
      assert.ok(error instanceof GeminiOAuthError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('accs-gemini') || error.message.includes('rfrsh-gemini'), false);
      return true;
    });
  }
});

test('a loadCodeAssist failure is a project resolution failure, never a token leak', async () => {
  const h = harness([jsonResponse(tokenResponseBody()), new Response('forbidden', { status: 403 })]);
  const start = await h.service.generateBindingSession();
  await assert.rejects(h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof GeminiOAuthError);
    assert.equal(error.code, 'PROJECT_RESOLUTION_FAILED');
    return true;
  });
  assert.equal(h.seen.length, 2);
});

test('parseLoadCodeAssist prefers paid/current tiers then the default allowed tier', () => {
  const base = { cloudaicompanionProject: 'project-1' };
  assert.deepEqual(parseLoadCodeAssistResponse({ ...base, allowedTiers: [{ id: 'standard-tier', isDefault: true }] }), {
    projectId: 'project-1',
    tierId: 'standard-tier',
  });
  // The allowed-tier fallback is the raw tier string, whatever Google returns.
  assert.deepEqual(parseLoadCodeAssistResponse({ ...base, allowedTiers: [{ id: 'first' }, { id: 'second' }] }), {
    projectId: 'project-1',
    tierId: 'first',
  });
  assert.deepEqual(
    parseLoadCodeAssistResponse({ ...base, paidTier: { id: 'google_ai_pro' }, currentTier: { id: 'other' } }),
    { projectId: 'project-1', tierId: 'google_ai_pro' },
  );
  assert.deepEqual(parseLoadCodeAssistResponse({ ...base, currentTier: { id: 'current-tier' } }), {
    projectId: 'project-1',
    tierId: 'current-tier',
  });
  // No tier at all means the account still needs onboarding; a missing or
  // malformed project is a resolution failure.
  assert.deepEqual(parseLoadCodeAssistResponse(base), { projectId: 'project-1', tierId: null });
  assert.equal(parseLoadCodeAssistResponse({}), null);
  assert.equal(parseLoadCodeAssistResponse({ cloudaicompanionProject: '' }), null);
  assert.equal(parseLoadCodeAssistResponse('text'), null);
});

test('a tierless loadCodeAssist triggers onboarding with LEGACY and a re-resolve', async () => {
  const h = harness([
    jsonResponse(tokenResponseBody()),
    jsonResponse(loadCodeAssistBody({ allowedTiers: [] })),
    jsonResponse(JSON.stringify({ done: true })),
    jsonResponse(loadCodeAssistBody({ allowedTiers: [{ id: 'gcp_standard', isDefault: true }] })),
  ]);
  const start = await h.service.generateBindingSession();
  const envelope = await h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  assert.equal(h.seen.length, 4);
  // Token, tierless loadCodeAssist, onboardUser, second loadCodeAssist.
  assert.equal(h.seen[1]?.url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal(h.seen[2]?.url, 'https://cloudcode-pa.googleapis.com/v1internal:onboardUser');
  assert.deepEqual(h.seen[2]?.body, {
    tierId: 'LEGACY',
    metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  });
  assert.equal(h.seen[2]?.headers['user-agent'], 'GeminiCLI/0.1.5 (Windows; AMD64)');
  assert.equal(h.seen[3]?.url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal(envelope.projectId, 'project-4242');
  assert.equal(envelope.tierId, 'gcp_standard');
  // The session TTL constant matches the claude binding contract.
  assert.equal(GEMINI_BINDING_SESSION_TTL_MS, 30 * 60_000);
});
