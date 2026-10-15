import type { SaasMigration } from './001_initial_schema.js';

/**
 * R3 egress proxies (docs/token-resale-implementation-plan-2026-10-15.md
 * §R3): the sub2api per-account egress-proxy survival line. One proxy record
 * can back all three upstream paths of an account (forwarding, OAuth token
 * refresh, manual probe) so the provider always sees the same exit IP — the
 * sub2api core lesson: mixed egress IPs trip provider risk control.
 *
 * Numbered 107: the plan's table reserved 105 for this workstream, but R1
 * billing groups consumed 105 first (documented re-arbitration) and 106 was
 * taken by R4 registration admission; 107 is the free slot between the
 * applied head 106 and the already-registered 108 (fail-closed serial
 * ordering — lower numbers can never be applied on top of an applied head).
 *
 * Design notes (sub2api parity, adapted to this repo's invariants):
 * - Credentials NEVER live in plaintext columns: `auth_sealed_envelope`
 *   stores the same KMS envelope object used for provider credentials
 *   (sealProviderCredential output). The CHECK pins the envelope shape so a
 *   schema-level disclosure or a rogue writer cannot smuggle a
 *   username/password pair into the row.
 * - Protocol whitelist {http, https, socks5, socks5h} mirrors sub2api.
 *   socks5 is auto-upgraded to socks5h at URL-assembly time (remote DNS,
 *   anti-pollution); an invalid protocol is an error, never a downgrade.
 * - fallback_mode drives the expiry sweep: none = audit alert only,
 *   proxy = migrate accounts to backup_proxy_id, direct = un-proxy accounts.
 *   proxy_fallback_origin_id on the account records the pre-migration proxy
 *   so an operator can manually roll back after fixing the primary.
 * - backup chains are validated by the sweep (cycle-safe walk); the CHECKs
 *   only pin the local shape (no self-backup, backup present exactly when
 *   fallback_mode = 'proxy').
 * - Probe results (last_probe_*) are written by the egress-proxy probe
 *   worker; quality is a scheduling signal (dead demotes the account's
 *   scheduling weight to the contract minimum), never a hard removal —
 *   proxy jitter must not trigger account migration storms.
 * - egress_proxy_id is ON DELETE RESTRICT: silently un-proxying in-use
 *   accounts on proxy deletion would change their exit IP without an
 *   operator decision (exactly the risk-control trigger this table exists
 *   to prevent). Expired proxies transition to status 'expired' instead.
 */
const egressProxiesSql = `
CREATE TABLE saas_egress_proxies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  protocol text NOT NULL
    CHECK (protocol IN ('http', 'https', 'socks5', 'socks5h')),
  host text NOT NULL
    CHECK (btrim(host) <> '' AND host = btrim(host) AND char_length(host) <= 255),
  port integer NOT NULL
    CHECK (port >= 1 AND port <= 65535),
  auth_sealed_envelope jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'expired')),
  expires_at timestamptz,
  fallback_mode text NOT NULL DEFAULT 'none'
    CHECK (fallback_mode IN ('none', 'proxy', 'direct')),
  backup_proxy_id uuid,
  last_probe_at timestamptz,
  last_probe_latency_ms integer
    CHECK (last_probe_latency_ms IS NULL OR last_probe_latency_ms >= 0),
  last_probe_ip inet,
  last_probe_quality text
    CHECK (last_probe_quality IS NULL OR last_probe_quality IN ('ok', 'degraded', 'dead')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_egress_proxies_name_unique UNIQUE (name),
  CONSTRAINT saas_egress_proxies_name_shape
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 128 AND name = btrim(name)),
  CONSTRAINT saas_egress_proxies_backup_fk
    FOREIGN KEY (backup_proxy_id) REFERENCES saas_egress_proxies (id) ON DELETE SET NULL,
  CONSTRAINT saas_egress_proxies_no_self_backup
    CHECK (backup_proxy_id IS NULL OR backup_proxy_id <> id),
  CONSTRAINT saas_egress_proxies_fallback_shape
    CHECK (
      (fallback_mode = 'proxy' AND backup_proxy_id IS NOT NULL)
      OR (fallback_mode <> 'proxy' AND backup_proxy_id IS NULL)
    ),
  CONSTRAINT saas_egress_proxies_auth_envelope_shape
    CHECK (
      auth_sealed_envelope IS NULL
      OR (
        jsonb_typeof(auth_sealed_envelope) = 'object'
        AND (auth_sealed_envelope ->> 'algorithm') = 'aes-256-gcm'
        AND (auth_sealed_envelope ->> 'kmsKeyId') IS NOT NULL
        AND (auth_sealed_envelope ->> 'wrappedDek') IS NOT NULL
        AND (auth_sealed_envelope ->> 'nonce') IS NOT NULL
        AND (auth_sealed_envelope ->> 'ciphertext') IS NOT NULL
        AND (auth_sealed_envelope ->> 'authTag') IS NOT NULL
        AND NOT (auth_sealed_envelope ? 'username')
        AND NOT (auth_sealed_envelope ? 'password')
      )
    )
);

CREATE INDEX saas_egress_proxies_expires_at_idx
  ON saas_egress_proxies (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX saas_egress_proxies_backup_idx
  ON saas_egress_proxies (backup_proxy_id);

ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN egress_proxy_id uuid,
  ADD COLUMN proxy_fallback_origin_id uuid;

ALTER TABLE saas_tenant_provider_accounts
  ADD CONSTRAINT saas_tenant_provider_accounts_egress_proxy_fk
    FOREIGN KEY (egress_proxy_id) REFERENCES saas_egress_proxies (id) ON DELETE RESTRICT,
  ADD CONSTRAINT saas_tenant_provider_accounts_proxy_fallback_origin_fk
    FOREIGN KEY (proxy_fallback_origin_id) REFERENCES saas_egress_proxies (id) ON DELETE SET NULL;

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN egress_proxy_id uuid,
  ADD COLUMN proxy_fallback_origin_id uuid;

ALTER TABLE saas_platform_provider_accounts
  ADD CONSTRAINT saas_platform_provider_accounts_egress_proxy_fk
    FOREIGN KEY (egress_proxy_id) REFERENCES saas_egress_proxies (id) ON DELETE RESTRICT,
  ADD CONSTRAINT saas_platform_provider_accounts_proxy_fallback_origin_fk
    FOREIGN KEY (proxy_fallback_origin_id) REFERENCES saas_egress_proxies (id) ON DELETE SET NULL;

CREATE INDEX saas_tenant_provider_accounts_egress_proxy_idx
  ON saas_tenant_provider_accounts (egress_proxy_id)
  WHERE egress_proxy_id IS NOT NULL;

CREATE INDEX saas_platform_provider_accounts_egress_proxy_idx
  ON saas_platform_provider_accounts (egress_proxy_id)
  WHERE egress_proxy_id IS NOT NULL;
`;

export const EGRESS_PROXIES_SAAS_MIGRATION: SaasMigration = {
  version: 107,
  name: 'egress_proxies',
  sql: egressProxiesSql,
};
