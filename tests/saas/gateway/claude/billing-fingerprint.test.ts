import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildBillingAttributionBlock,
  buildBillingAttributionText,
  computeClaudeCodeFingerprint,
  computeClaudeCodeFingerprintFromBody,
  extractFirstUserText,
} from '../../../../src/saas/gateway/claude/billing-fingerprint.js';
import { CLAUDE_FINGERPRINT_SALT } from '../../../../src/saas/gateway/claude/constants.js';

/** Reference implementation of the sub2api/Parrot algorithm, run independently. */
function referenceFingerprint(firstUserText: string, cliVersion: string): string {
  const bytes = Buffer.from(firstUserText, 'utf8');
  const chars = [4, 7, 20]
    .map((index) => (index < bytes.length ? bytes[index] : 0x30))
    .map((byte) => String.fromCharCode(byte));
  const digest = createHash('sha256')
    .update(`${CLAUDE_FINGERPRINT_SALT}${chars.join('')}${cliVersion}`)
    .digest('hex');
  return digest.slice(0, 3);
}

test('the fingerprint algorithm matches the reference byte-for-byte', () => {
  for (const [text, version] of [
    ['Hello Claude Code, please help me with a task.', '2.1.258'],
    ['ab', '2.1.258'],
    ['', '2.1.258'],
    ['Hello Claude Code, please help me with a task.', '2.2.0'],
    ['多字节文本 with emoji 🎉 and content', '2.1.258'],
  ] as const) {
    assert.equal(computeClaudeCodeFingerprint(text, version), referenceFingerprint(text, version));
    assert.match(computeClaudeCodeFingerprint(text, version), /^[0-9a-f]{3}$/);
  }
  // The fingerprint is deterministic and version-sensitive.
  assert.equal(
    computeClaudeCodeFingerprint('same text', '2.1.258'),
    computeClaudeCodeFingerprint('same text', '2.1.258'),
  );
  assert.notEqual(
    computeClaudeCodeFingerprint('same text', '2.1.258'),
    computeClaudeCodeFingerprint('same text', '2.1.259'),
  );
});

test('short texts pad missing indices with the zero character', () => {
  // '' pads all three; 'abcd' pads indices 7 and 20.
  assert.equal(computeClaudeCodeFingerprint('', '2.1.258'), referenceFingerprint('', '2.1.258'));
  assert.equal(computeClaudeCodeFingerprint('abcd', '2.1.258'), referenceFingerprint('abcd', '2.1.258'));
});

test('extractFirstUserText handles string and block-array content shapes', () => {
  assert.equal(extractFirstUserText({ messages: [{ role: 'user', content: 'plain text' }] }), 'plain text');
  assert.equal(
    extractFirstUserText({
      messages: [
        { role: 'assistant', content: 'skipped' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'block text' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    }),
    'block text',
  );
  assert.equal(extractFirstUserText({ messages: [] }), '');
  assert.equal(extractFirstUserText({}), '');
  assert.equal(extractFirstUserText({ messages: [{ role: 'assistant', content: 'only' }] }), '');
  // Non-text blocks in the first user message end the scan (first text block wins).
  assert.equal(extractFirstUserText({ messages: [{ role: 'user', content: [{ type: 'image', text: 'no' }] }] }), '');
  assert.equal(
    computeClaudeCodeFingerprintFromBody({ messages: [{ role: 'user', content: 'body text long enough' }] }, '2.1.258'),
    computeClaudeCodeFingerprint('body text long enough', '2.1.258'),
  );
});

test('the billing attribution block shape matches the real CLI', () => {
  const fp = computeClaudeCodeFingerprint('reference text', '2.1.258');
  assert.equal(
    buildBillingAttributionText('2.1.258', fp),
    `x-anthropic-billing-header: cc_version=2.1.258.${fp}; cc_entrypoint=cli;`,
  );
  assert.equal(
    buildBillingAttributionBlock({ messages: [{ role: 'user', content: 'reference text' }] }, '2.1.258'),
    `x-anthropic-billing-header: cc_version=2.1.258.${fp}; cc_entrypoint=cli;`,
  );
  // No cch= signature segment (the current CLI dropped it).
  assert.equal(buildBillingAttributionText('2.1.258', fp).includes('cch='), false);
  assert.throws(() => buildBillingAttributionText('', fp), RangeError);
  assert.throws(() => buildBillingAttributionText('2.1.258', 'toolong'), RangeError);
});
