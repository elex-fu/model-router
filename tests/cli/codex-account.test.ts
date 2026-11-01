import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { codexAccountCli } from '../../src/cli/codex-account.js';
import { type ConfigV2, defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import type { CodexOauthFetch } from '../../src/server/codex-account-binding.js';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';
import { unusedLoopbackPorts } from './loopback-ports.js';

const exec = promisify(execFile);

async function cli(configPath: string, args: string[]) {
  try {
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args, '--config', configPath],
      {
        cwd: process.cwd(),
      },
    );
    return { code: 0, ...result };
  } catch (error: any) {
    return { code: error.code as number, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** Same stdin-fed subprocess harness as tests/cli/v2-management.test.ts. */
function cliWithStdin(configPath: string, input: string, ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args, '--config', configPath], {
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fixture() {
  const ports = await unusedLoopbackPorts();
  const dir = mkdtempSync(join(tmpdir(), 'mr-codex-account-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'codex-account-cli-test');
  config.server.port = ports.server;
  config.server.publicProxyBaseUrl = `http://127.0.0.1:${ports.server}`;
  config.admin.port = ports.admin;
  config.admin.publicAdminBaseUrl = `http://127.0.0.1:${ports.admin}`;
  config.storage.dataDir = dir;
  writeFileSync(configPath, JSON.stringify(config));
  return {
    dir,
    configPath,
    read: () => JSON.parse(readFileSync(configPath, 'utf8')) as ConfigV2,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function chatgptClaims(accountId: string, email: string): Record<string, unknown> {
  return {
    email,
    exp: Math.floor((Date.now() + 600_000) / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_user_id: 'user-456',
      plan_type: 'chatgptplus',
    },
  };
}

/** Codex CLI ~/.codex/auth.json shape (account_id inside the tokens object). */
function authJson(accountId: string, email: string): string {
  return JSON.stringify(
    {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeIdToken(chatgptClaims(accountId, email)),
        // JWT-shaped so the import path's expiry decode exercises (the real
        // Codex CLI auth.json carries a JWT access token; refresh keeps it alive).
        access_token: makeIdToken({ exp: Math.floor((Date.now() + 3_600_000) / 1000) }),
        refresh_token: `codex-refresh-${accountId}`,
        account_id: accountId,
      },
      last_refresh: '2026-10-30T00:00:00.000Z',
    },
    null,
    2,
  );
}

const AUTHORIZATION_CODE = 'authorization-code_value-0123456789abcdef';

function tokenEndpointStub(idToken: string): { fetch: CodexOauthFetch; body: string } {
  const body = JSON.stringify({
    access_token: 'codex-access-exchanged',
    refresh_token: 'codex-refresh-exchanged',
    id_token: idToken,
    expires_in: 1800,
  });
  return { fetch: () => Promise.resolve(new Response(body, { status: 200 })), body };
}

test('codex-account import reads a file and list shows the account (subprocess)', async () => {
  const f = await fixture();
  try {
    const source = join(f.dir, 'auth.json');
    writeFileSync(source, authJson('acct-imp-1', 'importer@example.com'));
    const imported = await cli(f.configPath, ['codex-account', 'import', source]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /Stored codex_oauth account acct-imp-1/);
    assert.match(imported.stdout, /login importer@example\.com/);
    assert.match(imported.stdout, /default codex_oauth account/);
    assert.match(imported.stdout, /Source: auth-json-import/);
    // The access token's JWT exp is decoded into the account expiry so the
    // CS1 refresh engine's margin logic covers imported accounts.
    {
      const ctl = new ControlStore(f.dir);
      try {
        const accounts = new OAuthAccountStore(f.configPath, ctl.secrets);
        const imp = accounts.get('codex_oauth', 'acct-imp-1');
        assert.ok(imp?.expiresAt !== undefined && imp.expiresAt > Date.now());
      } finally {
        ctl.close();
      }
    }
    // Credentials are sealed in the control store, never in account metadata.
    const metadata = readFileSync(join(f.dir, 'oauth-accounts.json'), 'utf8');
    assert.match(metadata, /secretRef/);
    assert.equal(metadata.includes('codex-access-acct-imp-1'), false);
    assert.equal(metadata.includes('codex-refresh-acct-imp-1'), false);
    const control = new ControlStore(f.dir);
    try {
      const accounts = new OAuthAccountStore(f.configPath, control.secrets);
      const stored = accounts.get('codex_oauth', 'acct-imp-1');
      assert.ok(stored?.accessToken.startsWith('eyJ') === false || stored.accessToken.split('.').length === 3);
      assert.equal(stored?.refreshToken, 'codex-refresh-acct-imp-1');
      assert.equal(stored?.isDefault, true);
      assert.equal(stored?.status, 'active');
    } finally {
      control.close();
    }
    const listed = await cli(f.configPath, ['codex-account', 'list']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /1 codex_oauth account/);
    assert.match(listed.stdout, /acct-imp-1\s+importer@example\.com\s+\S*\s+active\s+default/);
  } finally {
    f.close();
  }
});

test('codex-account list reports an empty store (subprocess)', async () => {
  const f = await fixture();
  try {
    const listed = await cli(f.configPath, ['codex-account', 'list']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /No codex_oauth accounts found/);
  } finally {
    f.close();
  }
});

test('codex-account import rejects invalid auth.json (subprocess)', async () => {
  const f = await fixture();
  try {
    const source = join(f.dir, 'auth.json');
    writeFileSync(source, JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'b' } }));
    const failed = await cli(f.configPath, ['codex-account', 'import', source]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /auth\.json payload is invalid/);
    assert.equal(existsSync(join(f.dir, 'oauth-accounts.json')), false);
  } finally {
    f.close();
  }
});

test('codex-account auth rejects a malformed pasted code before any network call (subprocess)', async () => {
  const f = await fixture();
  try {
    const failed = await cliWithStdin(f.configPath, 'too-short\n', 'codex-account', 'auth');
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /auth\.openai\.com\/oauth\/authorize\?/);
    assert.match(failed.stderr, /authorization code is invalid/);
    assert.equal(existsSync(join(f.dir, 'oauth-accounts.json')), false);
  } finally {
    f.close();
  }
});

test('codex-account auth completes the PKCE flow with an injected exchange fetch (in-process)', async () => {
  const f = await fixture();
  try {
    const idToken = makeIdToken(chatgptClaims('acct-auth-1', 'authorizer@example.com'));
    const { fetch } = tokenEndpointStub(idToken);
    const lines: string[] = [];
    await codexAccountCli('auth', {
      config: f.configPath,
      fetch,
      readCodeLine: () => Promise.resolve(AUTHORIZATION_CODE),
      writeLine: (line) => lines.push(line),
    });
    const urlLine = lines.find((line) => line.startsWith('https://auth.openai.com/oauth/authorize?'));
    assert.ok(urlLine);
    const url = new URL(urlLine);
    assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.match(lines.join('\n'), /localhost:1455\/auth\/callback\?code=\.\.\.&state=\.\.\./);
    assert.match(lines.join('\n'), /Stored codex_oauth account acct-auth-1/);
    assert.match(lines.join('\n'), /Source: oauth-binding/);
    assert.match(lines.join('\n'), /expires at \d{4}-\d{2}-\d{2}T/);
    const control = new ControlStore(f.dir);
    try {
      const accounts = new OAuthAccountStore(f.configPath, control.secrets);
      const stored = accounts.get('codex_oauth', 'acct-auth-1');
      assert.equal(stored?.accessToken, 'codex-access-exchanged');
      assert.equal(stored?.refreshToken, 'codex-refresh-exchanged');
      assert.equal(stored?.login, 'authorizer@example.com');
      assert.equal(stored?.isDefault, true);
      assert.ok(stored?.expiresAt !== undefined && stored.expiresAt > Date.now());
    } finally {
      control.close();
    }
  } finally {
    f.close();
  }
});

test('a second imported account is not the default and list shows both (in-process)', async () => {
  const f = await fixture();
  try {
    const first: string[] = [];
    await codexAccountCli('import', {
      config: f.configPath,
      readStdinText: () => Promise.resolve(authJson('acct-multi-1', 'first@example.com')),
      writeLine: (line) => first.push(line),
    });
    assert.match(first.join('\n'), /as the default codex_oauth account/);
    const second: string[] = [];
    await codexAccountCli('import', {
      config: f.configPath,
      readStdinText: () => Promise.resolve(authJson('acct-multi-2', 'second@example.com')),
      writeLine: (line) => second.push(line),
    });
    assert.doesNotMatch(second.join('\n'), /as the default/);
    const listed: string[] = [];
    await codexAccountCli('list', {
      config: f.configPath,
      writeLine: (line) => listed.push(line),
    });
    const output = listed.join('\n');
    assert.match(output, /2 codex_oauth account/);
    assert.match(output, /acct-multi-1\s+first@example\.com\s+\S*\s+active\s+default/);
    assert.match(output, /acct-multi-2\s+second@example\.com\s+\S*\s+active\s+-/);
  } finally {
    f.close();
  }
});

test('codex-account writes refuse a running server (in-process)', async () => {
  const f = await fixture();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ok');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = f.read();
    config.server.port = address.port;
    writeFileSync(f.configPath, JSON.stringify(config));
    await assert.rejects(
      codexAccountCli('import', {
        config: f.configPath,
        readStdinText: () => Promise.resolve(authJson('acct-blocked', 'blocked@example.com')),
      }),
      /server is responding/,
    );
    // list is read-only and still works while the server holds the port.
    const listed: string[] = [];
    await codexAccountCli('list', { config: f.configPath, writeLine: (line) => listed.push(line) });
    assert.match(listed.join('\n'), /No codex_oauth accounts found/);
  } finally {
    server.close();
    f.close();
  }
});
