import type { SaasMigration } from './001_initial_schema.js';

const authorityInvalidationEventsSchemaSql = `
/*
 * §12.2 Phase A2b (D2) authority/entitlement invalidation events, shaped on
 * the saas_request_admission_outbox precedent. Control-plane revocation
 * class mutations (api key revoked, platform inference access disabled /
 * re-activated, tenant membership revoked) append one row INSIDE the
 * revocation transaction; gateways that enable the broadcast poll this
 * table (~500ms cadence) and drop their local version-keyed preparation
 * caches. Consumption is at-least-once and coarsely scoped (any event
 * flushes every local entry), so no lease/claim/delivery machinery is
 * needed — the cursor is per-process and re-initializes to MAX(id) at
 * startup, because a fresh process starts with empty caches.
 *
 * This is an availability optimization ONLY: it shortens the bounded
 * (<= TTL) window in which requests carry stale versions into
 * AUTHORITY_MISMATCH fail-closed guard rejections. The admission guard
 * remains the final defense line and never consults this table.
 */
CREATE TABLE saas_authority_invalidation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_authority_invalidation_events_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES saas_tenants (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_authority_invalidation_events_kind_fixed
    CHECK (
      kind IN (
        'api_key.revoked',
        'platform_inference_access.disabled',
        'platform_inference_access.activated',
        'membership.revoked'
      )
    ),
  CONSTRAINT saas_authority_invalidation_events_reason_bounded
    CHECK (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 255 AND btrim(reason) = reason))
);

CREATE INDEX saas_authority_invalidation_events_poll_idx
  ON saas_authority_invalidation_events (id);
`;

export const AUTHORITY_INVALIDATION_EVENTS_SAAS_MIGRATION: SaasMigration = {
  version: 143,
  name: 'authority_invalidation_events',
  sql: authorityInvalidationEventsSchemaSql,
};
