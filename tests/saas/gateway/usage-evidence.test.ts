import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_RESPONSES_WATCHER_VERSION,
  createUsageEvidence,
  outboundServiceTierFromPayload,
  usageEvidenceCompleteness,
  usageEvidenceDigestMaterial,
} from '../../../src/saas/gateway/usage-evidence.js';

const encoder = new TextEncoder();

test('outbound tier is frozen from the FINAL payload bytes, post-transform', () => {
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"model":"x"}')), null);
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"service_tier":"Priority"}')), 'priority');
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"service_tier":" flex "}')), 'flex');
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"service_tier":""}')), null);
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"service_tier":null}')), null);
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"nested":{"service_tier":"flex"}}')), null);
  // A transform that strips the field (codex/bedrock) freezes null.
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"model":"gpt-5.3-codex","stream":true}')), null);
  // Undecodable bytes never produce a tier guess.
  assert.equal(outboundServiceTierFromPayload(encoder.encode('{"service_tier":"flex"')), null);
  assert.equal(outboundServiceTierFromPayload(new Uint8Array()), null);
});

test('a payload without the tier field is not re-parsed', () => {
  // 2 MiB payload with no service_tier: the needle scan returns null without
  // paying for a JSON parse.
  const large = new Uint8Array(2 * 1024 * 1024).fill(0x20);
  assert.equal(outboundServiceTierFromPayload(large), null);
});

test('SSE completion and client disconnect are distinct completeness facts and neither is a zero report', () => {
  assert.equal(usageEvidenceCompleteness({ state: 'reported' }), 'complete');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'cancelled' }), 'incomplete-client-disconnect');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'truncated' }), 'incomplete-truncated');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'no_usage' }), 'incomplete-missing');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'invalid_usage' }), 'incomplete-malformed');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'oversized_body' }), 'incomplete-oversized');
  assert.equal(usageEvidenceCompleteness({ state: 'unknown', reason: 'stream_error' }), 'unknown');
  assert.notEqual(
    usageEvidenceCompleteness({ state: 'reported' }),
    usageEvidenceCompleteness({ state: 'unknown', reason: 'cancelled' }),
  );
});

test('the bounded evidence object carries no user text and digests stably', () => {
  const evidence = createUsageEvidence({
    meteringSource: 'provider-sse-usage-observer',
    observerVersion: 'provider-sse-usage-observer/v2',
    outboundServiceTier: 'priority',
    serviceTier: { requested: 'priority', observed: 'default' },
    accountKind: 'public-api',
    billingMode: 'token',
    model: 'claude-sonnet-5',
    operation: 'messages',
    completeness: 'complete',
    observedAt: '2026-10-18T00:00:00.000Z',
    adapterVersion: 'provider-payload-compiler/v1',
  });
  assert.equal(usageEvidenceDigestMaterial(evidence), usageEvidenceDigestMaterial({ ...evidence }));
  assert.match(usageEvidenceDigestMaterial(evidence), /^source=provider-sse-usage-observer\|/);
  assert.match(usageEvidenceDigestMaterial(evidence), /tier=outbound=priority&/);
  assert.match(usageEvidenceDigestMaterial(evidence), /completeness=complete\|/);
  // Defaults are redaction-safe nulls, never payload content.
  const minimal = createUsageEvidence({
    meteringSource: 'codex-responses-watcher',
    observerVersion: CODEX_RESPONSES_WATCHER_VERSION,
    completeness: 'incomplete-missing',
  });
  assert.match(
    usageEvidenceDigestMaterial(minimal),
    /tier=null\|account=null\|mode=token\|units=null\|sizeTier=null\|model=null\|operation=null\|/,
  );
});
