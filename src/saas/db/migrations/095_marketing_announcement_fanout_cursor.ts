import type { SaasMigration } from './001_initial_schema.js';

/**
 * R8/G4.5 announcement webhook fan-out cursor (design:
 * docs/remaining-capability-plan-2026-10-11.md). The announcement row itself
 * is the fan-out cursor: NULL means the published announcement has not been
 * fanned out to tenant webhook endpoints yet. The fan-out worker sets the
 * timestamp only after every entitled tenant has the event durably enqueued
 * (idempotency key announcement:<id>:<tenant>), so a crash mid-fan-out
 * simply re-scans without duplicates.
 */
const marketingAnnouncementFanoutSql = `
ALTER TABLE saas_marketing_announcements
  ADD COLUMN fanout_completed_at timestamptz;

ALTER TABLE saas_marketing_announcements
  ADD CONSTRAINT saas_marketing_announcements_fanout_shape
    CHECK (status <> 'draft' OR fanout_completed_at IS NULL);

CREATE INDEX saas_marketing_announcements_fanout_due_idx
  ON saas_marketing_announcements (publish_at, id)
  WHERE status = 'published' AND fanout_completed_at IS NULL;
`;

export const MARKETING_ANNOUNCEMENT_FANOUT_SAAS_MIGRATION: SaasMigration = {
  version: 95,
  name: 'marketing_announcement_fanout_cursor',
  sql: marketingAnnouncementFanoutSql,
};
