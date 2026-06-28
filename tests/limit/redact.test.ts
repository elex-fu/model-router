import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../../src/limit/redact.js';

test('redactSecrets: leaves regular text alone', () => {
  assert.equal(redactSecrets('upstream returned 502'), 'upstream returned 502');
});

test('redactSecrets: masks an OpenAI-style key', () => {
  const msg = 'Invalid API key sk-abcdef123456ZZ in request';
  const out = redactSecrets(msg);
  assert.equal(out, 'Invalid API key sk-*** in request');
});

test('redactSecrets: masks Anthropic-style sk-ant- keys', () => {
  const msg = 'auth failed for sk-ant-api03-AAA_BBB-CCC123';
  const out = redactSecrets(msg);
  assert.equal(out, 'auth failed for sk-***');
});

test('redactSecrets: masks multiple keys in one message', () => {
  const msg = 'tried sk-abcdef12345 then sk-xxxxxxxxxxx';
  const out = redactSecrets(msg);
  assert.equal(out, 'tried sk-*** then sk-***');
});

test('redactSecrets: short sk- prefixes (under 8 chars) untouched', () => {
  // 'sk-abc' is too short to be a key — leave as-is
  assert.equal(redactSecrets('sk-abc'), 'sk-abc');
});

test('redactSecrets: handles null / undefined safely', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test('redactSecrets: masks Bearer tokens', () => {
  const msg = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
  assert.equal(redactSecrets(msg), 'Authorization: Bearer ***');
});

test('redactSecrets: masks x-api-key header values', () => {
  assert.equal(redactSecrets('x-api-key: ak-mysecretvalue123'), 'x-api-key: ***');
  assert.equal(redactSecrets("x-api-key='ak-mysecretvalue123'"), 'x-api-key=***');
});

test('redactSecrets: masks Azure api-key header values', () => {
  assert.equal(redactSecrets('api-key: abc123def456'), 'api-key: ***');
  assert.equal(redactSecrets('Api-Key: abc123def456'), 'Api-Key: ***');
});

test('redactSecrets: masks GitHub OAuth tokens', () => {
  assert.equal(redactSecrets('token gho_abcdefghijklmnopqrst'), 'token ***');
  assert.equal(redactSecrets('token ghs_abcdefghijklmnopqrstuv'), 'token ***');
});
