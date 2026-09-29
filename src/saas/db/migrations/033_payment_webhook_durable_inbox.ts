import type { SaasMigration } from './001_initial_schema.js';

const paymentWebhookDurableInboxSql = `
-- Migration 030 stored normalized webhook events but processed them inline.
-- Existing rows are complete; only events inserted after this migration queue.
ALTER TABLE saas_payment_inbox
  ADD COLUMN processing_state text NOT NULL DEFAULT 'processed'
    CHECK (processing_state IN ('pending', 'processing', 'processed')),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN last_error_code text
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_:-]{1,96}$'),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE saas_payment_inbox
  ALTER COLUMN processing_state SET DEFAULT 'pending',
  ADD CONSTRAINT saas_payment_inbox_worker_lease_shape CHECK (
    (processing_state = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (processing_state <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  );

CREATE INDEX saas_payment_inbox_worker_queue_idx
  ON saas_payment_inbox (next_attempt_at, received_at, id)
  WHERE processing_state = 'pending';
CREATE INDEX saas_payment_inbox_worker_expired_lease_idx
  ON saas_payment_inbox (lease_expires_at, received_at, id)
  WHERE processing_state = 'processing';
`;

export const PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION: SaasMigration = {
  version: 33,
  name: 'payment_webhook_durable_inbox_worker',
  sql: paymentWebhookDurableInboxSql,
};
