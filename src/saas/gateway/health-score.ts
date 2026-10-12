/**
 * R7/D6 continuous provider-account health (design:
 * docs/remaining-capability-plan-2026-10-11.md R7). Pure, allocation-free
 * helpers shared by the health write side and the scheduling read side:
 *
 * - `recordOutcomeEma` mirrors the EMA the authoritative PostgreSQL write
 *   applies to `saas_provider_account_runtime_health.health_score` in the
 *   same statement as the (unchanged) binary state transition. The column is
 *   numeric(4,3), so every step snaps to a three-decimal grid.
 * - `effectiveWeight` is the scheduling-side multiplier consumed by the
 *   chooseWeighted integration: `weight × max(score, 0.05)` floored to an
 *   integer lower bound of 1. A NULL score preserves the pre-R7 binary
 *   behavior exactly; a malformed score throws so the caller can map the
 *   failure to a fail-closed scheduling block.
 * - `shouldHalfOpenProbe` / `isHalfOpenProbeAllowed` / `halfOpenBackoffMs`
 *   encode the half-open probe cadence. The binary cooldown columns keep
 *   their existing semantics byte-for-byte; the probe cadence is derived
 *   from `half_open_probe_at` plus the persisted failure count, with the
 *   backoff doubling up to a 15 minute ceiling.
 *
 * The EMA seed decision: a NULL score (pre-R7 row) is treated as an
 * optimistic seed of 1.0 before applying the EMA step, so the first
 * observed failure lands at 0.800 — matching the binary behavior where a
 * single failure only triggers a one-second cooldown rather than
 * near-total starvation.
 */

/** EMA smoothing factor applied per recorded runtime outcome. */
export const HEALTH_SCORE_ALPHA = 0.2;
/** Optimistic seed substituted when a row has no persisted score yet. */
export const HEALTH_SCORE_SEED = 1;
/** Scheduling multiplier floor that prevents a fully starved account. */
export const HEALTH_SCORE_WEIGHT_FLOOR = 0.05;
/**
 * Crash-recovery lease for one admitted half-open probe: if no outcome is
 * recorded within this window the admission is considered abandoned and a
 * new probe may be admitted.
 */
export const HALF_OPEN_PROBE_LEASE_MS = 30_000;
/** Base delay after the first consecutive probe failure. */
export const HALF_OPEN_BASE_BACKOFF_MS = 1_000;
/** Upper bound of the doubling probe-failure backoff (15 minutes). */
export const HALF_OPEN_MAX_BACKOFF_MS = 900_000;

export type HealthScoreOutcome = 'success' | 'failure';

export type HealthScoreErrorCode = 'MALFORMED_SCORE' | 'MALFORMED_WEIGHT' | 'MALFORMED_INPUT';

export class HealthScoreError extends Error {
  constructor(readonly code: HealthScoreErrorCode) {
    super(
      code === 'MALFORMED_SCORE'
        ? 'provider account health score is malformed'
        : code === 'MALFORMED_WEIGHT'
          ? 'provider account scheduling weight is malformed'
          : 'provider account health input is malformed',
    );
    this.name = 'HealthScoreError';
  }
}

function malformedScore(): never {
  throw new HealthScoreError('MALFORMED_SCORE');
}

function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function snapScore(value: number): number {
  return Math.round(value * 1000);
}

function asValidDate(value: unknown): Date | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? value : null;
}

/**
 * Applies one EMA step on the three-decimal numeric(4,3) grid: success
 * converges toward 1, failure toward 0. A NULL score starts from the
 * optimistic seed (1.0), so the first failure lands at 0.800. The alpha
 * must lie in (0, 1]; the default matches the authoritative SQL writer.
 */
export function recordOutcomeEma(
  score: number | null,
  outcome: HealthScoreOutcome,
  alpha: number = HEALTH_SCORE_ALPHA,
): number {
  if (outcome !== 'success' && outcome !== 'failure') throw new HealthScoreError('MALFORMED_INPUT');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new HealthScoreError('MALFORMED_INPUT');
  const base = score === null ? HEALTH_SCORE_SEED : score;
  if (!validScore(base)) malformedScore();
  const baseMilli = snapScore(base);
  const targetMilli = outcome === 'success' ? 1000 : 0;
  const nextMilli = Math.round(baseMilli + alpha * (targetMilli - baseMilli));
  return Math.min(1000, Math.max(0, nextMilli)) / 1000;
}

/**
 * Scheduling multiplier: `weight × max(score, 0.05)` floored to an integer
 * with a lower bound of 1. NULL keeps the pre-R7 static weight. Any
 * malformed input throws; the scheduling integration maps the throw to a
 * fail-closed block instead of guessing.
 */
export function effectiveWeight(weight: number, healthScore: number | null): number {
  if (!Number.isSafeInteger(weight) || weight < 1) throw new HealthScoreError('MALFORMED_WEIGHT');
  if (healthScore === null) return weight;
  if (!validScore(healthScore)) malformedScore();
  return Math.max(1, Math.floor(weight * Math.max(healthScore, HEALTH_SCORE_WEIGHT_FLOOR)));
}

/**
 * Doubling backoff for consecutive half-open probe failures, capped at 15
 * minutes. The authoritative re-entry cadence rides on the persisted
 * binary cooldown (which doubles per recorded failure under its own
 * database bound); this pure helper exposes the same doubling shape to the
 * scheduling integration for probe planning. A malformed count degrades
 * to the most conservative ceiling: probing too rarely is always safe,
 * probing too eagerly is not.
 */
export function halfOpenBackoffMs(consecutiveProbeFailures: number): number {
  if (!Number.isSafeInteger(consecutiveProbeFailures) || consecutiveProbeFailures < 1) {
    return HALF_OPEN_MAX_BACKOFF_MS;
  }
  return Math.min(
    HALF_OPEN_MAX_BACKOFF_MS,
    HALF_OPEN_BASE_BACKOFF_MS * 2 ** Math.min(consecutiveProbeFailures - 1, 20),
  );
}

/**
 * Basic half-open gate: the row must still carry a cooldown whose deadline
 * has passed, and no probe admission may be live (an admission lives for
 * HALF_OPEN_PROBE_LEASE_MS so a crashed probe cannot wedge the account).
 * Malformed inputs fail closed. This lease-only view cannot tell a
 * concluded probe from an in-flight one; callers that know the row's last
 * outcome timestamp should prefer `isHalfOpenProbeAllowed`, which matches
 * the authoritative SQL admission predicate exactly.
 */
export function shouldHalfOpenProbe(cooldownUntil: Date | null, halfOpenProbeAt: Date | null, now: Date): boolean {
  const clock = asValidDate(now);
  if (!clock) return false;
  if (cooldownUntil === null) return false;
  const cooldown = asValidDate(cooldownUntil);
  if (!cooldown || clock.getTime() < cooldown.getTime()) return false;
  if (halfOpenProbeAt === null) return true;
  const probe = asValidDate(halfOpenProbeAt);
  if (!probe) return false;
  return clock.getTime() - probe.getTime() >= HALF_OPEN_PROBE_LEASE_MS;
}

/**
 * Authoritative half-open admission gate, mirroring the admission
 * predicate in `PostgresProviderAccountRuntimeHealthStore`: the cooldown
 * must have expired and there must be no live probe, where a probe is
 * live iff its admission is newer than the last recorded outcome
 * (`observedAt`) and younger than the crash-recovery lease. A probe whose
 * outcome was recorded (success or failure) is concluded and never blocks
 * the next admission; inter-probe backoff then rides on the persisted
 * cooldown, which doubles per consecutive failure (see halfOpenBackoffMs
 * for the pure cadence). The caller must only evaluate rows whose binary
 * state is 'cooldown'; a NULL cooldown is never probe-eligible. Malformed
 * inputs fail closed.
 */
export function isHalfOpenProbeAllowed(input: {
  readonly cooldownUntil: Date | null;
  readonly halfOpenProbeAt: Date | null;
  readonly observedAt: Date;
  readonly now: Date;
}): boolean {
  const clock = asValidDate(input?.now);
  const observed = asValidDate(input?.observedAt);
  if (!clock || !observed) return false;
  if (input.cooldownUntil === null) return false;
  const cooldown = asValidDate(input.cooldownUntil);
  if (!cooldown || clock.getTime() < cooldown.getTime()) return false;
  if (input.halfOpenProbeAt === null) return true;
  const probe = asValidDate(input.halfOpenProbeAt);
  if (!probe) return false;
  if (probe.getTime() <= observed.getTime()) return true;
  return clock.getTime() - probe.getTime() >= HALF_OPEN_PROBE_LEASE_MS;
}

/**
 * Parses the numeric(4,3) health_score column as delivered by the pg
 * driver (string) or an in-memory number. NULL stays NULL (pre-R7 binary
 * behavior). Any malformed representation throws so the scheduling read
 * side can fail closed instead of silently treating corruption as NULL.
 */
export function parseHealthScoreColumn(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^[01](\.[0-9]{1,3})?$/.test(trimmed)) malformedScore();
    parsed = Number(trimmed);
  } else {
    malformedScore();
  }
  if (!validScore(parsed)) malformedScore();
  return snapScore(parsed) / 1000;
}
