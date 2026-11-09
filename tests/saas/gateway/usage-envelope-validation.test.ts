import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePreparedRequestUsageEnvelope } from '../../../src/saas/gateway/usage-envelope-validation.js';

const bounds = {
  inputTotalUpperBound: '100',
  inputUncachedUpperBound: '80',
  cacheReadUpperBound: '20',
  cacheWriteUpperBound: '0',
  cacheWrite5mUpperBound: '0',
  cacheWrite1hUpperBound: '0',
  outputTotalUpperBound: '20',
  reasoningOutputUpperBound: '10',
  feasibleInputBuckets: ['input', 'cache_read'],
};

test('usage-envelope validation returns canonical bounds without mutating its input', () => {
  const input = { ...bounds, inputTotalUpperBound: 100, perUnitUnitsUpperBound: 2n, sizeTier: '720p' };
  const snapshot = { ...input };
  const result = validatePreparedRequestUsageEnvelope(input);
  assert.ok(result.ok);
  assert.equal(result.value.inputTotalUpperBound, '100');
  assert.equal(result.value.perUnitUnitsUpperBound, '2');
  assert.deepEqual(input, snapshot);
});

test('usage-envelope validation rejects semantic overflow and unsupported registries', () => {
  for (const input of [
    { ...bounds, cacheReadUpperBound: '101' },
    { ...bounds, reasoningOutputUpperBound: '21' },
    { ...bounds, feasibleInputBuckets: ['input', 'input'] },
    { ...bounds, feasibleInputBuckets: [] },
    { ...bounds, sizeTier: '8k' },
    { ...bounds, sizeTier: '720p' },
    { ...bounds, inputTotalUpperBound: '0100' },
  ]) {
    assert.equal(validatePreparedRequestUsageEnvelope(input).ok, false);
  }
});
