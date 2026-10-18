import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveServiceTierBillingTerms,
  serviceTierObservedAuthority,
  serviceTierTrustCategory,
  settlementServiceTierTerms,
} from '../../../src/saas/pricing/service-tier-trust.js';

/*
 * R3 §8.3 tier trust matrix. Every case must be explainable: the resolution
 * carries the reason, and settlement terms never let an untrusted tier reach
 * the only-lower rule.
 */

test('codex oauth is the non-authoritative category; verified public APIs are authoritative', () => {
  assert.equal(serviceTierTrustCategory({ providerId: 'openai-codex' }), 'codex-oauth');
  assert.equal(
    serviceTierTrustCategory({ providerId: 'openai-codex', productId: 'codex-chatgpt', credentialType: 'oauth' }),
    'codex-oauth',
  );
  assert.equal(serviceTierTrustCategory({ providerId: 'openai' }), 'public-api');
  assert.equal(serviceTierTrustCategory({ providerId: 'anthropic' }), 'public-api');
  assert.equal(serviceTierTrustCategory({ providerId: 'google-gemini' }), 'public-api');
  assert.equal(serviceTierObservedAuthority('codex-oauth'), 'non-authoritative');
  assert.equal(serviceTierObservedAuthority('public-api'), 'authoritative');
});

test('public verified API: outbound priority answered with default bills at the trusted lower tier', () => {
  const resolution = resolveServiceTierBillingTerms({
    requested: 'priority',
    observed: 'default',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual(
    [resolution.billing, resolution.downgraded, resolution.retained, resolution.reason],
    ['default', true, false, 'observed-lower'],
  );
  // Settlement terms let the calculator apply exactly the lower tier.
  assert.deepEqual(settlementServiceTierTerms(resolution), { requested: 'priority', observed: 'default' });
});

test('codex oauth: an observed default is non-authoritative and never lowers the bill', () => {
  const resolution = resolveServiceTierBillingTerms({
    requested: 'priority',
    observed: 'default',
    observedAuthority: 'non-authoritative',
  });
  assert.deepEqual(
    [resolution.billing, resolution.downgraded, resolution.retained, resolution.reason, resolution.observed],
    ['priority', false, true, 'observed-non-authoritative', 'default'],
  );
  // The observed tier is recorded but suppressed from the calculator terms.
  assert.deepEqual(settlementServiceTierTerms(resolution), { requested: 'priority', observed: null });
});

test('an observed tier that is more expensive, unknown, or absent never raises the bill alone', () => {
  const higher = resolveServiceTierBillingTerms({
    requested: 'default',
    observed: 'priority',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual(
    [higher.billing, higher.downgraded, higher.retained, higher.reason],
    ['default', false, true, 'observed-higher-ignored'],
  );
  assert.deepEqual(settlementServiceTierTerms(higher), { requested: 'default', observed: null });

  const unknown = resolveServiceTierBillingTerms({
    requested: 'default',
    observed: 'mystery-tier',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual([unknown.billing, unknown.reason], ['default', 'observed-unknown-ignored']);

  const missing = resolveServiceTierBillingTerms({
    requested: 'priority',
    observed: null,
    observedAuthority: 'authoritative',
  });
  assert.deepEqual([missing.billing, missing.reason], ['priority', 'observed-missing']);
  assert.deepEqual(settlementServiceTierTerms(missing), { requested: 'priority', observed: null });
});

test('conflicting multiple reports keep the outbound tier and never bill on either declaration', () => {
  const resolution = resolveServiceTierBillingTerms({
    requested: 'priority',
    observed: 'default',
    observedAuthority: 'authoritative',
    observedConflict: true,
  });
  assert.deepEqual(
    [resolution.billing, resolution.downgraded, resolution.retained, resolution.reason],
    ['priority', false, true, 'observed-conflict'],
  );
  assert.deepEqual(settlementServiceTierTerms(resolution), { requested: 'priority', observed: null });
});

test('anthropic fast answered with usage.speed standard bills at the lower tier', () => {
  const resolution = resolveServiceTierBillingTerms({
    requested: 'fast',
    observed: 'standard',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual(
    [resolution.billing, resolution.downgraded, resolution.reason],
    ['standard', true, 'observed-lower'],
  );
});

test('equal tiers and absent tier input are neutral', () => {
  const equal = resolveServiceTierBillingTerms({
    requested: 'priority',
    observed: 'priority',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual([equal.billing, equal.downgraded, equal.reason], ['priority', false, 'observed-equal']);

  const none = resolveServiceTierBillingTerms({ requested: null, observed: null, observedAuthority: 'authoritative' });
  assert.deepEqual([none.billing, none.reason], ['', 'no-tier-input']);
  assert.equal(settlementServiceTierTerms(none), null);
  assert.equal(settlementServiceTierTerms(null), null);
});

test('flex remains cheaper than the base family under the trust resolution', () => {
  const resolution = resolveServiceTierBillingTerms({
    requested: 'default',
    observed: 'flex',
    observedAuthority: 'authoritative',
  });
  assert.deepEqual([resolution.billing, resolution.downgraded], ['flex', true]);
});
