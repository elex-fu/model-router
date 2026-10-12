import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track G4 announcements (design: docs/marketing-domain-design-2026-10-11.md
 * §7, migration ledger 092). Announcements are platform-wide broadcasts:
 * operators create a draft, publish it once (draft -> published, the only
 * transition that produces the platform.maintenance webhook event) and may
 * withdraw it (published -> withdrawn, terminal). Identity columns (kind,
 * severity, title, body, publish window start, creator) are immutable after
 * insert — a correction is a withdraw plus a new draft. Every update is a
 * version CAS: the guard trigger requires version to increment by exactly
 * one, so the service-level optimistic concurrency predicate is backed at
 * the database level. Read receipts are append-only per (announcement,
 * user); a duplicate read is an INSERT ON CONFLICT DO NOTHING no-op. Both
 * tables reject deletes, so the audit trail is the only history.
 */
const marketingAnnouncementsSql = `
CREATE TABLE saas_marketing_announcements (
  id uuid PRIMARY KEY,
  kind text NOT NULL
    CHECK (kind IN ('maintenance', 'info', 'billing')),
  severity text NOT NULL
    CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  body text NOT NULL,
  publish_at timestamptz NOT NULL,
  unpublish_at timestamptz,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'withdrawn')),
  version bigint NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_announcements_title_bounds
    CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  CONSTRAINT saas_marketing_announcements_body_bounds
    CHECK (btrim(body) <> '' AND char_length(body) <= 8000),
  CONSTRAINT saas_marketing_announcements_version_positive
    CHECK (version >= 1),
  CONSTRAINT saas_marketing_announcements_window_order
    CHECK (unpublish_at IS NULL OR unpublish_at > publish_at)
);

CREATE TABLE saas_marketing_announcement_reads (
  announcement_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_announcement_reads_pk PRIMARY KEY (announcement_id, user_id),
  CONSTRAINT saas_marketing_announcement_reads_announcement_fk
    FOREIGN KEY (announcement_id) REFERENCES saas_marketing_announcements (id) ON DELETE RESTRICT
);

CREATE FUNCTION saas_marketing_announcement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.severity IS DISTINCT FROM OLD.severity
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.publish_at IS DISTINCT FROM OLD.publish_at
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Marketing announcement identity is immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'draft' AND NEW.status IN ('published', 'withdrawn'))
      OR (OLD.status = 'published' AND NEW.status = 'withdrawn')
    )
  THEN
    RAISE EXCEPTION 'Marketing announcement status transitions are one-way'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Marketing announcement version increments by exactly one'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_marketing_announcement_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_announcements_guard
  BEFORE UPDATE ON saas_marketing_announcements
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_announcement_guard();

CREATE FUNCTION saas_marketing_announcement_read_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing announcement reads are append-only'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_announcement_read_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_announcement_reads_no_update
  BEFORE UPDATE ON saas_marketing_announcement_reads
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_announcement_read_guard();

CREATE FUNCTION saas_marketing_announcement_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing announcement records cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_announcement_reject_delete()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_announcements_no_delete
  BEFORE DELETE ON saas_marketing_announcements
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_announcement_reject_delete();

CREATE TRIGGER saas_marketing_announcement_reads_no_delete
  BEFORE DELETE ON saas_marketing_announcement_reads
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_announcement_reject_delete();
`;

export const MARKETING_ANNOUNCEMENTS_SAAS_MIGRATION: SaasMigration = {
  version: 92,
  name: 'marketing_announcements',
  sql: marketingAnnouncementsSql,
};
