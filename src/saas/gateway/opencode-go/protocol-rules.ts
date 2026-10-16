/**
 * R5b-2 OpenCode Go multi-protocol adaptive routing (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #22). Pure
 * functions only — no transports, no DB access, no usage worker (R5b-3).
 *
 * Semantics are lifted verbatim from the sub2api reference implementation
 * (backend/internal/service/opencode_go.go): `DefaultOpenCodeGoProtocolRules`,
 * `openCodeGoPatternMatches` and `matchOpenCodeGoProtocolRules`. One OpenCode
 * Zen/Go subscription key serves three native upstream endpoints (Responses /
 * Chat Completions / Anthropic Messages); the rule table decides, per
 * normalized model id, which native protocol a request uses.
 *
 * Protocol identifiers are the repository's existing `GatewayProtocol`
 * spellings (src/config/types.ts `Protocol` via gateway contracts.ts):
 * - sub2api `responses`       → `responses`      (POST /v1/responses)
 * - sub2api `chat_completions`→ `openai`         (POST /v1/chat/completions)
 * - sub2api `anthropic`       → `anthropic`      (POST /v1/messages)
 *
 * Rule-table storage (plan §R5b design point 2): `protocol_rules` is provider
 * configuration as JSONB — NOT part of PricingIdentity — resolved after
 * modelMap resolution and before endpoint signing. The JSONB column itself
 * lands with migration 108 (task #25); until then the built-in default table
 * below is the wiring source. Migration 108 must add, mirroring the 099
 * codex-scheduling precedent on both account tables:
 *
 *   ALTER TABLE saas_platform_provider_accounts
 *     ADD COLUMN opencode_go_protocol_rules jsonb,
 *     ADD CONSTRAINT saas_platform_provider_accounts_opencode_go_protocol_rules_shape
 *       CHECK (opencode_go_protocol_rules IS NULL OR jsonb_typeof(opencode_go_protocol_rules) = 'array');
 *   -- same for saas_tenant_provider_accounts
 *
 * with the array elements shaped `{ "pattern": string, "protocol": string }`
 * (protocol ∈ responses|openai|anthropic, ≤64 entries). Because a rule change
 * is a scheduling-input change, the admin mutation path must bump the account
 * authorization fence exactly like the 082/repository CAS pattern
 * (`UPDATE ... SET opencode_go_protocol_rules = $1, authz_version =
 * authz_version + 1 WHERE ... AND authz_version = $expected`), so in-flight
 * prepared evidence keyed to the previous rule table fails closed instead of
 * dispatching with a stale protocol.
 */

import type { GatewayProtocol } from '../contracts.js';
import { normalizeOpenCodeGoModelId } from './model-catalog.js';

/**
 * The three native OpenCode Go upstream protocols, spelled with the
 * repository's existing `GatewayProtocol` identifiers.
 */
export type OpenCodeGoNativeProtocol = Extract<GatewayProtocol, 'responses' | 'openai' | 'anthropic'>;

/** One model-pattern → native-protocol mapping. First match wins. */
export interface OpenCodeGoProtocolRule {
  /** Exact model id or a suffix glob (`grok-*` / `*`). */
  readonly pattern: string;
  readonly protocol: OpenCodeGoNativeProtocol;
}

/** Fallback protocol when no rule matches (sub2api: Chat Completions). */
export const OPENCODE_GO_DEFAULT_PROTOCOL: OpenCodeGoNativeProtocol = 'openai';

/** sub2api `maxOpenCodeGoProtocolRules`. */
export const MAX_OPENCODE_GO_PROTOCOL_RULES = 64;

/** sub2api `maxOpenCodeGoProtocolPatternLength`. */
export const MAX_OPENCODE_GO_PROTOCOL_PATTERN_LENGTH = 128;

/** sub2api `openCodeGoProtocolRulesKey` (credentials/config map spelling). */
export const OPENCODE_GO_PROTOCOL_RULES_CONFIG_KEY = 'protocol_rules';

function isNativeOpenCodeGoProtocol(value: unknown): value is OpenCodeGoNativeProtocol {
  return value === 'responses' || value === 'openai' || value === 'anthropic';
}

/**
 * Built-in adaptive routing table for OpenCode Go accounts (sub2api
 * `DefaultOpenCodeGoProtocolRules`): Grok/GPT/Muse Spark → Responses,
 * MiniMax/Qwen → Anthropic, everything else Chat Completions. Frozen: callers
 * must not mutate the shared table.
 */
export const DEFAULT_OPENCODE_GO_PROTOCOL_RULES: readonly OpenCodeGoProtocolRule[] = Object.freeze([
  Object.freeze({ pattern: 'grok-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'gpt-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'muse-spark-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'minimax-*', protocol: 'anthropic' }),
  Object.freeze({ pattern: 'qwen*', protocol: 'anthropic' }),
]);

/**
 * Zen-plan variant (sub2api `DefaultOpenCodeZenProtocolRules`, aligned with
 * https://opencode.ai/docs/zen/): GPT/Grok/Muse Spark → Responses,
 * Claude/Qwen → Anthropic, everything else Chat Completions. Kept as data so a
 * Zen-mode deployment is only a different rule table, never different code.
 */
export const DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES: readonly OpenCodeGoProtocolRule[] = Object.freeze([
  Object.freeze({ pattern: 'grok-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'gpt-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'muse-spark-*', protocol: 'responses' }),
  Object.freeze({ pattern: 'claude-*', protocol: 'anthropic' }),
  Object.freeze({ pattern: 'qwen*', protocol: 'anthropic' }),
]);

/**
 * sub2api `openCodeGoPatternMatches`: a pattern is an exact model id or a
 * suffix glob (`foo*`, or bare `*` matching everything). Both sides are
 * normalized first (pattern trimmed + lowercased; model id run through
 * `normalizeOpenCodeGoModelId`). Empty pattern or empty normalized model never
 * matches.
 */
export function openCodeGoPatternMatches(pattern: string, modelId: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const model = normalizeOpenCodeGoModelId(modelId);
  if (normalizedPattern === '' || model === '') return false;
  if (normalizedPattern === '*') return true;
  if (normalizedPattern.endsWith('*')) {
    return model.startsWith(normalizedPattern.slice(0, -1));
  }
  return model === normalizedPattern;
}

/**
 * sub2api `matchOpenCodeGoProtocolRules`: first-match-wins over the rule
 * table. Rules carrying an unknown protocol are skipped (defensive: the table
 * may come from JSONB config); no match falls back to Chat Completions so a
 * miss can never drop traffic into a Responses conversion chain.
 */
export function resolveOpenCodeGoProtocol(
  rules: readonly OpenCodeGoProtocolRule[],
  modelId: string,
): OpenCodeGoNativeProtocol {
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object' || !isNativeOpenCodeGoProtocol(rule.protocol)) continue;
    if (openCodeGoPatternMatches(rule.pattern, modelId)) return rule.protocol;
  }
  return OPENCODE_GO_DEFAULT_PROTOCOL;
}

/** Canonical provider operation for each native protocol (payload compiler vocabulary). */
export function openCodeGoProviderOperationForProtocol(
  protocol: OpenCodeGoNativeProtocol,
): 'chat.completions' | 'messages' | 'responses' {
  if (protocol === 'responses') return 'responses';
  if (protocol === 'anthropic') return 'messages';
  return 'chat.completions';
}

/**
 * R5b-4 (closes R5b-2 gap 3): the generic openai→responses and
 * anthropic→responses bridges were passthrough stubs — only the codex compile
 * layer (gateway/codex/payload.ts) owned real Responses conversion — so an
 * OpenCode Go model the rule table routes to the Responses native had to be
 * requested through a `responses` client, or the gateway would forward a
 * wrong-shaped payload. This predicate was the fail-closed gate: true means
 * the request must be blocked with the capability-style error instead of
 * dispatched. F3 made both bridges real conversions
 * (gateway/responses-bridge), so the production compile wrapper now bridges
 * these routes by default and only applies this gate when an operator opts
 * back in with `opencodeGoCrossResponsesRouting: 'restrict'`.
 * (responses→openai / responses→anthropic still fail closed in the
 * compiler's SUPPORTED_BRIDGE_PAIRS gate.)
 */
export function isOpenCodeGoCrossResponsesRoute(clientProtocol: string, routedProtocol: string): boolean {
  return routedProtocol === 'responses' && clientProtocol !== 'responses';
}

export type OpenCodeGoProtocolRulesValidation =
  | { readonly valid: true; readonly rules: readonly OpenCodeGoProtocolRule[] }
  | { readonly valid: false; readonly reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePattern(pattern: unknown): { readonly pattern: string } | { readonly reason: string } {
  if (typeof pattern !== 'string') return { reason: 'pattern must be a string' };
  const normalized = pattern.trim().toLowerCase();
  if (normalized === '') return { reason: 'pattern is required' };
  if (normalized.length > MAX_OPENCODE_GO_PROTOCOL_PATTERN_LENGTH) return { reason: 'pattern is too long' };
  if (/\s/.test(normalized)) return { reason: 'pattern must not contain whitespace' };
  const stars = normalized.split('*').length - 1;
  if (stars > 1 || (stars === 1 && !normalized.endsWith('*'))) {
    return { reason: 'pattern may use a single trailing * wildcard' };
  }
  return { pattern: normalized };
}

/**
 * Strict validation and in-place normalization for admin/config paths
 * (sub2api `parseOpenCodeGoProtocolRules` +
 * `normalizeOpenCodeGoProtocolPattern`): at most 64 entries, non-empty
 * whitespace-free patterns with a single optional trailing `*`, no duplicate
 * patterns, and known protocols only. The returned rules are normalized
 * (lowercased, trimmed) and frozen.
 */
export function validateOpenCodeGoProtocolRules(value: unknown): OpenCodeGoProtocolRulesValidation {
  if (!Array.isArray(value)) return { valid: false, reason: 'protocol_rules must be an array' };
  if (value.length > MAX_OPENCODE_GO_PROTOCOL_RULES) {
    return { valid: false, reason: `protocol_rules supports at most ${MAX_OPENCODE_GO_PROTOCOL_RULES} entries` };
  }
  const rules: OpenCodeGoProtocolRule[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isPlainRecord(entry)) {
      return { valid: false, reason: `protocol_rules[${index}] must be an object` };
    }
    const patternResult = validatePattern(entry.pattern);
    if (!('pattern' in patternResult)) {
      return { valid: false, reason: `protocol_rules[${index}]: ${patternResult.reason}` };
    }
    const protocol = typeof entry.protocol === 'string' ? entry.protocol.trim() : entry.protocol;
    if (!isNativeOpenCodeGoProtocol(protocol)) {
      return {
        valid: false,
        reason: `protocol_rules[${index}]: protocol must be responses, openai, or anthropic`,
      };
    }
    if (seen.has(patternResult.pattern)) {
      return { valid: false, reason: `protocol_rules[${index}]: duplicate pattern ${patternResult.pattern}` };
    }
    seen.add(patternResult.pattern);
    rules.push(Object.freeze({ pattern: patternResult.pattern, protocol }));
  }
  return { valid: true, rules: Object.freeze(rules) };
}

/**
 * Lenient config loader for dispatch wiring (sub2api
 * `Account.openCodeGoProtocolRules`): reads the rule table from provider
 * configuration when present and valid, and returns null when the field is
 * absent or malformed so the caller falls back to the built-in default table
 * (existing accounts keep the default behavior). Accepts either the raw JSONB
 * column value (the rule array) or a wrapper record carrying the
 * `protocol_rules` key (the sub2api credentials-map shape).
 */
export function resolveOpenCodeGoProtocolRulesFromConfig(config: unknown): readonly OpenCodeGoProtocolRule[] | null {
  let raw: unknown = config;
  if (isPlainRecord(raw) && Object.hasOwn(raw, OPENCODE_GO_PROTOCOL_RULES_CONFIG_KEY)) {
    raw = raw[OPENCODE_GO_PROTOCOL_RULES_CONFIG_KEY];
  }
  if (raw === null || raw === undefined) return null;
  const validation = validateOpenCodeGoProtocolRules(raw);
  return validation.valid ? validation.rules : null;
}

/*
 * Dispatch wiring for the migration-108 provider `protocol_rules` column:
 * compose `resolveOpenCodeGoProtocolRulesFromConfig(columnValue) ??
 * DEFAULT_OPENCODE_GO_PROTOCOL_RULES` (or the Zen table for a Zen-plan
 * account) and hand the result to `resolveOpenCodeGoProtocol`. Per-account
 * pinned protocols (the sub2api explicit `api_protocol` precedence) are
 * deliberately not modeled yet: they need account-level storage that lands
 * with migration 108.
 */
