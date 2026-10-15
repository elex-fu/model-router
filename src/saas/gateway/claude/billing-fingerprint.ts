import { createHash } from 'node:crypto';
import { CLAUDE_FINGERPRINT_SALT } from './constants.js';

/**
 * R5 Claude Code billing fingerprint (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5; verbatim port of
 * sub2api's gateway_billing_block.go, itself aligned with the real CLI
 * capture). The fingerprint block is the strongest "official CLI" signal:
 * `x-anthropic-billing-header: cc_version={version}.{fp}; cc_entrypoint=cli;`
 * as the first system block, byte-identical to what the real CLI sends. The
 * salt is a public algorithm constant, not a secret.
 */

/** Character indices sampled from the first user message text. */
const FINGERPRINT_INDICES: readonly number[] = Object.freeze([4, 7, 20]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts the text of the first `role=user` message (its first `text`
 * content block, or the string content). Mirrors extractFirstUserText:
 * compatible with both string and block-array content shapes.
 */
export function extractFirstUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return '';
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
    }
    return '';
  }
  return '';
}

/**
 * The cc_version fingerprint suffix: hex(SHA256(salt + firstUserText[4,7,20]
 * (padded with '0') + cliVersion))[:3]. Any deviation desynchronizes
 * cc_version=X.Y.Z.{fp} from the real CLI upstream-side.
 */
export function computeClaudeCodeFingerprint(firstUserText: string, cliVersion: string): string {
  // Byte-indexed sampling (the Go reference indexes bytes, not runes): pad
  // with '0' past the end so the digest input length is stable.
  const bytes = Buffer.from(firstUserText, 'utf8');
  const chars = FINGERPRINT_INDICES.map((index) =>
    index < bytes.length ? String.fromCharCode(bytes[index]) : '0',
  ).join('');
  const digest = createHash('sha256').update(`${CLAUDE_FINGERPRINT_SALT}${chars}${cliVersion}`, 'utf8').digest('hex');
  return digest.slice(0, 3);
}

/** Convenience: fingerprint directly over a /v1/messages-shaped body. */
export function computeClaudeCodeFingerprintFromBody(body: unknown, cliVersion: string): string {
  return computeClaudeCodeFingerprint(extractFirstUserText(body), cliVersion);
}

/**
 * The billing attribution text block. No `cch=` signature field: the current
 * CLI no longer sends one, and injecting it would deviate from real traffic.
 * The block deliberately carries no cache_control (the cache breakpoint
 * lives on the following Claude Code prompt block).
 */
export function buildBillingAttributionText(cliVersion: string, fingerprint: string): string {
  if (typeof cliVersion !== 'string' || cliVersion.length === 0) {
    throw new RangeError('cliVersion is required');
  }
  if (typeof fingerprint !== 'string' || fingerprint.length !== 3) {
    throw new RangeError('fingerprint must be three hex characters');
  }
  return `x-anthropic-billing-header: cc_version=${cliVersion}.${fingerprint}; cc_entrypoint=cli;`;
}

/** Composed helper: fingerprint over the body, then the attribution text. */
export function buildBillingAttributionBlock(body: unknown, cliVersion: string): string {
  return buildBillingAttributionText(cliVersion, computeClaudeCodeFingerprintFromBody(body, cliVersion));
}
