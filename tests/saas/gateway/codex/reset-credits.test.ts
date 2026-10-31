import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWhamConsumeResetCreditsRequest,
  CODEX_RESET_CREDIT_RESET_TYPE,
  CODEX_RESET_CREDIT_STATUS_AVAILABLE,
  type CodexResetCredit,
  generateResetCreditsIdempotencyKey,
  isResetCreditAvailable,
  mapWhamResetCreditEntry,
  parseWhamResetCreditsResponse,
  WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  WHAM_RATE_LIMIT_RESET_CREDITS_URL,
} from '../../../../src/saas/gateway/codex/reset-credits.js';

const NOW = Date.parse('2026-07-01T00:00:00Z');

function credit(overrides: Partial<CodexResetCredit>): CodexResetCredit {
  return {
    id: 'credit-1',
    resetType: CODEX_RESET_CREDIT_RESET_TYPE,
    status: CODEX_RESET_CREDIT_STATUS_AVAILABLE,
    expiresAt: '2026-07-04T04:05:06Z',
    expiryAtMs: Date.parse('2026-07-04T04:05:06Z'),
    ...overrides,
  };
}

test('the reset-credit endpoints point at the chatgpt.com quota plane', () => {
  assert.equal(WHAM_RATE_LIMIT_RESET_CREDITS_URL, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(
    WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  );
});

test('parseWhamResetCreditsResponse keeps only codex_rate_limits credits that are available and not yet expired-listed', () => {
  const body = {
    available_count: 2,
    credits: [
      // redeemed status is filtered out (s2a openai_quota_reset_credits.go:91-93)
      { reset_type: 'codex_rate_limits', status: 'redeemed', expires_at: '2026-07-01T04:05:06Z' },
      { id: 'credit-later', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-07-04T04:05:06Z' },
      // camelCase variants are accepted (s2a payload struct, lines 10-19)
      {
        creditId: 'credit-earlier',
        resetType: 'codex_rate_limits',
        status: 'available',
        expiresAt: '2026-07-03T04:05:06Z',
      },
      // other reset types are filtered out (lines 88-90)
      { reset_type: 'other', status: 'available', expires_at: '2026-07-02T04:05:06Z' },
      // entries without an expiry are dropped from the details list (lines 99-101)
      { id: 'credit-no-expiry', reset_type: 'codex_rate_limits', status: 'available' },
      // empty status / empty reset_type pass through (s2a allows blank values)
      { id: 'credit-blank-status', reset_type: 'codex_rate_limits', expires_at: '2026-07-05T04:05:06Z' },
    ],
  };
  const credits = parseWhamResetCreditsResponse(body);
  assert.deepEqual(
    credits.map((c) => c.id),
    ['credit-later', 'credit-earlier', 'credit-blank-status'],
  );
  assert.deepEqual(
    credits.map((c) => c.expiresAt),
    ['2026-07-04T04:05:06Z', '2026-07-03T04:05:06Z', '2026-07-05T04:05:06Z'],
  );
  // expiryAtMs is the parsed epoch-ms projection of expiresAt.
  assert.equal(credits[0]?.expiryAtMs, Date.parse('2026-07-04T04:05:06Z'));
  assert.equal(credits[2]?.status, null);
  // available_count itself is not projected (count precedence belongs to the transport).
  const fromBareArray = parseWhamResetCreditsResponse([
    { credit_id: 'c1', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-07-04T04:05:06Z' },
  ]);
  assert.equal(fromBareArray.length, 1);
  assert.equal(fromBareArray[0]?.id, 'c1');
});

test('parseWhamResetCreditsResponse accepts the alternate container keys s2a probes', () => {
  const entry = { reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-07-04T04:05:06Z' };
  assert.equal(parseWhamResetCreditsResponse({ rate_limit_reset_credits: [entry] }).length, 1);
  assert.equal(parseWhamResetCreditsResponse({ items: [entry] }).length, 1);
  assert.equal(parseWhamResetCreditsResponse({ data: [entry] }).length, 1);
  // `credits` wins over the later container keys.
  const both = parseWhamResetCreditsResponse({ credits: [{ id: 'from-credits', ...entry }], items: [entry] });
  assert.equal(both.length, 1);
  assert.equal(both[0]?.id, 'from-credits');
  // Empty list is a present list, not a malformed one.
  assert.deepEqual(parseWhamResetCreditsResponse({ credits: [] }), []);
  // Case-insensitive status/reset-type matching (s2a uses EqualFold).
  assert.equal(
    parseWhamResetCreditsResponse([
      { reset_type: 'CODEX_RATE_LIMITS', status: 'AVAILABLE', expires_at: '2026-07-04T04:05:06Z' },
    ]).length,
    1,
  );
});

test('parseWhamResetCreditsResponse returns an empty array for malformed bodies', () => {
  assert.deepEqual(parseWhamResetCreditsResponse(null), []);
  assert.deepEqual(parseWhamResetCreditsResponse(undefined), []);
  assert.deepEqual(parseWhamResetCreditsResponse('nope'), []);
  assert.deepEqual(parseWhamResetCreditsResponse(42), []);
  // An object without any credit container carries no credits.
  assert.deepEqual(parseWhamResetCreditsResponse({}), []);
  assert.deepEqual(parseWhamResetCreditsResponse({ available_count: 3 }), []);
  // A non-array authoritative container is malformed (s2a errors out).
  assert.deepEqual(parseWhamResetCreditsResponse({ credits: 'malformed' }), []);
  assert.deepEqual(parseWhamResetCreditsResponse({ items: {} }), []);
  // Non-object entries are skipped.
  assert.deepEqual(parseWhamResetCreditsResponse([null, 42, 'x']), []);
});

test('mapWhamResetCreditEntry is lenient for the embedded usage summary', () => {
  // The /wham/usage body embeds credits that carry only expires_at; no filtering runs.
  const embedded = mapWhamResetCreditEntry({ expires_at: 'usage-expiry' });
  assert.notEqual(embedded, null);
  assert.equal(embedded?.expiresAt, 'usage-expiry');
  assert.equal(embedded?.expiryAtMs, null);
  assert.equal(embedded?.status, null);
  const consumed = mapWhamResetCreditEntry({ status: 'consumed', expiresAt: '2026-07-04T04:05:06Z' });
  assert.equal(consumed?.status, 'consumed');
  assert.equal(mapWhamResetCreditEntry(null), null);
  assert.equal(mapWhamResetCreditEntry('x'), null);
});

test('buildWhamConsumeResetCreditsRequest puts the key in redeem_request_id', () => {
  const request = buildWhamConsumeResetCreditsRequest({ idempotencyKey: 'key-1' });
  assert.equal(request.url, WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.idempotencyKey, 'key-1');
  assert.deepEqual(request.body, { redeem_request_id: 'key-1' });

  const targeted = buildWhamConsumeResetCreditsRequest({ idempotencyKey: 'key-1', creditId: 'credit-1' });
  assert.deepEqual(targeted.body, { redeem_request_id: 'key-1', credit_id: 'credit-1' });
  // Keys are trimmed like s2a's ResetCreditTargeted (openai_quota_service.go:352-353).
  const trimmed = buildWhamConsumeResetCreditsRequest({ idempotencyKey: '  key-1  ' });
  assert.equal(trimmed.idempotencyKey, 'key-1');
  assert.equal(trimmed.body.redeem_request_id, 'key-1');
});

test('buildWhamConsumeResetCreditsRequest rejects blank keys instead of building a broken request', () => {
  assert.throws(() => buildWhamConsumeResetCreditsRequest({ idempotencyKey: '' }), /non-empty idempotency key/);
  assert.throws(() => buildWhamConsumeResetCreditsRequest({ idempotencyKey: '   ' }), /non-empty idempotency key/);
  assert.throws(
    () => buildWhamConsumeResetCreditsRequest({ idempotencyKey: 'key-1', creditId: '' }),
    /non-empty credit id/,
  );
});

test('generateResetCreditsIdempotencyKey produces distinct UUIDv4 values', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const first = generateResetCreditsIdempotencyKey();
  const second = generateResetCreditsIdempotencyKey();
  assert.match(first, uuid);
  assert.match(second, uuid);
  assert.notEqual(first, second);
});

test('isResetCreditAvailable requires an available status and a future expiry', () => {
  assert.equal(isResetCreditAvailable(credit({}), NOW), true);
  // Case-insensitive status, like s2a's EqualFold.
  assert.equal(isResetCreditAvailable(credit({ status: 'AVAILABLE' }), NOW), true);
  // Blank status counts as available (s2a's filter lets empty values pass).
  assert.equal(isResetCreditAvailable(credit({ status: null }), NOW), true);
  // Consumed/redeemed statuses are never available.
  assert.equal(isResetCreditAvailable(credit({ status: 'consumed' }), NOW), false);
  assert.equal(isResetCreditAvailable(credit({ status: 'redeemed' }), NOW), false);
  assert.equal(isResetCreditAvailable(null, NOW), false);
});

test('isResetCreditAvailable expiry boundaries', () => {
  const expiry = Date.parse('2026-07-02T00:00:00Z');
  const base = credit({ expiryAtMs: expiry, expiresAt: '2026-07-02T00:00:00Z' });
  // One millisecond before expiry is available; at and past expiry is not.
  assert.equal(isResetCreditAvailable(base, expiry - 1), true);
  assert.equal(isResetCreditAvailable(base, expiry), false);
  assert.equal(isResetCreditAvailable(base, expiry + 1), false);
  // Unknown expiry fails closed: a credit that cannot be aged out is not offered.
  assert.equal(isResetCreditAvailable(credit({ expiryAtMs: null }), NOW), false);
  assert.equal(isResetCreditAvailable(credit({ expiryAtMs: Number.NaN }), NOW), false);
});
