import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret } from '../../src/cli/mask.js';

test('maskSecret: long string → prefix + ellipsis + suffix', () => {
  assert.equal(maskSecret('mrk_abcdefghijklmnopqrstuv'), 'mrk_ab…stuv');
});

test('maskSecret: short string returns ***', () => {
  assert.equal(maskSecret('short'), '***');
  assert.equal(maskSecret('exactly8'), '***');
});

test('maskSecret: empty / null / undefined → ***', () => {
  assert.equal(maskSecret(''), '***');
  assert.equal(maskSecret(undefined), '***');
  assert.equal(maskSecret(null), '***');
});

test('maskSecret: sk- key masked', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnopqrst'), 'sk-abc…qrst');
});
