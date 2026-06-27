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

export class OAuthAccountStore {
  private accounts: OAuthAccount[] = [];

  constructor(private configPath: string) {
    this.load();
  }

  private get filePath(): string {
    const dir = path.dirname(this.configPath);
    return path.join(dir, 'oauth-accounts.json');
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.accounts = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.accounts = JSON.parse(raw);
    } catch {
      this.accounts = [];
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.accounts, null, 2), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // best-effort
      }
    }
  }

  add(acc: OAuthAccount): void {
    const idx = this.accounts.findIndex((a) => a.provider === acc.provider && a.id === acc.id);
    if (idx >= 0) {
      this.accounts[idx] = acc;
    } else {
      this.accounts.push(acc);
    }
    if (acc.isDefault) {
      for (const a of this.accounts) {
        if (a.provider === acc.provider && a.id !== acc.id) {
          a.isDefault = false;
        }
      }
    }
    this.save();
  }

  remove(provider: string, id: string): void {
    this.accounts = this.accounts.filter((a) => !(a.provider === provider && a.id === id));
    this.save();
  }

  setDefault(provider: string, id: string): void {
    for (const a of this.accounts) {
      if (a.provider === provider) {
        a.isDefault = a.id === id;
      }
    }
    this.save();
  }

  getDefault(provider: string): OAuthAccount | undefined {
    return this.accounts.find((a) => a.provider === provider && a.isDefault);
  }

  list(provider?: string): OAuthAccount[] {
    if (!provider) return this.accounts.slice();
    return this.accounts.filter((a) => a.provider === provider);
  }
}
