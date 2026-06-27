export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface DeviceFlowManager {
  start(): Promise<DeviceCodeResponse>;
  poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }>;
  refresh(refreshToken: string): Promise<OAuthTokenResponse>;
}

export class GitHubDeviceFlow implements DeviceFlowManager {
  constructor(private clientId: string, private domain = 'github.com') {}

  async start(): Promise<DeviceCodeResponse> {
    const url = `https://${this.domain}/login/device/code`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: 'read:user' }),
    });
    if (!res.ok) throw new Error(`GitHub device code failed: ${res.status}`);
    return (await res.json()) as DeviceCodeResponse;
  }

  async *poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }> {
    const url = `https://${this.domain}/login/oauth/access_token`;
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data: any = await res.json();
      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        yield { status: 'pending' };
        continue;
      }
      if (data.error) throw new Error(data.error_description ?? data.error);
      yield {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
      };
      return;
    }
    throw new Error('Device code expired');
  }

  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    // GitHub OAuth token typically cannot be refreshed; return the same token until re-login.
    return { access_token: refreshToken };
  }
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEVICE_AUTH_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_AUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';

export class OpenAIDeviceFlow implements DeviceFlowManager {
  constructor(private clientId: string = CODEX_CLIENT_ID) {}

  async start(): Promise<DeviceCodeResponse> {
    const res = await fetch(DEVICE_AUTH_USERCODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    if (!res.ok) throw new Error(`OpenAI device code failed: ${res.status}`);
    const data: any = await res.json();
    const interval = typeof data.interval === 'number' ? data.interval : 5;
    return {
      device_code: data.device_auth_id,
      user_code: data.user_code,
      verification_uri: 'https://auth.openai.com/codex/device',
      expires_in: data.expires_in ?? 900,
      interval: interval + 3,
    };
  }

  async *poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }> {
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await fetch(DEVICE_AUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceCode }),
      });
      if (res.status === 403 || res.status === 404) {
        yield { status: 'pending' };
        continue;
      }
      if (res.status === 410) throw new Error('Device code expired');
      if (!res.ok) throw new Error(`OpenAI device poll failed: ${res.status}`);
      const data: any = await res.json();
      const tokens = await this.exchangeCode(data.authorization_code, data.code_verifier);
      yield tokens;
      return;
    }
    throw new Error('Device code expired');
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: this.clientId,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI token exchange failed: ${res.status}`);
    const data: any = await res.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        scope: 'openid profile email',
      }),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Refresh token invalid');
    if (!res.ok) throw new Error(`OpenAI refresh failed: ${res.status}`);
    const data: any = await res.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_in: data.expires_in,
    };
  }
}
