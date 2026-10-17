import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 4 §4.4 composite model routing (task #18; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次四 4.4; sub2api reference:
 * backend/internal/service/composite_model_route.go + composite_route_resolver.go,
 * docs/COMPOSITE_GROUPS.md).
 *
 * A composite billing group exposes one customer-facing key surface whose
 * requested public model is resolved to a concrete provider platform per
 * request (admin route registry → group-account model ownership → built-in
 * prefix detector; unknown models fail closed — never a guess).
 *
 * Two pieces land together:
 *
 * 1. `saas_composite_model_routes` — the admin route registry (sub2api
 *    CompositeModelRoute). One row maps one public model in one composite
 *    group to a concrete target platform and (optionally) an explicit
 *    upstream model; empty upstream_model means passthrough of the requested
 *    model. Runtime resolution picks the winner with the five-key sort
 *    (exact > prefix, endpoint-specific > any, longer pattern, lower
 *    priority, lower id) implemented in
 *    src/saas/gateway/composite-route-resolver.ts. The table is
 *    control-plane CRUD (the billing-groups HTTP pattern) and gateway
 *    read-only; grants mirror in runtime-privileges.ts and
 *    deploy/managed-saas-postgres-roles.sql (the 105 mirror-test precedent).
 *    The UNIQUE key rejects two routes with the same pattern shape for the
 *    same group+endpoint — exactly the ambiguity the five-key sort would
 *    otherwise have to arbitrate; different match types or endpoints stay
 *    expressible.
 *
 * 2. `saas_billing_groups.composite` — the composite marker on the migration
 *    105 group head. Default false keeps every existing group's scheduling
 *    and pricing path byte-identical (the golden-fixture red line); the
 *    gateway scheduler enters the composite resolution branch only when the
 *    resolved group carries the marker.
 *
 * 3. `saas_prepared_request_evidence.composite_route` — the durable copy of
 *    the resolved composite decision. Dispatch-time evidence preflight and
 *    claim re-run the route authority recheck from the persisted row; without
 *    the persisted decision they would reject the composite serving endpoint
 *    against the nominal route-config endpoint. The signed statement is
 *    unchanged (it already covers the composite outcome through its
 *    provider/product/model/endpoint fields); the column is gateway-written
 *    (the table's existing full-insert + dynamic read grants cover it).
 *
 * No authz_version bump lives in this migration (the service-layer CAS
 * pattern owns invalidation); no credential material, no triggers.
 */
const compositeModelRoutesSql = `
ALTER TABLE saas_billing_groups
  ADD COLUMN composite boolean NOT NULL DEFAULT false;

ALTER TABLE saas_prepared_request_evidence
  ADD COLUMN composite_route jsonb,
  ADD CONSTRAINT saas_prepared_request_evidence_composite_route_shape
    CHECK (composite_route IS NULL OR jsonb_typeof(composite_route) = 'object');

CREATE TABLE saas_composite_model_routes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id text NOT NULL REFERENCES saas_billing_groups (id) ON DELETE CASCADE,
  public_model varchar(200) NOT NULL,
  match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'prefix')),
  target_platform varchar(50) NOT NULL,
  upstream_model varchar(200) NOT NULL DEFAULT '',
  endpoint text NOT NULL DEFAULT 'any'
    CHECK (endpoint IN ('any', 'messages', 'responses', 'chat_completions', 'gemini')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 100000),
  enabled boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_composite_model_routes_public_model_nonempty CHECK (
    char_length(public_model) BETWEEN 1 AND 200 AND public_model = btrim(public_model)
  ),
  CONSTRAINT saas_composite_model_routes_target_platform_nonempty CHECK (
    char_length(target_platform) BETWEEN 1 AND 50 AND target_platform = btrim(target_platform)
  ),
  CONSTRAINT saas_composite_model_routes_upstream_model_trimmed CHECK (
    char_length(upstream_model) <= 200 AND upstream_model = btrim(upstream_model)
  ),
  CONSTRAINT saas_composite_model_routes_notes_bounded CHECK (char_length(notes) <= 2000),
  CONSTRAINT saas_composite_model_routes_shape UNIQUE (group_id, public_model, match_type, endpoint)
);

CREATE INDEX saas_composite_model_routes_group_idx ON saas_composite_model_routes (group_id);

CREATE INDEX saas_composite_model_routes_group_enabled_idx
  ON saas_composite_model_routes (group_id, enabled);

CREATE INDEX saas_composite_model_routes_group_endpoint_idx
  ON saas_composite_model_routes (group_id, endpoint);

CREATE INDEX saas_composite_model_routes_group_platform_idx
  ON saas_composite_model_routes (group_id, target_platform);

CREATE INDEX saas_composite_model_routes_priority_idx ON saas_composite_model_routes (priority);
`;

export const COMPOSITE_MODEL_ROUTES_SAAS_MIGRATION: SaasMigration = {
  version: 121,
  name: 'composite_model_routes',
  sql: compositeModelRoutesSql,
};
