import type { SaasDatabase } from '../db/types.js';
import type { PreparedRequestUsageEnvelope } from '../gateway/prepared-request-evidence-service.js';
import {
  type CodexTrustedBoundProfile,
  type CodexTrustedBoundProfileResolver,
  type CodexTrustedBoundScope,
  codexBoundCompilerVersion,
  codexTrustedProfileDigest,
} from './codex-trusted-bound-profiles.js';

/**
 * 方案1 (M1-C) — the gateway-side Codex trusted-bound resolver.
 *
 * Reads the ops-approved ledger (saas_codex_trusted_bound_profiles, migration
 * 155 / M1-B) through the gateway role's column-level SELECT grant — never the
 * lineage columns — and serves it through the CodexTrustedBoundProfileResolver
 * seam. The resolver interface is synchronous, so the ledger is held as an
 * immutable snapshot with a TTL: construction performs the initial load, and
 * admission calls past the TTL trigger one coalesced background refresh while
 * the previous snapshot keeps serving. There is no per-call database read and
 * no timer to own.
 *
 * Fail-closed behavior: an unreadable ledger starts empty; a profile is only
 * admitted when its server-recomputed digest matches the recorded digest, the
 * state row is approved, and — at admission time — the remaining validity
 * window covers the expiry margin (a request admitted now must be able to
 * finish before the profile expires; send-time re-validation uses the same
 * margin). isDigestActive intentionally applies no margin: it answers
 * settlement questions about digests that were admitted earlier.
 */
export interface DbCodexTrustedBoundProfileResolver extends CodexTrustedBoundProfileResolver {
  /** Re-read the ledger now, bypassing the TTL; never rejects. */
  refresh(): Promise<void>;
}

export interface DbCodexTrustedBoundProfileResolverOptions {
  readonly database: Pick<SaasDatabase, 'query'>;
  /** Snapshot retention before a background re-read is triggered (default 30s). */
  readonly refreshIntervalMs?: number;
  /**
   * Minimum remaining validity required at admission (default 60s). The
   * built-in runtime wiring passes the request timeout so an admitted request
   * can always complete inside the profile's window.
   */
  readonly expiryMarginMs?: number;
  readonly now?: () => number;
}

interface ProfileRow extends Record<string, unknown> {
  digest: unknown;
  endpoint: unknown;
  product_id: unknown;
  model: unknown;
  operation: unknown;
  transport: unknown;
  continuation_mode: unknown;
  bounds: unknown;
  backend_revision: unknown;
  evidence_version: unknown;
  evidence_reference: unknown;
  valid_from_ms: unknown;
  expires_at_ms: unknown;
}

/** Exactly the gateway role's granted admission-content columns. */
const LEDGER_QUERY = `SELECT digest, endpoint, product_id, model, operation, transport, continuation_mode,
       bounds, backend_revision, evidence_version, evidence_reference,
       valid_from_ms::text, expires_at_ms::text
  FROM saas_codex_trusted_bound_profiles
 WHERE state = 'approved'`;

function epochMs(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error(`Codex trusted-bound ledger ${label} is malformed`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Codex trusted-bound ledger ${label} is malformed`);
  }
  return parsed;
}

export async function createDbCodexTrustedBoundProfileResolver(
  options: DbCodexTrustedBoundProfileResolverOptions,
): Promise<DbCodexTrustedBoundProfileResolver> {
  const refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
  const expiryMarginMs = options.expiryMarginMs ?? 60_000;
  const now = options.now ?? Date.now;
  let admitted: readonly CodexTrustedBoundProfile[] = Object.freeze([]);
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<readonly CodexTrustedBoundProfile[]> {
    const rows = await options.database.query<ProfileRow>(LEDGER_QUERY);
    const profiles: CodexTrustedBoundProfile[] = [];
    for (const row of rows.rows) {
      const bounds =
        row.bounds !== null && typeof row.bounds === 'object' && !Array.isArray(row.bounds)
          ? (row.bounds as PreparedRequestUsageEnvelope)
          : null;
      const profile: CodexTrustedBoundProfile | null =
        bounds === null
          ? null
          : {
              // Enum-typed columns are read as text; the digest re-verification
              // below is the runtime guarantee that only admission-validated
              // values survive.
              scope: {
                endpoint: String(row.endpoint),
                productId: String(row.product_id),
                model: String(row.model),
                operation: String(row.operation),
                transport: String(row.transport) as CodexTrustedBoundScope['transport'],
                continuationMode: String(row.continuation_mode) as CodexTrustedBoundScope['continuationMode'],
              },
              backendRevision: String(row.backend_revision),
              evidenceVersion: String(row.evidence_version),
              evidenceReference: String(row.evidence_reference),
              validFromMs: epochMs(row.valid_from_ms, 'valid_from_ms'),
              expiresAtMs: epochMs(row.expires_at_ms, 'expires_at_ms'),
              bounds,
            };
      // The digest is recomputed from the stored canonical form: any drift
      // between the recorded admission and the row being read fails closed.
      if (profile !== null && typeof row.digest === 'string' && codexTrustedProfileDigest(profile) === row.digest) {
        profiles.push(profile);
      }
    }
    return Object.freeze(profiles);
  }

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        admitted = await load();
        lastError = null;
      } catch (error) {
        // A transient read failure keeps the previous snapshot serving (each
        // profile's own validity window still bounds it); the failure surfaces
        // through readiness. A failed first load leaves the ledger empty.
        lastError = error instanceof Error ? error.message : 'ledger read failed';
      } finally {
        lastRefreshAt = now();
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function ensureFresh(): void {
    if (inFlight || now() - lastRefreshAt < refreshIntervalMs) return;
    void refresh();
  }

  function withinAdmissionWindow(profile: CodexTrustedBoundProfile, atMs: number): boolean {
    return profile.validFromMs <= atMs && atMs + expiryMarginMs < profile.expiresAtMs;
  }

  function withinValidity(profile: CodexTrustedBoundProfile, atMs: number): boolean {
    return profile.validFromMs <= atMs && atMs < profile.expiresAtMs;
  }

  await refresh();

  return Object.freeze({
    refresh,
    resolve(scope: CodexTrustedBoundScope, atMs = now()) {
      ensureFresh();
      const profile = admitted.find(
        (candidate) =>
          withinAdmissionWindow(candidate, atMs) &&
          Object.entries(scope).every(([key, value]) => candidate.scope[key as keyof CodexTrustedBoundScope] === value),
      );
      return profile ? { profile, digest: codexTrustedProfileDigest(profile) } : null;
    },
    sendProfile(
      version: string,
      compilerVersion: string,
      actual: Omit<CodexTrustedBoundScope, 'continuationMode'>,
      atMs = now(),
    ) {
      ensureFresh();
      return (
        admitted.find(
          (profile) =>
            withinAdmissionWindow(profile, atMs) &&
            Object.entries(actual).every(
              ([key, value]) => profile.scope[key as keyof CodexTrustedBoundScope] === value,
            ) &&
            codexBoundCompilerVersion(compilerVersion, profile) === version,
        ) ?? null
      );
    },
    isDigestActive(digest: string, atMs = now()) {
      ensureFresh();
      return admitted.some((profile) => withinValidity(profile, atMs) && codexTrustedProfileDigest(profile) === digest);
    },
    readiness() {
      const live = admitted.filter((profile) => withinValidity(profile, now()));
      const reason =
        lastError !== null
          ? `Codex trusted-bound ledger read failed; serving ${live.length} previously admitted profile(s): ${lastError}`
          : live.length === 0
            ? 'No approved Codex trusted-bound profile is currently admitted'
            : 'Ops-approved Codex trusted-bound profiles are admitted from the ledger';
      return { admittedProfileCount: live.length, reason };
    },
  });
}
