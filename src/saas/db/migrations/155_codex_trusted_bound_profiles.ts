import type { SaasMigration } from './001_initial_schema.js';

/*
 * Codex subscription supply admission. The reviewed trusted-bound registry
 * in src/saas/runtime/codex-trusted-bound-profiles.ts stays frozen and
 * empty: code review alone cannot admit ChatGPT backend evidence. This
 * table is the operator-side admission ledger behind the resolver seam —
 * rows only become resolver-visible through the control-plane approval
 * workflow, and the gateway reads them through a cached resolver that
 * recomputes the digest server-side, so a submitted digest can never be
 * trusted from the wire.
 *
 * The digest column is UNIQUE but always recomputed by the server from the
 * stored scope/evidence/bounds content — it is a deduplication key, not an
 * attestation. bounds stores the PreparedRequestUsageEnvelope shape exactly
 * as the in-code profile type.
 */
const codexTrustedBoundProfilesSql = `
CREATE TABLE saas_codex_trusted_bound_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  endpoint text NOT NULL CHECK (btrim(endpoint) <> ''),
  product_id text NOT NULL CHECK (btrim(product_id) <> ''),
  model text NOT NULL CHECK (btrim(model) <> ''),
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  transport text NOT NULL CHECK (transport IN ('http', 'websocket')),
  continuation_mode text NOT NULL CHECK (
    continuation_mode IN ('full', 'canonical-replay', 'remote-history', 'compact')
  ),
  bounds jsonb NOT NULL,
  backend_revision text NOT NULL CHECK (btrim(backend_revision) <> ''),
  evidence_version text NOT NULL CHECK (btrim(evidence_version) <> ''),
  evidence_reference text NOT NULL CHECK (btrim(evidence_reference) <> ''),
  valid_from_ms bigint NOT NULL CHECK (valid_from_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > 0),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'retired')),
  submitted_by_user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  approved_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_codex_bound_validity_window CHECK (
    valid_from_ms < expires_at_ms
  ),
  CONSTRAINT saas_codex_bound_approval_lifecycle CHECK (
    (state = 'approved' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (state IN ('pending', 'rejected') AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR state = 'retired'
  )
);
-- Approved-scope lookup only: the gateway resolver refresh reads exactly this
-- predicate, and every other state stays invisible to the gateway role.
CREATE INDEX saas_codex_trusted_bound_profiles_approved_scope_idx
  ON saas_codex_trusted_bound_profiles (
    endpoint, product_id, model, operation, transport, continuation_mode
  )
  WHERE state = 'approved';
`;

/**
 * Codex trusted-bound admission (155): the operator-side profile ledger
 * behind the resolver seam. The in-code REVIEWED_PROFILES registry stays
 * empty; this table plus the control-plane approval workflow is the only
 * path from submitted evidence to an admitted resolver profile. Retire
 * keeps the approved lineage immutable for audit; reject and retire are
 * terminal for a row — a new submission with corrected content gets a new
 * digest and a new row.
 */
export const CODEX_TRUSTED_BOUND_PROFILES_SAAS_MIGRATION: SaasMigration = {
  version: 155,
  name: 'codex_trusted_bound_profiles',
  sql: codexTrustedBoundProfilesSql,
};
