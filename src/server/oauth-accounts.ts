import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface OAuthAccount {
  id: string;
  provider: 'github_copilot' | 'codex_oauth';
  login?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  isDefault: boolean;
}

/** The deliberately small part of SecretStore required by OAuth accounts. */
export interface OAuthSecretStore {
  put(id: string, value: string): void;
  get(id: string): string | undefined;
  delete(id: string): void;
}

interface StoredAccount extends Omit<OAuthAccount, 'accessToken' | 'refreshToken'> {
  secretRef: string;
}

type LegacyAccount = OAuthAccount;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class OAuthAccountStore {
  private accounts: StoredAccount[] = [];

  constructor(
    private readonly configPath: string,
    private readonly secrets: OAuthSecretStore,
  ) {
    if (
      !secrets ||
      typeof secrets.put !== 'function' ||
      typeof secrets.get !== 'function' ||
      typeof secrets.delete !== 'function'
    ) {
      throw new Error('OAuthAccountStore requires a secure SecretStore');
    }
    this.load();
  }

  private get filePath(): string {
    return path.join(path.dirname(this.configPath), 'oauth-accounts.json');
  }

  private readMetadata(): unknown {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
  }

  private readAccounts(): StoredAccount[] {
    const raw = this.readMetadata();
    if (!Array.isArray(raw)) throw new Error('Invalid OAuth account metadata');
    for (const item of raw) {
      if (
        !isRecord(item) ||
        typeof item.secretRef !== 'string' ||
        !item.secretRef ||
        'accessToken' in item ||
        'refreshToken' in item
      ) {
        throw new Error('OAuth account metadata is invalid or contains plaintext credentials');
      }
    }
    return raw as StoredAccount[];
  }

  private writeMetadata(accounts: StoredAccount[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(dir, `.oauth-accounts-${randomUUID()}.tmp`);
    const data = JSON.stringify(accounts, null, 2);
    try {
      const fd = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, data, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, this.filePath);
      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      }
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* temp may not exist */
      }
      throw error;
    }
  }

  private hydrate(account: StoredAccount): OAuthAccount {
    const secret = this.secrets.get(account.secretRef);
    if (secret === undefined)
      throw new Error(`OAuth credentials are missing from secure storage for account ${account.id}`);
    let credentials: { accessToken: string; refreshToken?: string };
    try {
      credentials = JSON.parse(secret) as { accessToken: string; refreshToken?: string };
    } catch {
      throw new Error(`OAuth credentials are invalid in secure storage for account ${account.id}`);
    }
    if (
      typeof credentials.accessToken !== 'string' ||
      (credentials.refreshToken !== undefined && typeof credentials.refreshToken !== 'string')
    ) {
      throw new Error(`OAuth credentials are invalid in secure storage for account ${account.id}`);
    }
    const { secretRef: _secretRef, ...metadata } = account;
    return {
      ...metadata,
      accessToken: credentials.accessToken,
      ...(credentials.refreshToken === undefined ? {} : { refreshToken: credentials.refreshToken }),
    };
  }

  private migrateLegacy(raw: unknown): StoredAccount[] {
    if (!Array.isArray(raw))
      throw new Error('Cannot migrate legacy OAuth accounts: file must contain an account array');
    const legacy = raw as LegacyAccount[];
    if (
      legacy.some(
        (a) =>
          !isRecord(a) ||
          typeof a.id !== 'string' ||
          typeof a.provider !== 'string' ||
          typeof a.accessToken !== 'string' ||
          typeof a.isDefault !== 'boolean' ||
          (a.refreshToken !== undefined && typeof a.refreshToken !== 'string'),
      )
    ) {
      throw new Error(
        'Cannot migrate legacy OAuth accounts: account data is invalid; preserve the file and repair it before retrying',
      );
    }

    const stagedIds: string[] = [];
    try {
      const migrated = legacy.map((account) => {
        const secretRef = `oauth_${randomUUID()}`;
        const encoded = JSON.stringify({
          accessToken: account.accessToken,
          ...(account.refreshToken === undefined ? {} : { refreshToken: account.refreshToken }),
        });
        this.secrets.put(secretRef, encoded);
        stagedIds.push(secretRef);
        const { accessToken: _accessToken, refreshToken: _refreshToken, ...metadata } = account;
        return { ...metadata, secretRef } as StoredAccount;
      });
      this.writeMetadata(migrated);
      return migrated;
    } catch (error) {
      for (const id of stagedIds) {
        try {
          this.secrets.delete(id);
        } catch {
          /* preserve original file; orphan cleanup is safe to retry */
        }
      }
      throw new Error(
        'Could not securely migrate oauth-accounts.json; the original file was preserved. Check secure storage and filesystem permissions, then retry.',
        { cause: error },
      );
    }
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.accounts = [];
      return;
    }
    const raw = this.readMetadata();
    if (Array.isArray(raw) && raw.some((item) => isRecord(item) && ('accessToken' in item || 'refreshToken' in item))) {
      this.accounts = this.migrateLegacy(raw);
      return;
    }
    this.accounts = this.readAccounts();
  }

  save(): void {
    this.writeMetadata(this.accounts);
  }

  add(acc: OAuthAccount): void {
    const currentIndex = this.accounts.findIndex((a) => a.provider === acc.provider && a.id === acc.id);
    const secretRef = currentIndex >= 0 ? this.accounts[currentIndex].secretRef : `oauth_${randomUUID()}`;
    const previousSecret = this.secrets.get(secretRef);
    this.secrets.put(
      secretRef,
      JSON.stringify({
        accessToken: acc.accessToken,
        ...(acc.refreshToken === undefined ? {} : { refreshToken: acc.refreshToken }),
      }),
    );
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...metadata } = acc;
    const next = this.accounts.slice();
    const stored: StoredAccount = { ...metadata, secretRef };
    if (currentIndex >= 0) next[currentIndex] = stored;
    else next.push(stored);
    if (acc.isDefault) {
      for (const account of next)
        if (account.provider === acc.provider && account.id !== acc.id) account.isDefault = false;
    }
    try {
      this.writeMetadata(next);
      this.accounts = next;
    } catch (error) {
      if (currentIndex < 0) this.secrets.delete(secretRef);
      else if (previousSecret !== undefined) this.secrets.put(secretRef, previousSecret);
      throw error;
    }
  }

  remove(provider: string, id: string): void {
    const removed = this.accounts.filter((a) => a.provider === provider && a.id === id);
    const next = this.accounts.filter((a) => !(a.provider === provider && a.id === id));
    this.writeMetadata(next);
    this.accounts = next;
    for (const account of removed) this.secrets.delete(account.secretRef);
  }

  setDefault(provider: string, id: string): void {
    const next = this.accounts.map((account) =>
      account.provider === provider ? { ...account, isDefault: account.id === id } : account,
    );
    this.writeMetadata(next);
    this.accounts = next;
  }

  getDefault(provider: string): OAuthAccount | undefined {
    const account = this.accounts.find((a) => a.provider === provider && a.isDefault);
    return account ? this.hydrate(account) : undefined;
  }

  get(provider: string, id: string): OAuthAccount | undefined {
    const account = this.accounts.find((a) => a.provider === provider && a.id === id);
    return account ? this.hydrate(account) : undefined;
  }

  list(provider?: string): OAuthAccount[] {
    return this.accounts.filter((a) => provider === undefined || a.provider === provider).map((a) => this.hydrate(a));
  }
}
