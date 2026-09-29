import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SecretStore } from '../secrets/store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const historyInlinePrefix = 'history_inline_';
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface AdminSession {
  userId: string;
  role: 'admin';
  csrf: string;
  expiresAt: number;
}

export class ControlStore {
  readonly db: Database.Database;
  readonly secrets: SecretStore;
  readonly dataDir: string;
  readonly keyPath: string;

  constructor(dataDir: string, masterKey?: Buffer) {
    this.dataDir = resolve(dataDir);
    this.keyPath = join(this.dataDir, 'master.key');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(this.dataDir, 'control.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config_history (revision INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config_journal (id TEXT PRIMARY KEY, base_revision INTEGER NOT NULL, base_checksum TEXT NOT NULL, candidate_revision INTEGER NOT NULL, candidate_checksum TEXT NOT NULL, actor_id TEXT NOT NULL, changed_paths TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committed','aborted','degraded')), apply_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_adjustments (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, period_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pricing (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pricing_versions (version_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, body TEXT NOT NULL, effective_from TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_pricing_versions_profile_effective ON pricing_versions(profile_id,effective_from);
      CREATE TRIGGER IF NOT EXISTS pricing_versions_immutable_update BEFORE UPDATE ON pricing_versions BEGIN SELECT RAISE(ABORT,'pricing versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS pricing_versions_immutable_delete BEFORE DELETE ON pricing_versions BEGIN SELECT RAISE(ABORT,'pricing versions are immutable'); END;
      CREATE TABLE IF NOT EXISTS pricing_version_sequence (sequence INTEGER PRIMARY KEY AUTOINCREMENT, version_id TEXT NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS pricing_version_sequence_immutable_update BEFORE UPDATE ON pricing_version_sequence BEGIN SELECT RAISE(ABORT,'pricing version sequence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS pricing_version_sequence_immutable_delete BEFORE DELETE ON pricing_version_sequence BEGIN SELECT RAISE(ABORT,'pricing version sequence is immutable'); END;
    `);
    this.migratePricingVersions();
    const journalColumns = new Set(
      (this.db.prepare('PRAGMA table_info(config_journal)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!journalColumns.has('resolution_status'))
      this.db.exec(
        "ALTER TABLE config_journal ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'active' CHECK(resolution_status IN ('active','superseded'))",
      );
    if (!journalColumns.has('superseded_by_revision'))
      this.db.exec('ALTER TABLE config_journal ADD COLUMN superseded_by_revision INTEGER');
    if (!journalColumns.has('superseded_by_checksum'))
      this.db.exec('ALTER TABLE config_journal ADD COLUMN superseded_by_checksum TEXT');
    this.secrets = new SecretStore(this.db, this.keyPath, masterKey);
  }

  private migratePricingVersions(): void {
    const rows = this.db.prepare('SELECT id,body,updated_at FROM pricing').all() as Array<{
      id: string;
      body: string;
      updated_at: string;
    }>;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pricing_versions (version_id,profile_id,body,effective_from,created_at) VALUES(?,?,?,?,?)',
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let profile: Record<string, unknown>;
        try {
          profile = JSON.parse(row.body) as Record<string, unknown>;
        } catch {
          continue;
        }
        const effectiveFrom = typeof profile.effectiveFrom === 'string' ? profile.effectiveFrom : row.updated_at;
        const versionId = typeof profile.versionId === 'string' ? profile.versionId : `pv_legacy_${row.id}`;
        const version = { ...profile, id: row.id, versionId, effectiveFrom };
        insert.run(versionId, row.id, JSON.stringify(version), effectiveFrom, row.updated_at);
      }
      const unsequenced = this.db.prepare(`SELECT version_id FROM pricing_versions
        WHERE version_id NOT IN (SELECT version_id FROM pricing_version_sequence)
        ORDER BY effective_from,created_at,version_id`).all() as Array<{ version_id: string }>;
      const sequence = this.db.prepare('INSERT OR IGNORE INTO pricing_version_sequence (version_id) VALUES(?)');
      for (const row of unsequenced) sequence.run(row.version_id);
    });
    tx();
  }

  hasAdmin(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM users LIMIT 1').get());
  }

  createAdmin(name: string, password: string): void {
    if (this.hasAdmin()) throw new Error('Admin already exists');
    if (name.length < 1 || name.length > 100 || password.length < 12) throw new Error('Invalid admin credentials');
    const salt = randomBytes(16).toString('hex');
    this.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run('admin', name, salt, scryptSync(password, salt, 64).toString('hex'), 'admin');
  }

  login(
    name: string,
    password: string,
    ttlSeconds: number,
  ): { token: string; csrf: string; session: AdminSession } | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE name=?').get(name) as
      | { id: string; salt: string; password_hash: string; role: 'admin' }
      | undefined;
    // Perform equivalent work for an unknown user.
    const salt = row?.salt ?? '00000000000000000000000000000000';
    const candidate = scryptSync(password, salt, 64).toString('hex');
    if (!row || !equal(candidate, row.password_hash)) return undefined;
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), row.id, hash(csrf), expiresAt);
    return { token, csrf, session: { userId: row.id, role: row.role, csrf, expiresAt } };
  }

  session(token: string): (Omit<AdminSession, 'csrf'> & { csrfHash: string }) | undefined {
    const row = this.db
      .prepare(`SELECT s.user_id AS userId,u.role,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`)
      .get(hash(token)) as { userId: string; role: 'admin'; csrfHash: string; expiresAt: number } | undefined;
    if (!row || row.expiresAt <= Date.now()) return undefined;
    return row;
  }

  checkCsrf(session: { csrfHash: string }, csrf: string): boolean {
    return equal(session.csrfHash, hash(csrf));
  }
  refreshCsrf(token: string): string {
    const csrf = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE sessions SET csrf_hash=? WHERE token_hash=?').run(hash(csrf), hash(token));
    return csrf;
  }
  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  }
  audit(actor: string, action: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
      .run(randomBytes(16).toString('hex'), actor, action, JSON.stringify(detail), new Date().toISOString());
  }
  history(revision: number, actor: string, config: unknown): void {
    this.ensureHistory(revision, actor, config, hash(JSON.stringify(config)), new Date().toISOString());
  }
  configHistoryRows(): Array<{ config_json: string }> {
    const rows = this.db.prepare('SELECT config_json FROM config_history ORDER BY revision').all() as Array<{
      config_json: string;
    }>;
    try {
      return rows.map(({ config_json }) => ({
        config_json: JSON.stringify(this.decodeHistoryConfig(JSON.parse(config_json))),
      }));
    } catch {
      throw new Error('malformed config history');
    }
  }
  configHistoryConfig(revision: number): unknown | undefined {
    const row = this.db.prepare('SELECT config_json FROM config_history WHERE revision=?').get(revision) as
      | { config_json: string }
      | undefined;
    return row ? this.decodeHistoryConfig(JSON.parse(row.config_json)) : undefined;
  }
  private encodeHistoryConfig(config: unknown): unknown {
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== 'object') return value;
      const item = value as Record<string, unknown>;
      if (item.type === 'inline' && typeof item.value === 'string' && item.value.length > 0) {
        const id = `${historyInlinePrefix}${randomBytes(16).toString('hex')}`;
        this.secrets.put(id, item.value);
        return { type: 'secret', id };
      }
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    };
    return visit(config);
  }
  private decodeHistoryConfig(config: unknown): unknown {
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== 'object') return value;
      const item = value as Record<string, unknown>;
      if (item.type === 'secret' && typeof item.id === 'string' && item.id.startsWith(historyInlinePrefix)) {
        const secret = this.secrets.get(item.id);
        if (!secret) throw new Error('Encrypted inline credential is missing from config history');
        return { type: 'inline', value: secret };
      }
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    };
    return visit(config);
  }
  deleteOrphanedGeneratedSecrets(referencedIds: ReadonlySet<string>): number {
    const generatedId = /^sec_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const remove = this.db.prepare('DELETE FROM secrets WHERE id=?');
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id FROM secrets').all() as Array<{ id: string }>;
      const orphaned = rows
        .map(({ id }) => id)
        .filter((id) => generatedId.test(id) && !referencedIds.has(id));
      for (const id of orphaned) remove.run(id);
      if (orphaned.length)
        this.db
          .prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
          .run(randomBytes(16).toString('hex'), 'system', 'credential.orphan_gc', JSON.stringify({ count: orphaned.length }), new Date().toISOString());
      return orphaned.length;
    });
    return tx();
  }
  prepareConfigCommit(input: {
    id: string;
    baseRevision: number;
    baseChecksum: string;
    candidateRevision: number;
    candidateChecksum: string;
    actor: string;
    paths: string[];
    baseConfig: unknown;
  }): void {
    const base = input.baseConfig as { revision?: number };
    if (
      input.candidateRevision !== input.baseRevision + 1 ||
      base.revision !== input.baseRevision ||
      hash(JSON.stringify(input.baseConfig)) !== input.baseChecksum
    )
      throw new Error('Invalid config journal base revision or checksum');
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.ensureHistory(input.baseRevision, input.actor, input.baseConfig, input.baseChecksum, now);
      this.db
        .prepare(`INSERT INTO config_journal (id,base_revision,base_checksum,candidate_revision,candidate_checksum,actor_id,changed_paths,state,apply_error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'prepared',NULL,?,?)`)
        .run(
          input.id,
          input.baseRevision,
          input.baseChecksum,
          input.candidateRevision,
          input.candidateChecksum,
          input.actor,
          JSON.stringify(input.paths),
          now,
          now,
        );
    });
    tx();
  }
  prepareLegacyMigration(baseChecksum: string, candidate: { revision: number; checksum: string }): string {
    const id = `migration-${candidate.checksum}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO config_journal
      (id,base_revision,base_checksum,candidate_revision,candidate_checksum,actor_id,changed_paths,state,apply_error,created_at,updated_at)
      VALUES(?,0,?,?,?,'migration','["schemaVersion"]','prepared',NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET state='prepared',updated_at=excluded.updated_at
      WHERE config_journal.state='aborted' AND config_journal.base_checksum=excluded.base_checksum
        AND config_journal.candidate_checksum=excluded.candidate_checksum`)
      .run(id, baseChecksum, candidate.revision, candidate.checksum, now, now);
    const row = this.db.prepare('SELECT base_checksum,candidate_revision,candidate_checksum,state FROM config_journal WHERE id=?').get(id) as
      { base_checksum: string; candidate_revision: number; candidate_checksum: string; state: string };
    if (row.base_checksum !== baseChecksum || row.candidate_revision !== candidate.revision || row.candidate_checksum !== candidate.checksum || row.state !== 'prepared')
      throw new Error('Config migration journal checksum conflict; refusing migration');
    return id;
  }
  finalizeLegacyMigration(candidate: unknown): void {
    const cfg = candidate as { revision: number };
    const checksum = hash(JSON.stringify(candidate));
    const row = this.db.prepare("SELECT id FROM config_journal WHERE actor_id='migration' AND state='prepared' AND candidate_revision=? AND candidate_checksum=?").get(cfg.revision, checksum) as { id: string } | undefined;
    if (!row) throw new Error('Missing or conflicting config migration journal; refusing finalize');
    this.recoverPrepared({ revision: cfg.revision, checksum }, candidate);
  }
  recoverLegacy(baseChecksum: string): void {
    const rows = this.db.prepare("SELECT id,base_checksum FROM config_journal WHERE actor_id='migration' AND state='prepared'").all() as Array<{id:string;base_checksum:string}>;
    for (const row of rows) {
      if (row.base_checksum !== baseChecksum) throw new Error('Config migration checksum conflict; refusing retry');
      this.db.prepare("UPDATE config_journal SET state='aborted',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    }
  }
  finalizeConfigCommit(
    id: string,
    current: { revision: number; config: unknown },
    candidate: { revision: number; config: unknown },
  ): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT base_revision,base_checksum,candidate_revision,candidate_checksum,actor_id,changed_paths,state FROM config_journal WHERE id=?',
        )
        .get(id) as
        | {
            base_revision: number;
            base_checksum: string;
            candidate_revision: number;
            candidate_checksum: string;
            actor_id: string;
            changed_paths: string;
            state: string;
          }
        | undefined;
      if (!row) throw new Error(`Missing config journal record ${id}`);
      if (
        row.state !== 'prepared' ||
        current.revision !== row.base_revision ||
        candidate.revision !== row.candidate_revision ||
        hash(JSON.stringify(current.config)) !== row.base_checksum ||
        hash(JSON.stringify(candidate.config)) !== row.candidate_checksum
      )
        throw new Error(`Config journal checksum conflict for ${id}`);
      const now = new Date().toISOString();
      this.ensureHistory(current.revision, row.actor_id, current.config, row.base_checksum, now);
      this.ensureHistory(candidate.revision, row.actor_id, candidate.config, row.candidate_checksum, now);
      this.db
        .prepare(`INSERT INTO audit_events (id,actor_id,action,detail,created_at)
        SELECT ?,?,'config.commit',?,? WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE action='config.commit' AND json_extract(detail,'$.journalId')=?)`)
        .run(
          id,
          row.actor_id,
          JSON.stringify({ revision: row.candidate_revision, paths: JSON.parse(row.changed_paths), journalId: id }),
          new Date().toISOString(),
          id,
        );
      this.db
        .prepare("UPDATE config_journal SET state='committed', apply_error=NULL, updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    });
    tx();
  }
  markConfigDegraded(id: string, error: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE config_journal SET state='degraded', apply_error=?, updated_at=? WHERE id=?")
        .run(error.slice(0, 500), new Date().toISOString(), id);
      this.db
        .prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)')
        .run(
          randomBytes(16).toString('hex'),
          'system',
          'config.apply_failed',
          JSON.stringify({ journalId: id, error: error.slice(0, 500) }),
          new Date().toISOString(),
        );
    });
    tx();
  }
  prepareObservedExternal(input: {
    baseRevision: number;
    baseChecksum: string;
    candidateRevision: number;
    candidateChecksum: string;
    paths: string[];
    baseConfig: unknown;
    candidateConfig: unknown;
  }): string {
    const base = input.baseConfig as { revision?: number };
    const candidate = input.candidateConfig as { revision?: number };
    if (
      input.candidateRevision !== input.baseRevision + 1 ||
      base.revision !== input.baseRevision ||
      candidate.revision !== input.candidateRevision ||
      input.baseChecksum === input.candidateChecksum ||
      hash(JSON.stringify(input.baseConfig)) !== input.baseChecksum ||
      hash(JSON.stringify(input.candidateConfig)) !== input.candidateChecksum
    )
      throw new Error('External configuration must advance exactly one revision with matching checksums');
    const now = new Date().toISOString();
    let preparedId = '';
    const tx = this.db.transaction(() => {
      this.ensureHistory(input.baseRevision, 'external', input.baseConfig, input.baseChecksum, now);
      this.ensureHistory(input.candidateRevision, 'external', input.candidateConfig, input.candidateChecksum, now);
      const existing = this.db
        .prepare(`SELECT id,changed_paths,state FROM config_journal WHERE actor_id='external' AND base_revision=? AND base_checksum=?
        AND candidate_revision=? AND candidate_checksum=? AND state IN ('prepared','committed')`)
        .get(input.baseRevision, input.baseChecksum, input.candidateRevision, input.candidateChecksum) as
        | { id: string; changed_paths: string; state: string }
        | undefined;
      if (existing) {
        if (existing.changed_paths !== JSON.stringify(input.paths))
          throw new Error('Conflicting observed external change metadata');
        preparedId = existing.id;
        return;
      }
      const id = `external_${randomBytes(16).toString('hex')}`;
      this.db
        .prepare(`INSERT INTO config_journal (id,base_revision,base_checksum,candidate_revision,candidate_checksum,actor_id,changed_paths,state,apply_error,created_at,updated_at)
        VALUES(?,?,?,?,?,'external',?,'prepared',NULL,?,?)`)
        .run(
          id,
          input.baseRevision,
          input.baseChecksum,
          input.candidateRevision,
          input.candidateChecksum,
          JSON.stringify(input.paths),
          now,
          now,
        );
      preparedId = id;
    });
    tx();
    return preparedId;
  }
  finalizeObservedExternal(id: string, runtimeState: 'applied' | 'restart_required'): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT candidate_revision,candidate_checksum,changed_paths,actor_id,state FROM config_journal WHERE id=?',
        )
        .get(id) as
        | {
            candidate_revision: number;
            candidate_checksum: string;
            changed_paths: string;
            actor_id: string;
            state: string;
          }
        | undefined;
      if (!row || row.actor_id !== 'external' || !['prepared', 'committed'].includes(row.state))
        throw new Error(`Missing or invalid external config journal record ${id}`);
      const candidate = this.historyConfig(row.candidate_revision, row.candidate_checksum);
      if (candidate === undefined)
        throw new Error(`Missing or conflicting external history at revision ${row.candidate_revision}`);
      const now = new Date().toISOString();
      this.db
        .prepare(`INSERT INTO audit_events (id,actor_id,action,detail,created_at)
        SELECT ?,?,'config.commit',?,? WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`)
        .run(
          id,
          row.actor_id,
          JSON.stringify({
            revision: row.candidate_revision,
            paths: JSON.parse(row.changed_paths) as string[],
            journalId: id,
            source: 'observed_external',
            runtimeState,
          }),
          now,
          id,
        );
      this.db.prepare("UPDATE config_journal SET state='committed',updated_at=? WHERE id=?").run(now, id);
    });
    tx();
  }
  private ensureHistory(
    revision: number,
    actor: string,
    config: unknown,
    expectedChecksum: string,
    createdAt: string,
  ): void {
    if (hash(JSON.stringify(config)) !== expectedChecksum)
      throw new Error(`Config history checksum mismatch at revision ${revision}`);
    const existing = this.db.prepare('SELECT config_json FROM config_history WHERE revision=?').get(revision) as
      | { config_json: string }
      | undefined;
    if (existing) {
      const checksum = hash(JSON.stringify(this.decodeHistoryConfig(JSON.parse(existing.config_json) as unknown)));
      if (checksum !== expectedChecksum) throw new Error(`Conflicting config history at revision ${revision}`);
      return;
    }
    const encryptedConfig = this.encodeHistoryConfig(config);
    this.db
      .prepare('INSERT INTO config_history VALUES(?,?,?,?)')
      .run(revision, actor, JSON.stringify(encryptedConfig), createdAt);
  }
  hasNonExternalCommit(baseRevision: number, baseChecksum: string, revision: number, checksum: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM config_journal WHERE actor_id<>'external' AND state IN ('prepared','committed','degraded')
      AND resolution_status='active' AND base_revision=? AND base_checksum=? AND candidate_revision=? AND candidate_checksum=?`)
        .get(baseRevision, baseChecksum, revision, checksum),
    );
  }
  recoverPrepared(disk: { revision: number; checksum: string }, diskConfig: unknown): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM config_journal WHERE state='prepared' OR (state='degraded' AND resolution_status='active') ORDER BY created_at DESC",
      )
      .all() as Array<{
      id: string;
      base_revision: number;
      base_checksum: string;
      candidate_revision: number;
      candidate_checksum: string;
      actor_id: string;
      changed_paths: string;
      state: 'prepared' | 'degraded';
    }>;
    for (const row of rows) {
      if (disk.revision === row.candidate_revision && disk.checksum === row.candidate_checksum) {
        const prior = this.db
          .prepare('SELECT config_json FROM config_history WHERE revision=?')
          .get(row.base_revision) as { config_json: string } | undefined;
        const candidate = diskConfig as { revision: number };
        const tx = this.db.transaction(() => {
          if (
            row.actor_id !== 'migration' &&
            (!prior || hash(JSON.stringify(this.decodeHistoryConfig(JSON.parse(prior.config_json) as unknown))) !== row.base_checksum)
          )
            throw new Error(`Missing or conflicting base config history for revision ${row.base_revision}`);
          const now = new Date().toISOString();
          this.ensureHistory(candidate.revision, row.actor_id, diskConfig, row.candidate_checksum, now);
          const detail = {
            revision: row.candidate_revision,
            paths: JSON.parse(row.changed_paths) as string[],
            journalId: row.id,
            ...(row.actor_id === 'external' ? { source: 'observed_external', runtimeState: 'recovered' } : {}),
          };
          this.db
            .prepare(`INSERT INTO audit_events (id,actor_id,action,detail,created_at)
            SELECT ?,?,'config.commit',?,? WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`)
            .run(row.id, row.actor_id, JSON.stringify(detail), now, row.id);
          this.db
            .prepare("UPDATE config_journal SET state='committed', apply_error=NULL, updated_at=? WHERE id=?")
            .run(new Date().toISOString(), row.id);
        });
        tx();
      } else if (
        row.state === 'prepared' &&
        disk.revision === row.base_revision &&
        disk.checksum === row.base_checksum
      ) {
        this.db
          .prepare("UPDATE config_journal SET state='aborted', updated_at=? WHERE id=?")
          .run(new Date().toISOString(), row.id);
      } else if (
        row.state === 'degraded' &&
        this.hasCommittedChain(row.candidate_revision, row.candidate_checksum, disk.revision, disk.checksum)
      ) {
        this.resolveSuperseded(row, disk.revision, disk.checksum);
      } else {
        throw new Error(
          `Config recovery checksum conflict for ${row.state} revision ${row.candidate_revision}; refusing startup`,
        );
      }
    }
  }
  private historyConfig(revision: number, expectedChecksum: string): unknown | undefined {
    const result = this.db.prepare('SELECT config_json FROM config_history WHERE revision=?').get(revision) as
      | { config_json: string }
      | undefined;
    if (!result) return undefined;
    const config: unknown = this.decodeHistoryConfig(JSON.parse(result.config_json));
    return hash(JSON.stringify(config)) === expectedChecksum ? config : undefined;
  }
  private hasCommittedChain(
    startRevision: number,
    startChecksum: string,
    targetRevision: number,
    targetChecksum: string,
  ): boolean {
    if (targetRevision <= startRevision) return false;
    let revision = startRevision;
    let checksum = startChecksum;
    const rows = this.db
      .prepare(`SELECT base_revision,base_checksum,candidate_revision,candidate_checksum
      FROM config_journal WHERE state='committed' OR (state='degraded' AND resolution_status='superseded')`)
      .all() as Array<{
      base_revision: number;
      base_checksum: string;
      candidate_revision: number;
      candidate_checksum: string;
    }>;
    const seen = new Set<string>();
    while (revision < targetRevision) {
      const key = `${revision}:${checksum}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const successors = rows.filter(
        (item) =>
          item.base_revision === revision &&
          item.base_checksum === checksum &&
          item.candidate_revision === revision + 1 &&
          this.historyConfig(item.candidate_revision, item.candidate_checksum) !== undefined,
      );
      if (successors.length !== 1) return false;
      revision = successors[0]!.candidate_revision;
      checksum = successors[0]!.candidate_checksum;
    }
    return revision === targetRevision && checksum === targetChecksum;
  }
  private resolveSuperseded(
    row: {
      id: string;
      actor_id: string;
      candidate_revision: number;
      candidate_checksum: string;
      changed_paths: string;
    },
    targetRevision: number,
    targetChecksum: string,
  ): void {
    const candidateConfig = this.historyConfig(row.candidate_revision, row.candidate_checksum);
    if (candidateConfig === undefined)
      throw new Error(`Missing or conflicting candidate history for degraded revision ${row.candidate_revision}`);
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.ensureHistory(row.candidate_revision, row.actor_id, candidateConfig, row.candidate_checksum, now);
      this.db
        .prepare(`INSERT INTO audit_events (id,actor_id,action,detail,created_at)
        SELECT ?,?,'config.commit',?,? WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`)
        .run(
          row.id,
          row.actor_id,
          JSON.stringify({
            revision: row.candidate_revision,
            paths: JSON.parse(row.changed_paths) as string[],
            journalId: row.id,
            runtimeApply: 'failed',
            supersededByRevision: targetRevision,
          }),
          now,
          row.id,
        );
      this.db
        .prepare(`INSERT INTO audit_events (id,actor_id,action,detail,created_at)
        SELECT ?,?,'config.superseded',?,? WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`)
        .run(
          `${row.id}_superseded`,
          row.actor_id,
          JSON.stringify({
            revision: row.candidate_revision,
            journalId: row.id,
            supersededByRevision: targetRevision,
            supersededByChecksum: targetChecksum,
          }),
          now,
          `${row.id}_superseded`,
        );
      this.db
        .prepare(
          `UPDATE config_journal SET resolution_status='superseded',superseded_by_revision=?,superseded_by_checksum=?,updated_at=? WHERE id=?`,
        )
        .run(targetRevision, targetChecksum, now, row.id);
    });
    tx();
  }
  close(): void {
    this.db.close();
  }
}
