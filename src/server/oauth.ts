import type { OAuthConfig } from '../config/types.js';
import type { OAuthAccountStore } from './oauth-accounts.js';
import type { OAuthRefreshEngine } from './oauth-refresh.js';

interface TokenEntry {
  accessToken: string;
  expiresAt: number;
}

export class OAuthTokenResolver {
  private cache = new Map<string, TokenEntry>();

  constructor(
    private accountStore?: OAuthAccountStore,
    /**
     * CS1 refresh engine for device_code accounts. When present it owns the
     * account token lifecycle (refresh-before-expiry, backoff, revocation);
     * when absent the legacy behavior below is preserved verbatim so bare
     * resolver construction keeps working.
     */
    private refreshEngine?: OAuthRefreshEngine,
  ) {}

  async resolve(config: OAuthConfig, provider?: 'github_copilot' | 'codex_oauth'): Promise<string> {
    const grantType = config.grantType ?? 'client_credentials';

    if (grantType === 'device_code') {
      if (!provider) {
        throw new Error('provider is required for device_code grant');
      }
      if (!this.accountStore) {
        throw new Error('OAuthAccountStore is required for device_code grant');
      }
      const account = this.accountStore.getDefault(provider);
      if (!account) {
        throw new Error(`No authenticated account for ${provider}`);
      }
      if (this.refreshEngine) {
        return this.refreshEngine.resolveAccessToken(provider);
      }
      if (account.expiresAt && account.expiresAt < Date.now() + 60_000) {
        // refresh if expiring within 60s
        if (account.refreshToken) {
          // Without an engine the refresh grant is unavailable; the account
          // must be re-authenticated through the device flow.
          throw new Error(`Account token for ${provider} expired; re-authentication required`);
        }
      }
      return account.accessToken;
    }

    // client_credentials (default)
    const key = `${config.tokenUrl}:${config.clientId}:${config.scope ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken;
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    if (config.scope) {
      params.set('scope', config.scope);
    }

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`OAuth token request failed: ${res.status}`);
    }

    const data: any = await res.json();
    const accessToken = data.access_token;
    if (typeof accessToken !== 'string') {
      throw new Error('OAuth response missing access_token');
    }

    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.cache.set(key, {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return accessToken;
  }

  /** Clear all cached tokens (useful for testing). */
  clear(): void {
    this.cache.clear();
  }
}
