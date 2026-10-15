/**
 * Phase 3 observability audit enhancement (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 5).
 *
 * A compact key-level settings diff for the platform config commit audit
 * trail — a focused version of sub2api's settings diff, covering only the
 * model-router V2 config surface. Secret-shaped values are never rendered.
 */

const SECRET_PATH_PATTERN = /(secret|token|password|credential|apikey|api_key|privatekey|private_key)/i;
const MAX_VALUE_LENGTH = 120;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.length === 0) return "''";
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
  return rendered.length > MAX_VALUE_LENGTH ? `${rendered.slice(0, MAX_VALUE_LENGTH)}…` : rendered;
}

function isSecretPath(path: string): boolean {
  return SECRET_PATH_PATTERN.test(path);
}

/**
 * Produces human-readable key-level change descriptions such as
 * `server.port: 15005 → 15010`, `upstreams[2].baseUrl: <missing> → https://…`
 * and `routes[0].id: rt-1 → <removed>`. Secret-shaped paths render redacted
 * placeholders on both sides. Arrays are compared index-wise like the control
 * plane's structural diff.
 */
export function diffSettings(before: unknown, after: unknown): string[] {
  const changes: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): boolean => {
    if (left === right) return false;
    const emittedBefore = changes.length;
    if (isPlainObject(left) && isPlainObject(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        walk(left[key], right[key], path === '' ? key : `${path}.${key}`);
      }
    } else if (left === undefined && isPlainObject(right)) {
      // A newly added structure is described key-by-key, not as one blob.
      for (const key of Object.keys(right).sort()) {
        walk(undefined, right[key], path === '' ? key : `${path}.${key}`);
      }
      if (changes.length === emittedBefore && Object.keys(right).length === 0) {
        changes.push(`${path}: <missing> → ${formatValue(right)}`);
      }
    } else if (left === undefined && Array.isArray(right)) {
      for (let index = 0; index < right.length; index += 1) {
        walk(undefined, right[index], `${path}[${index}]`);
      }
      if (changes.length === emittedBefore && right.length === 0) {
        changes.push(`${path}: <missing> → ${formatValue(right)}`);
      }
    } else if (right === undefined && isPlainObject(left)) {
      for (const key of Object.keys(left).sort()) {
        walk(left[key], undefined, path === '' ? key : `${path}.${key}`);
      }
      if (changes.length === emittedBefore && Object.keys(left).length === 0) {
        changes.push(`${path}: ${formatValue(left)} → <removed>`);
      }
    } else if (right === undefined && Array.isArray(left)) {
      for (let index = 0; index < left.length; index += 1) {
        walk(left[index], undefined, `${path}[${index}]`);
      }
      if (changes.length === emittedBefore && left.length === 0) {
        changes.push(`${path}: ${formatValue(left)} → <removed>`);
      }
    } else if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        walk(left[index], right[index], `${path}[${index}]`);
      }
    } else {
      if (isSecretPath(path)) {
        changes.push(`${path}: [redacted] → [redacted]`);
        return true;
      }
      const leftMissing = left === undefined;
      const rightMissing = right === undefined;
      if (leftMissing && rightMissing) return false;
      if (leftMissing) {
        changes.push(`${path}: <missing> → ${formatValue(right)}`);
      } else if (rightMissing) {
        changes.push(`${path}: ${formatValue(left)} → <removed>`);
      } else {
        changes.push(`${path}: ${formatValue(left)} → ${formatValue(right)}`);
      }
    }
    return changes.length > emittedBefore;
  };
  walk(before, after, '');
  return changes;
}
