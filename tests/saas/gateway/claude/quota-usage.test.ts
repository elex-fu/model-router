import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_USAGE_ENDPOINT,
  ClaudeUsageFetchError,
  fetchClaudeUsageSnapshot,
  parseClaudeUsageSnapshot,
} from '../../../../src/saas/gateway/claude/quota-usage.js';

function usageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    five_hour: { utilization: 0.42, resets_at: '2026-10-16T12:00:00Z' },
    seven_day: { utilization: 0.71, resets_at: '2026-10-20T12:00:00Z' },
    ...overrides,
  };
}

test('the usage snapshot parses all four windows and tolerates absent ones', () => {
  const full = parseClaudeUsageSnapshot({
    ...usageBody(),
    seven_day_sonnet: { utilization: 0.33, resets_at: '2026-10-19T00:00:00Z' },
    seven_day_overage_included: { utilization: 0.9, resets_at: '2026-10-21T00:00:00Z' },
  });
  assert.ok(full);
  assert.deepEqual(full.fiveHour, { utilization: 0.42, resetsAt: '2026-10-16T12:00:00Z' });
  assert.deepEqual(full.sevenDay, { utilization: 0.71, resetsAt: '2026-10-20T12:00:00Z' });
  assert.deepEqual(full.sevenDaySonnet, { utilization: 0.33, resetsAt: '2026-10-19T00:00:00Z' });
  assert.deepEqual(full.sevenDayOverageIncluded, { utilization: 0.9, resetsAt: '2026-10-21T00:00:00Z' });

  const partial = parseClaudeUsageSnapshot(usageBody());
  assert.ok(partial);
  assert.equal(partial.sevenDaySonnet, null);
  assert.equal(partial.sevenDayOverageIncluded, null);

  // No window at all → unavailable, not empty.
  assert.equal(parseClaudeUsageSnapshot({}), null);
  assert.equal(parseClaudeUsageSnapshot('nope'), null);
  assert.equal(parseClaudeUsageSnapshot(null), null);
  // A malformed window is dropped rather than guessed.
  const malformed = parseClaudeUsageSnapshot({
    ...usageBody(),
    seven_day_sonnet: { utilization: 'high', resets_at: '' },
  });
  assert.ok(malformed);
  assert.equal(malformed.sevenDaySonnet, null);
});

test('fetchClaudeUsageSnapshot sends the pinned headers and parses the body', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const snapshot = await fetchClaudeUsageSnapshot('accs-token', async (url, init) => {
    seen.push({ url: url.href, headers: new Headers(init.headers) });
    return new Response(JSON.stringify(usageBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, CLAUDE_USAGE_ENDPOINT);
  assert.equal(seen[0].headers.get('authorization'), 'Bearer accs-token');
  assert.equal(seen[0].headers.get('anthropic-beta'), 'oauth-2025-04-20');
  assert.match(seen[0].headers.get('user-agent') ?? '', /^claude-code\//);
  assert.ok(snapshot);
  assert.equal(snapshot.fiveHour?.utilization, 0.42);
});

test('fetch failures and malformed responses fail closed with typed errors', async () => {
  for (const response of [
    new Response('nope', { status: 403 }),
    new Response('<html>blocked</html>', { status: 529 }),
  ]) {
    await assert.rejects(
      fetchClaudeUsageSnapshot('accs-token', async () => response),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeUsageFetchError);
        assert.equal(error.code, 'USAGE_HTTP_ERROR');
        return true;
      },
    );
  }
  for (const body of ['not json', '{}', JSON.stringify({ five_hour: { utilization: 0.5 } }), 'x'.repeat(70_000)]) {
    await assert.rejects(
      fetchClaudeUsageSnapshot(
        'accs-token',
        async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeUsageFetchError);
        assert.equal(error.code, 'USAGE_RESPONSE_INVALID');
        return true;
      },
    );
  }
  await assert.rejects(
    fetchClaudeUsageSnapshot('accs-token', async () => {
      throw new Error('network down');
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeUsageFetchError);
      assert.equal(error.code, 'USAGE_HTTP_ERROR');
      return true;
    },
  );
});
