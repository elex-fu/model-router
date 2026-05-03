import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteSize } from '../../src/cli/size.js';

test('parseByteSize: bare number', () => {
  assert.equal(parseByteSize('123456'), 123456);
});

test('parseByteSize: kb suffix', () => {
  assert.equal(parseByteSize('1kb'), 1024);
  assert.equal(parseByteSize('1KB'), 1024);
  assert.equal(parseByteSize('512kb'), 512 * 1024);
});

test('parseByteSize: mb suffix', () => {
  assert.equal(parseByteSize('4mb'), 4 * 1024 * 1024);
  assert.equal(parseByteSize('4MB'), 4 * 1024 * 1024);
  assert.equal(parseByteSize('1m'), 1024 * 1024);
});

test('parseByteSize: gb suffix', () => {
  assert.equal(parseByteSize('1gb'), 1024 * 1024 * 1024);
});

test('parseByteSize: rejects invalid input', () => {
  assert.throws(() => parseByteSize('abc'), /size/);
  assert.throws(() => parseByteSize('-1mb'), /size/);
  assert.throws(() => parseByteSize(''), /size/);
});
