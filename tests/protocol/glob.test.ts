import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob } from '../../src/protocol/glob.js';

test('exact match (no wildcards)', () => {
  assert.equal(matchGlob('claude-sonnet-4', 'claude-sonnet-4'), true);
  assert.equal(matchGlob('claude-sonnet-4', 'claude-sonnet-5'), false);
});

test('* matches trailing characters', () => {
  assert.equal(matchGlob('claude-sonnet-4*', 'claude-sonnet-4-20250514'), true);
  assert.equal(matchGlob('claude-sonnet-4*', 'claude-sonnet-4'), true);
});

test('* matches empty string', () => {
  assert.equal(matchGlob('claude*', 'claude'), true);
  assert.equal(matchGlob('*', ''), true);
  assert.equal(matchGlob('*', 'anything'), true);
});

test('? matches exactly one character', () => {
  assert.equal(matchGlob('gpt-?o', 'gpt-4o'), true);
  assert.equal(matchGlob('gpt-?o', 'gpt-40o'), false);
  assert.equal(matchGlob('gpt-?o', 'gpt-o'), false);
});

test('. is matched literally, not as regex any-char', () => {
  assert.equal(matchGlob('claude.sonnet', 'claude.sonnet'), true);
  assert.equal(matchGlob('claude.sonnet', 'claudeXsonnet'), false);
});

test('regex metacharacters are escaped', () => {
  assert.equal(matchGlob('a+b', 'a+b'), true);
  assert.equal(matchGlob('a+b', 'aaab'), false);
  assert.equal(matchGlob('(foo)', '(foo)'), true);
  assert.equal(matchGlob('a$', 'a$'), true);
});

test('empty pattern does not match non-empty input', () => {
  assert.equal(matchGlob('', 'x'), false);
  assert.equal(matchGlob('', ''), true);
});

test('full string match (anchored)', () => {
  assert.equal(matchGlob('foo', 'foobar'), false);
  assert.equal(matchGlob('foo', 'barfoo'), false);
  assert.equal(matchGlob('foo*', 'foobar'), true);
  assert.equal(matchGlob('*foo', 'barfoo'), true);
});

test('case sensitive', () => {
  assert.equal(matchGlob('Claude', 'claude'), false);
  assert.equal(matchGlob('Claude', 'Claude'), true);
});

test('mixed wildcards', () => {
  assert.equal(matchGlob('claude-?-*', 'claude-3-opus'), true);
  assert.equal(matchGlob('claude-?-*', 'claude-30-opus'), false);
});
