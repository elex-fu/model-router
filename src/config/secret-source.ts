import type { SecretSource } from './v2-schema.js';

/** Read-only compatibility for the old provider key stored in env.name.
 * Canonical writes use inline; a real env reference always remains a variable name.
 * Keep this pattern shared with schema validation, status and resolution.
 */
export const legacyProviderKeyPattern = /^sk-[A-Za-z0-9_-]+$/;

export function isLegacyEnvLiteral(value: unknown): value is { type: 'env'; name: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return source.type === 'env' && typeof source.name === 'string' && legacyProviderKeyPattern.test(source.name);
}

export function normalizeSecretSource(source: SecretSource): SecretSource {
  return isLegacyEnvLiteral(source) ? { type: 'inline', value: source.name } : source;
}

/** Normalize only candidates, never an existing snapshot used by the CAS journal. */
export function normalizeLegacySecretSources<T>(value: T): T {
  if (isLegacyEnvLiteral(value) && Object.keys(value).length === 2) return { type: 'inline', value: value.name } as T;
  if (Array.isArray(value)) return value.map(normalizeLegacySecretSources) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeLegacySecretSources(child)]),
  ) as T;
}

export function redactSecretSources(value: unknown, replacement = ''): unknown {
  if (isLegacyEnvLiteral(value)) return { type: 'inline', value: replacement };
  if (Array.isArray(value)) return value.map((child) => redactSecretSources(child, replacement));
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (item.type === 'inline' && typeof item.value === 'string') return { ...item, value: replacement };
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redactSecretSources(child, replacement)]));
}
