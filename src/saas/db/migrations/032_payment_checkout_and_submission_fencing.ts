import type { SaasMigration } from './001_initial_schema.js';

/*
 * Checkout actions are deliberately scalar and bounded.  Provider payloads
 * never cross this storage boundary.  The submission lease is a fencing fact:
 * an expired or lost create call is reconciled, never blindly submitted again.
 */
const paymentCheckoutAndSubmissionFencingSql = `
ALTER TABLE saas_payment_orders
  ADD COLUMN checkout_kind text,
  ADD COLUMN checkout_url text,
  ADD COLUMN checkout_text text,
  ADD COLUMN checkout_expires_at timestamptz,
  ADD COLUMN provider_submission_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN provider_submission_lease_token text,
  ADD COLUMN provider_submission_lease_expires_at timestamptz,
  ADD CONSTRAINT saas_payment_orders_checkout_shape CHECK (
    (checkout_kind IS NULL AND checkout_url IS NULL AND checkout_text IS NULL AND checkout_expires_at IS NULL)
    OR
    (checkout_kind = 'redirect'
      AND checkout_url IS NOT NULL AND char_length(checkout_url) BETWEEN 1 AND 4096
      AND checkout_url !~ '[[:cntrl:]]'
      AND checkout_text IS NULL AND checkout_expires_at IS NOT NULL)
    OR
    (checkout_kind = 'qr'
      AND checkout_url IS NULL AND checkout_text IS NOT NULL AND char_length(checkout_text) BETWEEN 1 AND 8192
      AND checkout_text !~ '[[:cntrl:]]'
      AND checkout_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT saas_payment_orders_submission_fence_shape CHECK (
    provider_submission_state IN ('idle', 'submitting', 'failed', 'unknown')
    AND (
      (provider_submission_state = 'submitting'
        AND provider_submission_lease_token IS NOT NULL
        AND char_length(provider_submission_lease_token) BETWEEN 1 AND 255
        AND provider_submission_lease_token !~ '[[:cntrl:]]'
        AND provider_submission_lease_expires_at IS NOT NULL)
      OR
      (provider_submission_state <> 'submitting'
        AND provider_submission_lease_token IS NULL
        AND provider_submission_lease_expires_at IS NULL)
    )
  );

ALTER TABLE saas_service_plan_orders
  ADD COLUMN checkout_kind text,
  ADD COLUMN checkout_url text,
  ADD COLUMN checkout_text text,
  ADD COLUMN checkout_expires_at timestamptz,
  ADD COLUMN provider_submission_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN provider_submission_lease_token text,
  ADD COLUMN provider_submission_lease_expires_at timestamptz,
  ADD CONSTRAINT saas_service_plan_orders_checkout_shape CHECK (
    (checkout_kind IS NULL AND checkout_url IS NULL AND checkout_text IS NULL AND checkout_expires_at IS NULL)
    OR
    (checkout_kind = 'redirect'
      AND checkout_url IS NOT NULL AND char_length(checkout_url) BETWEEN 1 AND 4096
      AND checkout_url !~ '[[:cntrl:]]'
      AND checkout_text IS NULL AND checkout_expires_at IS NOT NULL)
    OR
    (checkout_kind = 'qr'
      AND checkout_url IS NULL AND checkout_text IS NOT NULL AND char_length(checkout_text) BETWEEN 1 AND 8192
      AND checkout_text !~ '[[:cntrl:]]'
      AND checkout_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT saas_service_plan_orders_submission_fence_shape CHECK (
    provider_submission_state IN ('idle', 'submitting', 'failed', 'unknown')
    AND (
      (provider_submission_state = 'submitting'
        AND provider_submission_lease_token IS NOT NULL
        AND char_length(provider_submission_lease_token) BETWEEN 1 AND 255
        AND provider_submission_lease_token !~ '[[:cntrl:]]'
        AND provider_submission_lease_expires_at IS NOT NULL)
      OR
      (provider_submission_state <> 'submitting'
        AND provider_submission_lease_token IS NULL
        AND provider_submission_lease_expires_at IS NULL)
    )
  );
`;

export const PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION: SaasMigration = {
  version: 32,
  name: 'payment_checkout_and_submission_fencing',
  sql: paymentCheckoutAndSubmissionFencingSql,
};
