import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

/** The key is independent of config.json and must be backed up with control.sqlite. */
export class SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: Database.Database,
    keyPath: string,
    masterKey?: Buffer,
  ) {
    if (masterKey && masterKey.length !== 32) throw new Error('Secret master key must be 32 bytes');
    if (!masterKey) {
      masterKey = loadOrCreateMasterKey(keyPath);
    }
    if (masterKey.length !== 32) throw new Error('Invalid secret master key');
    this.key = masterKey;
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
      tag BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  put(id: string, value: string): void {
    if (!id || !value || value.includes('\0')) throw new Error('Invalid secret');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO secrets(id,nonce,ciphertext,tag,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,
      ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at`)
      .run(id, nonce, ciphertext, cipher.getAuthTag(), now, now);
  }

  get(id: string): string | undefined {
    const row = this.db.prepare('SELECT nonce,ciphertext,tag FROM secrets WHERE id=?').get(id) as
      | { nonce: Buffer; ciphertext: Buffer; tag: Buffer }
      | undefined;
    if (!row) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce);
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  has(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM secrets WHERE id=?').get(id));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id=?').run(id);
  }

  status(
    source:
      | { type: 'env'; name: string }
      | { type: 'inline'; value: string }
      | { type: 'secret'; id: string },
  ): {
    type: string;
    configured: boolean;
    reference: string;
  } {
    if (source.type === 'inline')
      return { type: 'inline', configured: source.value.length > 0, reference: 'configuration file' };
    return source.type === 'env'
      ? { type: 'env', configured: Boolean(process.env[source.name]), reference: source.name }
      : { type: 'secret', configured: this.has(source.id), reference: source.id };
  }
}

type DurableKeyIo = {
  mkdir(path: string, options: { recursive: true; mode: number }): void;
  open(path: string, flags: string, mode?: number): number;
  write(fd: number, data: Buffer): void;
  fsync(fd: number): void;
  close(fd: number): void;
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
  read(path: string): Buffer;
  random(): Buffer;
  tempPath(directory: string): string;
};

const durableKeyIo: DurableKeyIo = {
  mkdir: mkdirSync,
  open: openSync,
  write: (fd, data) => writeFileSync(fd, data),
  fsync: fsyncSync,
  close: closeSync,
  link: linkSync,
  unlink: unlinkSync,
  read: readFileSync,
  random: () => randomBytes(32),
  tempPath: (directory) => join(directory, `.master-key-${process.pid}-${randomBytes(8).toString('hex')}`),
};

export function loadOrCreateMasterKey(keyPath: string, io: DurableKeyIo = durableKeyIo): Buffer {
  const directory = dirname(keyPath);
  io.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = io.tempPath(directory);
  let tempExists = false;

  try {
    const fd = io.open(tempPath, 'wx', 0o600);
    tempExists = true;
    try {
      io.write(fd, io.random());
      io.fsync(fd);
    } finally {
      io.close(fd);
    }

    try {
      io.link(tempPath, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (tempExists) io.unlink(tempPath);
  }

  // Linking publishes only fully written data. Sync again through the final path,
  // then sync the directory so both new and concurrent readers wait for durability.
  const keyFd = io.open(keyPath, 'r');
  try {
    io.fsync(keyFd);
  } finally {
    io.close(keyFd);
  }
  const directoryFd = io.open(directory, 'r');
  try {
    io.fsync(directoryFd);
  } finally {
    io.close(directoryFd);
  }
  return io.read(keyPath);
}
