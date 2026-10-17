import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VERTEX_RATE_LIMIT_FALLBACK_MS,
  VERTEX_RATE_LIMIT_RETRY_INFO_MAX_MS,
} from '../../../../src/saas/gateway/vertex/constants.js';
import {
  classifyVertex429,
  isVertexDailyQuotaExhaustion,
  VERTEX_RESOURCE_EXHAUSTED_STATUS,
} from '../../../../src/saas/gateway/vertex/quota-headers.js';

const NOW = 1_700_000_000_000;

function googleErrorBody(input: {
  readonly status?: string;
  readonly message?: string;
  readonly retryDelay?: string;
}): string {
  return JSON.stringify({
    error: {
      code: 429,
      ...(input.status === undefined ? {} : { status: input.status }),
      message: input.message ?? 'Resource has been exhausted',
      ...(input.retryDelay === undefined
        ? {}
        : {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: input.retryDelay,
              },
            ],
          }),
    },
  });
}

test('a RetryInfo retryDelay sets the reset point (the sub2api "39s" Vertex shape)', () => {
  const result = classifyVertex429(
    { headers: {}, bodyText: googleErrorBody({ status: VERTEX_RESOURCE_EXHAUSTED_STATUS, retryDelay: '39s' }) },
    NOW,
  );
  assert.equal(result.source, 'retry-info');
  assert.equal(result.resetAtMs, NOW + 39_000);
  assert.equal(result.resourceExhausted, true);
  assert.equal(result.googleStatus, 'RESOURCE_EXHAUSTED');
});

test('RetryInfo delays cap at 15 minutes so a hostile value cannot park the account', () => {
  const result = classifyVertex429({ headers: {}, bodyText: googleErrorBody({ retryDelay: '4h' }) }, NOW);
  assert.equal(result.source, 'retry-info');
  assert.equal(result.resetAtMs, NOW + VERTEX_RATE_LIMIT_RETRY_INFO_MAX_MS);
});

test('fractional RetryInfo delays round to whole milliseconds', () => {
  const result = classifyVertex429({ headers: {}, bodyText: googleErrorBody({ retryDelay: '1.5s' }) }, NOW);
  assert.equal(result.source, 'retry-info');
  assert.equal(result.resetAtMs, NOW + 1_500);
});

test('no retry signal falls back to the one-minute pay-as-you-go cooldown', () => {
  const result = classifyVertex429(
    { headers: {}, bodyText: googleErrorBody({ status: VERTEX_RESOURCE_EXHAUSTED_STATUS }) },
    NOW,
  );
  assert.equal(result.source, 'fallback');
  assert.equal(result.resetAtMs, NOW + VERTEX_RATE_LIMIT_FALLBACK_MS);
  assert.equal(result.resourceExhausted, true);
});

test('an unparsable body still classifies with the fallback cooldown', () => {
  const result = classifyVertex429({ headers: {}, bodyText: 'plain text error' }, NOW);
  assert.equal(result.source, 'fallback');
  assert.equal(result.resourceExhausted, false);
  assert.equal(result.googleStatus, null);
  assert.equal(result.resetAtMs, NOW + VERTEX_RATE_LIMIT_FALLBACK_MS);
  const empty = classifyVertex429({ headers: {}, bodyText: null }, NOW);
  assert.equal(empty.source, 'fallback');
});

test('an explicit retry-after header wins over the RetryInfo delay', () => {
  const result = classifyVertex429(
    {
      headers: { 'retry-after': '7' },
      bodyText: googleErrorBody({ retryDelay: '39s' }),
    },
    NOW,
  );
  assert.equal(result.source, 'retry-after');
  assert.equal(result.resetAtMs, NOW + 7_000);
  // An HTTP-date retry-after is honored too.
  const dateResult = classifyVertex429(
    { headers: { 'retry-after': new Date(NOW + 12_000).toUTCString() }, bodyText: null },
    NOW,
  );
  assert.equal(dateResult.source, 'retry-after');
  assert.equal(dateResult.resetAtMs, NOW + 12_000);
});

test('implausible retry-after deadlines fall through to the next signal', () => {
  const result = classifyVertex429(
    { headers: { 'retry-after': '864000' }, bodyText: googleErrorBody({ retryDelay: '30s' }) },
    NOW,
  );
  assert.equal(result.source, 'retry-info');
  assert.equal(result.resetAtMs, NOW + 30_000);
});

test('daily-exhaustion detection stays conservative (no Vertex daily quota exists)', () => {
  assert.equal(
    isVertexDailyQuotaExhaustion(
      googleErrorBody({ status: VERTEX_RESOURCE_EXHAUSTED_STATUS, message: 'per day quota exceeded' }),
    ),
    true,
  );
  assert.equal(isVertexDailyQuotaExhaustion(googleErrorBody({ message: 'Quota exceeded for quota metric' })), false);
  assert.equal(isVertexDailyQuotaExhaustion('not json'), false);
  assert.equal(isVertexDailyQuotaExhaustion(null), false);
});
