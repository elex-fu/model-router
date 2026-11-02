import type { ClaudeCredentialSink } from '../platform/claude-oauth/http.js';
import { parseClaudeCredentialsJson } from '../platform/claude-oauth/import.js';
import type { CodexCredentialSink } from '../platform/codex-oauth/http.js';
import { parseCodexAuthJson } from '../platform/codex-oauth/import.js';
import type { GeminiCredentialSink } from '../platform/gemini-oauth/http.js';
import { parseGeminiCredentialsJson } from '../platform/gemini-oauth/import.js';
import type { GrokCredentialEnvelope } from '../platform/grok-oauth/binding-service.js';
import type { GrokCredentialSink } from '../platform/grok-oauth/http.js';
import { GROK_OAUTH_CLIENT_ID } from '../platform/grok-oauth/oauth.js';
import type {
  BulkImportCredentialSink,
  BulkImportMaterial,
  BulkImportProvider,
  BulkImportSinkInput,
} from './bulk-import-service.js';

export interface BulkImportProviderSinks {
  readonly codex: Pick<CodexCredentialSink, 'accept'>;
  readonly claude: Pick<ClaudeCredentialSink, 'accept'>;
  readonly gemini: Pick<GeminiCredentialSink, 'accept'>;
  readonly grok: Pick<GrokCredentialSink, 'accept'>;
}

function materialJson(material: BulkImportMaterial): string {
  return JSON.stringify(material);
}

function invalidGrokMaterial(): never {
  throw Object.assign(new TypeError('grok credential material is invalid'), { code: 'CREDENTIALS_JSON_INVALID' });
}

function alias(record: BulkImportMaterial, names: readonly string[]): unknown {
  let selected: unknown;
  let found = false;
  for (const name of names) {
    const value = record[name];
    if (value === undefined) continue;
    if (found && !Object.is(selected, value)) return invalidGrokMaterial();
    selected = value;
    found = true;
  }
  return found ? selected : undefined;
}

function requiredToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return invalidGrokMaterial();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return invalidGrokMaterial();
  }
  return value;
}

function optionalToken(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredToken(value);
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    return invalidGrokMaterial();
  }
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  return value === undefined || value === null ? null : requiredText(value, maximum);
}

/**
 * Minimal Grok import DTO. Only flat camelCase/snake_case fields are accepted;
 * required refresh coordinates and every supplied optional field are checked.
 */
export function parseGrokCredentialMaterial(material: BulkImportMaterial): GrokCredentialEnvelope {
  if (material === null || typeof material !== 'object' || Array.isArray(material)) return invalidGrokMaterial();
  const rawExpiry = alias(material, ['expiresAt', 'expires_at']);
  let expiresAt: string | null = null;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    const value = requiredText(rawExpiry, 64);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return invalidGrokMaterial();
    expiresAt = parsed.toISOString();
  }
  return Object.freeze({
    accessToken: requiredToken(alias(material, ['accessToken', 'access_token'])),
    refreshToken: requiredToken(alias(material, ['refreshToken', 'refresh_token'])),
    idToken: optionalToken(alias(material, ['idToken', 'id_token'])),
    expiresAt,
    clientId: optionalText(alias(material, ['clientId', 'client_id']), 256) ?? GROK_OAUTH_CLIENT_ID,
    email: optionalText(alias(material, ['email']), 320),
    userId: requiredText(alias(material, ['userId', 'user_id']), 256),
    teamId: optionalText(alias(material, ['teamId', 'team_id']), 256),
    subscriptionTier: optionalText(alias(material, ['subscriptionTier', 'subscription_tier']), 128),
  });
}

function forwarding(input: BulkImportSinkInput) {
  return {
    actorUserId: input.actorUserId,
    sourceIp: input.sourceIp,
    userAgent: input.userAgent,
  } as const;
}

/** Adapts the generic bulk seam to the four existing typed OAuth supply sinks. */
export function createBulkImportCredentialSinks(
  sinks: BulkImportProviderSinks,
): Readonly<Record<BulkImportProvider, BulkImportCredentialSink>> {
  for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
    if (typeof sinks[provider]?.accept !== 'function') throw new TypeError(`${provider} credential sink is required`);
  }
  return Object.freeze({
    codex: Object.freeze({
      accept: async (input: BulkImportSinkInput) =>
        sinks.codex.accept({
          envelope: parseCodexAuthJson(materialJson(input.envelope)),
          source: 'auth-json-import',
          ...forwarding(input),
        }),
    }),
    claude: Object.freeze({
      accept: async (input: BulkImportSinkInput) =>
        sinks.claude.accept({
          envelope: parseClaudeCredentialsJson(materialJson(input.envelope)),
          source: 'credentials-json-import',
          ...forwarding(input),
        }),
    }),
    gemini: Object.freeze({
      accept: async (input: BulkImportSinkInput) =>
        sinks.gemini.accept({
          envelope: parseGeminiCredentialsJson(materialJson(input.envelope)),
          source: 'credentials-json-import',
          ...forwarding(input),
        }),
    }),
    grok: Object.freeze({
      accept: async (input: BulkImportSinkInput) =>
        sinks.grok.accept({
          envelope: parseGrokCredentialMaterial(input.envelope),
          source: 'credentials-json-import',
          ...forwarding(input),
        }),
    }),
  });
}
