import type { SQLiteTelemetryStore } from './telemetry-store.js';

export interface ResponseOwnership {
  responseId: string;
  proxyKeyId: string;
  upstreamId: string;
  credentialId: string | null;
  expiresAtMs: number;
}

/** Persists only response identifiers and routing ownership, never conversation content. */
export class ResponseOwnershipStore {
  constructor(private readonly telemetry: SQLiteTelemetryStore) {
    telemetry.connection.exec(`CREATE TABLE IF NOT EXISTS response_ownership (
      response_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, upstream_id TEXT NOT NULL,
      credential_id TEXT, expires_at_ms INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_response_ownership_expiry ON response_ownership(expires_at_ms)`);
  }

  get(responseId: string, proxyKeyId: string): ResponseOwnership | null {
    const row = this.telemetry.connection
      .prepare(`SELECT response_id, proxy_key_id, upstream_id,
      credential_id, expires_at_ms FROM response_ownership WHERE response_id=? AND proxy_key_id=? AND expires_at_ms>?`)
      .get(responseId, proxyKeyId, Date.now()) as
      | {
          response_id: string;
          proxy_key_id: string;
          upstream_id: string;
          credential_id: string | null;
          expires_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    return {
      responseId: row.response_id,
      proxyKeyId: row.proxy_key_id,
      upstreamId: row.upstream_id,
      credentialId: row.credential_id,
      expiresAtMs: row.expires_at_ms,
    };
  }

  put(owner: ResponseOwnership): void {
    this.telemetry.connection
      .prepare(`INSERT INTO response_ownership
      (response_id,proxy_key_id,upstream_id,credential_id,expires_at_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(response_id) DO UPDATE SET proxy_key_id=excluded.proxy_key_id,
      upstream_id=excluded.upstream_id,credential_id=excluded.credential_id,
      expires_at_ms=excluded.expires_at_ms`)
      .run(owner.responseId, owner.proxyKeyId, owner.upstreamId, owner.credentialId, owner.expiresAtMs);
  }

  prune(nowMs = Date.now()): number {
    return this.telemetry.connection.prepare('DELETE FROM response_ownership WHERE expires_at_ms<=?').run(nowMs)
      .changes;
  }
}
