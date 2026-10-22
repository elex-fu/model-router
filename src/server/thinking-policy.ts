/**
 * Gap-remediation plan G-B6 (§7.2 item 4): the three-stage thinking policy —
 * the CLIProxyAPI `internal/thinking/apply.go` order, as a pure function.
 *
 *   ① INTENT EXTRACTION — the client's thinking intent, including the
 *      model-name suffix form `model(8192)`; no intent → the body passes
 *      through untouched.
 *   ② TARGET-MODEL VALIDATION — a model that cannot think has the intent
 *      REMOVED (the CLIProxyAPI posture: strip, never a hard error, so a
 *      client's adaptive default never breaks a non-thinking model).
 *   ③ PROVIDER PARAMETER TRANSFORMATION — the intent maps onto the target
 *      provider's parameter shape with clamping and level downgrading.
 *
 * The mapping table (CLIProxyAPI provider/*):
 *   - anthropic: thinking.type disabled|enabled|adaptive + budget_tokens
 *     (budget clamps below max_tokens); level rides output_config.effort
 *   - openai chat: top-level reasoning_effort
 *   - gemini: generationConfig.thinkingConfig.thinkingLevel (3) /
 *     thinkingBudget (2.5, snake_case tolerated)
 *   - kimi: thinking.effort
 *
 * Every decision returns a diagnostic code the caller may record (never
 * sent to the client) — the new-api ConversionDiagnostic posture.
 */

export type ThinkingProviderFamily = 'anthropic' | 'openai' | 'gemini' | 'kimi' | 'unknown';

export type ThinkingIntentLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export interface ThinkingIntent {
  readonly enabled: boolean;
  readonly level?: ThinkingIntentLevel;
  /** A requested budget in tokens (the model-suffix form or budget_tokens). */
  readonly budgetTokens?: number;
}

export type ThinkingDiagnosticCode =
  | 'thinking.intent.extracted'
  | 'thinking.intent.suffix'
  | 'thinking.model.cannot-think-stripped'
  | 'thinking.budget.clamped'
  | 'thinking.level.downgraded'
  | 'thinking.strip-only-summary';

export interface ThinkingDecision {
  /** The (possibly mutated) body — the caller applies it when provided. */
  readonly body?: Record<string, unknown>;
  readonly diagnostics: readonly ThinkingDiagnosticCode[];
}

const SUFFIX_PATTERN = /\(([0-9]{1,7})\)\s*$/;
const LEVELS: readonly ThinkingIntentLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEVEL_RANK: Record<ThinkingIntentLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/**
 * ① Intent extraction. Sources in precedence order (CLIProxyAPI):
 * the model-name suffix `model(8192)`, the protocol-native thinking field,
 * or a reasoning-effort field. Returns null when the body carries no
 * thinking intent at all.
 */
export function extractThinkingIntent(body: Record<string, unknown>): {
  readonly intent: ThinkingIntent;
  readonly diagnostics: readonly ThinkingDiagnosticCode[];
} | null {
  const diagnostics: ThinkingDiagnosticCode[] = [];

  // The model-suffix form: "claude-sonnet-4-6(8192)".
  const model = typeof body.model === 'string' ? body.model : null;
  if (model !== null) {
    const match = SUFFIX_PATTERN.exec(model);
    if (match !== null) {
      const budget = Number(match[1]);
      if (Number.isSafeInteger(budget) && budget > 0) {
        diagnostics.push('thinking.intent.suffix');
        return { intent: { enabled: true, budgetTokens: budget }, diagnostics };
      }
    }
  }

  // Protocol-native shapes.
  const thinking = body.thinking;
  if (thinking !== null && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const record = thinking as Record<string, unknown>;
    if (record.type === 'enabled' || record.type === 'adaptive') {
      diagnostics.push('thinking.intent.extracted');
      const budget =
        typeof record.budget_tokens === 'number' && record.budget_tokens > 0 ? record.budget_tokens : undefined;
      return {
        intent: { enabled: true, budgetTokens: budget, level: 'high' },
        diagnostics,
      };
    }
    if (record.type === 'disabled') {
      return { intent: { enabled: false }, diagnostics: ['thinking.intent.extracted'] };
    }
  }
  if (body.reasoning_effort === 'none') {
    return { intent: { enabled: false }, diagnostics: ['thinking.intent.extracted'] };
  }
  if (typeof body.reasoning_effort === 'string' && LEVELS.includes(body.reasoning_effort as ThinkingIntentLevel)) {
    diagnostics.push('thinking.intent.extracted');
    return { intent: { enabled: true, level: body.reasoning_effort as ThinkingIntentLevel }, diagnostics };
  }
  const thinkingConfig = (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig;
  if (thinkingConfig !== null && typeof thinkingConfig === 'object' && !Array.isArray(thinkingConfig)) {
    const config = thinkingConfig as Record<string, unknown>;
    if (typeof config.thinkingLevel === 'string' && LEVELS.includes(config.thinkingLevel as ThinkingIntentLevel)) {
      diagnostics.push('thinking.intent.extracted');
      return { intent: { enabled: true, level: config.thinkingLevel as ThinkingIntentLevel }, diagnostics };
    }
    if (typeof config.thinkingBudget === 'number' && config.thinkingBudget > 0) {
      diagnostics.push('thinking.intent.extracted');
      return { intent: { enabled: true, budgetTokens: config.thinkingBudget }, diagnostics };
    }
  }
  const effort = (body.thinking as Record<string, unknown> | undefined)?.effort;
  if (typeof effort === 'string' && LEVELS.includes(effort as ThinkingIntentLevel)) {
    diagnostics.push('thinking.intent.extracted');
    return { intent: { enabled: true, level: effort as ThinkingIntentLevel }, diagnostics };
  }
  return null;
}

/** Models that provably cannot think (② validation input). */
export function modelCanThink(model: string): boolean {
  const m = model.toLowerCase();
  // The haiku family has no thinking tier (the CLIProxyAPI LookupModelInfo
  // precedent, expressed as a family test until a catalog capability lands).
  if (m.includes('haiku')) return false;
  return true;
}

function clampBudget(budget: number, maxTokens: number): { value: number; clamped: boolean } {
  const ceiling = Math.max(0, maxTokens - 1);
  if (budget <= ceiling) return { value: budget, clamped: false };
  return { value: ceiling, clamped: true };
}

function downgradeLevel(
  level: ThinkingIntentLevel,
  supported: readonly ThinkingIntentLevel[],
): { level: ThinkingIntentLevel; downgraded: boolean } {
  if (supported.includes(level)) return { level, downgraded: false };
  // Map down to the highest supported level below the request (the
  // mapConfiguredHighIntent posture: xhigh → high when the target lacks it).
  const ranked = supported.slice().sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);
  let best: ThinkingIntentLevel = ranked[0] ?? 'low';
  for (const candidate of ranked) {
    if (LEVEL_RANK[candidate] <= LEVEL_RANK[level]) best = candidate;
  }
  return { level: best, downgraded: best !== level };
}

const OPENAI_LEVELS: readonly ThinkingIntentLevel[] = ['minimal', 'low', 'medium', 'high'];
const GEMINI3_LEVELS: readonly ThinkingIntentLevel[] = ['low', 'high'];
const KIMI_LEVELS: readonly ThinkingIntentLevel[] = ['low', 'medium', 'high'];

/**
 * ① + ② + ③ applied to one body. `mutate` receives the provider-shaped
 * writes; the caller owns the body (this function never mutates its input).
 */
export function applyThinkingPolicy(input: {
  readonly body: Record<string, unknown>;
  readonly model: string;
  readonly provider: ThinkingProviderFamily;
}): ThinkingDecision {
  const extracted = extractThinkingIntent(input.body);
  if (extracted === null) return { diagnostics: [] };
  const diagnostics = [...extracted.diagnostics];
  const intent = extracted.intent;

  // ② Validation: strip (never error) on a non-thinking model.
  if (!modelCanThink(input.model)) {
    if (intent.enabled) diagnostics.push('thinking.model.cannot-think-stripped');
    const stripped = { ...input.body };
    delete stripped.thinking;
    delete stripped.reasoning_effort;
    delete stripped.output_config;
    if (typeof stripped.generationConfig === 'object' && stripped.generationConfig !== null) {
      const generationConfig = { ...(stripped.generationConfig as Record<string, unknown>) };
      delete generationConfig.thinkingConfig;
      stripped.generationConfig = generationConfig;
    }
    return { body: stripped, diagnostics };
  }
  if (!intent.enabled) {
    // Keep an explicit off switch for endpoints which reason by default.
    // Removing it would silently restore thinking and can invalidate forced
    // tool selection (Kimi's Anthropic-compatible endpoint).
    const stripped = { ...input.body };
    delete stripped.thinking;
    delete stripped.reasoning_effort;
    if (typeof stripped.generationConfig === 'object' && stripped.generationConfig !== null) {
      const generationConfig = { ...(stripped.generationConfig as Record<string, unknown>) };
      delete generationConfig.thinkingConfig;
      stripped.generationConfig = generationConfig;
    }
    if (input.provider === 'anthropic' || input.provider === 'kimi') {
      stripped.thinking = { type: 'disabled' };
    } else if (input.provider === 'openai') {
      stripped.reasoning_effort = 'none';
    }
    return { body: stripped, diagnostics };
  }

  const maxTokens = typeof input.body.max_tokens === 'number' ? input.body.max_tokens : 16_384;
  const result: Record<string, unknown> = { ...input.body };
  const budget = intent.budgetTokens !== undefined ? clampBudget(intent.budgetTokens, maxTokens) : undefined;
  if (budget?.clamped) diagnostics.push('thinking.budget.clamped');

  switch (input.provider) {
    case 'anthropic': {
      if (budget !== undefined) {
        result.thinking = { type: 'enabled', budget_tokens: budget.value };
      } else {
        result.thinking = { type: 'adaptive' };
      }
      const level = intent.level;
      if (level !== undefined && level !== 'high') {
        result.output_config = { effort: level };
      }
      return { body: result, diagnostics };
    }
    case 'openai': {
      const level = intent.level ?? 'high';
      const mapped = downgradeLevel(level, OPENAI_LEVELS);
      if (mapped.downgraded) diagnostics.push('thinking.level.downgraded');
      result.reasoning_effort = mapped.level;
      return { body: result, diagnostics };
    }
    case 'gemini': {
      const level = intent.level ?? 'high';
      const mapped = downgradeLevel(level, GEMINI3_LEVELS);
      if (mapped.downgraded) diagnostics.push('thinking.level.downgraded');
      const generationConfig = { ...((result.generationConfig as Record<string, unknown>) ?? {}) };
      const thinkingConfig = { ...((generationConfig.thinkingConfig as Record<string, unknown>) ?? {}) };
      if (budget !== undefined) {
        thinkingConfig.thinkingBudget = budget.value;
      } else {
        thinkingConfig.thinkingLevel = mapped.level;
      }
      generationConfig.thinkingConfig = thinkingConfig;
      result.generationConfig = generationConfig;
      return { body: result, diagnostics };
    }
    case 'kimi': {
      const level = intent.level ?? 'high';
      const mapped = downgradeLevel(level, KIMI_LEVELS);
      if (mapped.downgraded) diagnostics.push('thinking.level.downgraded');
      result.thinking = { effort: mapped.level };
      return { body: result, diagnostics };
    }
    default:
      // Unknown family: no parameter shape to write — pass through.
      return { diagnostics };
  }
}
