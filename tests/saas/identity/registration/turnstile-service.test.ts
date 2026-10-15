import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CaptchaFetch,
  type CaptchaFetchResponse,
  createCaptchaProof,
  DISABLED_CAPTCHA_PROOF,
  TURNSTILE_SITEVERIFY_URL,
  TurnstileService,
} from '../../../../src/saas/identity/turnstile-service.js';

const SECRET = ['unit', 'turnstile', 'secret'].join('-');
const TOKEN = 'unit-turnstile-token-0123456789abcdef';
const REMOTE_IP = '203.0.113.7';

function jsonResponse(payload: unknown, status = 200): CaptchaFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

interface FetchTrace {
  url: string;
  body: string;
}

function fetchWith(respond: (trace: FetchTrace) => CaptchaFetchResponse): {
  fetch: CaptchaFetch;
  traces: FetchTrace[];
} {
  const traces: FetchTrace[] = [];
  const fetch: CaptchaFetch = async (url, init) => {
    const trace = { url, body: init?.body ?? '' };
    traces.push(trace);
    return respond(trace);
  };
  return { fetch, traces };
}

test('VerifyToken posts secret/response/remoteip form-encoded to siteverify', async () => {
  const { fetch, traces } = fetchWith(() => jsonResponse({ success: true }));
  const service = new TurnstileService({ secret: SECRET, fetch });
  assert.equal(await service.VerifyToken(TOKEN, REMOTE_IP), true);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.url, TURNSTILE_SITEVERIFY_URL);
  const params = new URLSearchParams(traces[0]?.body ?? '');
  assert.equal(params.get('secret'), SECRET);
  assert.equal(params.get('response'), TOKEN);
  assert.equal(params.get('remoteip'), REMOTE_IP);
});

test('VerifyToken rejects success:false, HTTP errors, malformed payloads and network failures', async () => {
  const failing = new TurnstileService({
    secret: SECRET,
    fetch: fetchWith(() => jsonResponse({ success: false, 'error-codes': ['invalid-input-secret'] })).fetch,
  });
  assert.equal(await failing.VerifyToken(TOKEN, REMOTE_IP), false);

  const httpError = new TurnstileService({
    secret: SECRET,
    fetch: fetchWith(() => jsonResponse({}, 503)).fetch,
  });
  assert.equal(await httpError.VerifyToken(TOKEN, REMOTE_IP), false);

  const malformed = new TurnstileService({
    secret: SECRET,
    fetch: fetchWith(() => jsonResponse('not-an-object')).fetch,
  });
  assert.equal(await malformed.VerifyToken(TOKEN, REMOTE_IP), false);

  const unreachable = new TurnstileService({
    secret: SECRET,
    fetch: async () => {
      throw new Error('unit network failure');
    },
  });
  assert.equal(await unreachable.VerifyToken(TOKEN, REMOTE_IP), false, 'network failure fails closed');
});

test('VerifyToken rejects missing, malformed or oversized tokens without any network call', async () => {
  const { fetch, traces } = fetchWith(() => jsonResponse({ success: true }));
  const service = new TurnstileService({ secret: SECRET, fetch });
  assert.equal(await service.VerifyToken(undefined, REMOTE_IP), false);
  assert.equal(await service.VerifyToken('', REMOTE_IP), false);
  assert.equal(await service.VerifyToken('short', REMOTE_IP), false);
  assert.equal(await service.VerifyToken('x'.repeat(5000), REMOTE_IP), false);
  assert.equal(traces.length, 0);
});

test('the disabled proof passes through (sub2api switch-off semantics)', async () => {
  assert.equal(DISABLED_CAPTCHA_PROOF.backend, 'disabled');
  assert.equal(await DISABLED_CAPTCHA_PROOF.verify({ token: undefined, remoteIp: undefined }), true);
});

test('createCaptchaProof: turnstile backend delegates; tencent is reserved and fails closed at construction', async () => {
  const { fetch } = fetchWith(() => jsonResponse({ success: true }));
  const proof = createCaptchaProof({ backend: 'turnstile', secret: SECRET });
  assert.equal(proof.backend, 'turnstile');
  // The proof uses the ambient fetch seam; the missing token fails before
  // any request is made.
  assert.equal(await proof.verify({ token: undefined, remoteIp: REMOTE_IP }), false);
  void fetch;
  assert.throws(() => createCaptchaProof({ backend: 'tencent', secret: SECRET }), TypeError);
  assert.equal(createCaptchaProof({ backend: 'disabled' }), DISABLED_CAPTCHA_PROOF);
});

test('construction validates the configuration shape', () => {
  assert.throws(() => new TurnstileService({ secret: '' }), TypeError);
  // @ts-expect-error deliberately invalid configuration
  assert.throws(() => new TurnstileService({}), TypeError);
  assert.throws(() => new TurnstileService({ secret: SECRET, siteVerifyUrl: 'http://insecure.example' }), TypeError);
  assert.throws(() => new TurnstileService({ secret: SECRET, timeoutMs: 1 }), TypeError);
});
