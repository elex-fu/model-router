import { closeSync, existsSync, lstatSync, openSync, readFileSync, type Stats, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlStore } from '../control/store.js';
import {
  CODEX_OAUTH_REDIRECT_URI,
  type CodexAccountSource,
  type CodexBindingSession,
  type CodexOauthFetch,
  createCodexBindingSession,
} from '../server/codex-account-binding.js';
import { type OAuthAccount, OAuthAccountStore } from '../server/oauth-accounts.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { v2Config } from './v2.js';

/**
 * `model-router codex-account <auth|import|list>` — the classic-mode account
 * authorization UX for Codex OAuth (capability plan task CS2). The binding
 * logic itself lives in src/server/codex-account-binding.ts; this module only
 * resolves the V2 configuration, guards offline writes with the same lock +
 * live-server discipline as the other V2 CLI commands (src/cli/pricing-import.ts),
 * and writes completed accounts through OAuthAccountStore so the CS1 refresh
 * engine keeps them alive. Account writes are not config writes, but they do
 * write the control store's secure secrets, so the offline guard is retained.
 */

export class CodexAccountCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAccountCliError';
  }
}

export interface CodexAccountCliOptions {
  config?: string;
  /** Injectable fetch for the token exchange; defaults to the global fetch. */
  fetch?: CodexOauthFetch;
  /** Injectable source for the pasted authorization code; defaults to stdin. */
  readCodeLine?: () => Promise<string>;
  /** Injectable source for the pasted auth.json content; defaults to stdin. */
  readStdinText?: () => Promise<string>;
  writeLine?: (line: string) => void;
}

const MAX_AUTH_JSON_BYTES = 65_536;
const ACTIONS = ['auth', 'import', 'list'] as const;
export type CodexAccountAction = (typeof ACTIONS)[number];

function lock(configPath: string): () => void {
  const lockPath = `${configPath}.cli.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new CodexAccountCliError('Another V2 CLI write is in progress; retry after it finishes');
  }
  return () => {
    closeSync(descriptor);
    unlinkSync(lockPath);
  };
}

const loopback = (address: string): string =>
  address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;

/**
 * Offline-write guard with the same fail-closed semantics as the other V2 CLI
 * commands: any listener that answers a probe — or a probe that times out,
 * which may be a busy server — refuses the account write. A running server
 * holds the account/secret state in memory and would overwrite it.
 */
async function refuseRunning(config: ConfigV2): Promise<void> {
  const probes = [
    `http://${loopback(config.server.bindAddress)}:${config.server.port}/healthz`,
    ...(config.admin.enabled
      ? [`http://${loopback(config.admin.bindAddress)}:${config.admin.port}/admin/api/v1/bootstrap`]
      : []),
  ];
  for (const url of probes) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400), redirect: 'manual' });
      throw new CodexAccountCliError(
        'A server is responding on the configured port; stop it before writing Codex accounts offline',
      );
    } catch (error) {
      if (error instanceof CodexAccountCliError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new CodexAccountCliError(
          'A server may be responding on the configured port (probe timed out); stop it before writing Codex accounts offline',
        );
    }
  }
}

async function defaultReadCodeLine(): Promise<string> {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of reader) return line;
  } finally {
    reader.close();
  }
  throw new CodexAccountCliError('No authorization code was provided on stdin');
}

async function defaultReadStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) throw new CodexAccountCliError('No auth.json content was provided on stdin');
  return text;
}

function readAuthJsonFile(file: string): string {
  let info: Stats;
  try {
    info = lstatSync(file);
  } catch {
    throw new CodexAccountCliError(`auth.json file not found: ${file}`);
  }
  if (!info.isFile()) throw new CodexAccountCliError(`auth.json is not a regular file: ${file}`);
  if (info.size > MAX_AUTH_JSON_BYTES)
    throw new CodexAccountCliError(`auth.json exceeds the ${MAX_AUTH_JSON_BYTES} byte limit`);
  return readFileSync(file, 'utf8');
}

// --- Caller-side store helper (the binding module stays store-free) ---

export interface RegisterCodexAccountInput {
  readonly codeOrAuthJson: string;
  /** State echoed by the loopback redirect; verified when present. */
  readonly state?: string;
  readonly fetch?: CodexOauthFetch;
}

export interface RegisteredCodexAccount {
  readonly account: OAuthAccount;
  readonly isDefault: boolean;
  readonly source: CodexAccountSource;
}

/**
 * Completes a binding/import through the session and writes the resulting
 * account into the store. The first codex_oauth account becomes the default;
 * later ones are not (the caller can promote via the admin console).
 */
export async function registerCodexAccount(
  store: OAuthAccountStore,
  session: CodexBindingSession,
  input: RegisterCodexAccountInput,
): Promise<RegisteredCodexAccount> {
  const bound = await session.complete({
    codeOrAuthJson: input.codeOrAuthJson,
    state: input.state,
    fetch: input.fetch,
  });
  const isDefault = store.list('codex_oauth').length === 0;
  const account: OAuthAccount = {
    id: bound.id,
    provider: 'codex_oauth',
    ...(bound.login === undefined ? {} : { login: bound.login }),
    accessToken: bound.accessToken,
    refreshToken: bound.refreshToken,
    ...(bound.expiresAt === undefined ? {} : { expiresAt: bound.expiresAt }),
    isDefault,
    ...(bound.status === undefined ? {} : { status: bound.status }),
  };
  store.add(account);
  return { account: store.get('codex_oauth', account.id) ?? account, isDefault, source: bound.source };
}

function reportRegistered(registered: RegisteredCodexAccount, writeLine: (line: string) => void): void {
  const { account } = registered;
  const login = account.login === undefined ? '' : ` (login ${account.login})`;
  const suffix = registered.isDefault ? ' as the default codex_oauth account' : '';
  writeLine(`Stored codex_oauth account ${account.id}${login}${suffix}.`);
  writeLine(
    account.expiresAt === undefined
      ? 'Access token expiry is unknown (no expires_in was recorded).'
      : `Access token expires at ${new Date(account.expiresAt).toISOString()}.`,
  );
  writeLine(`Source: ${registered.source}.`);
}

function listAccounts(store: OAuthAccountStore, writeLine: (line: string) => void): void {
  const accounts = store.list('codex_oauth');
  if (accounts.length === 0) {
    writeLine('No codex_oauth accounts found.');
    return;
  }
  writeLine(`${accounts.length} codex_oauth account(s):`);
  for (const account of accounts) {
    const expires = account.expiresAt === undefined ? '-' : new Date(account.expiresAt).toISOString();
    writeLine(
      `${account.id}\t${account.login ?? '-'}\t${expires}\t${account.status ?? 'active'}\t${account.isDefault ? 'default' : '-'}`,
    );
  }
}

function openStores(configPath: string, config: ConfigV2): { store: ControlStore; accounts: OAuthAccountStore } {
  const store = new ControlStore(resolve(dirname(configPath), config.storage.dataDir));
  return { store, accounts: new OAuthAccountStore(configPath, store.secrets) };
}

/** Command entry point for `model-router codex-account <auth|import|list> [path]`. */
export async function codexAccountCli(
  action: string,
  options: CodexAccountCliOptions = {},
  arg?: string,
): Promise<void> {
  if (!ACTIONS.includes(action as CodexAccountAction))
    throw new CodexAccountCliError('Use codex-account auth, codex-account import, or codex-account list');
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  const configPath = resolve(options.config ?? DEFAULT_CONFIG_PATH);
  if (!existsSync(configPath))
    throw new CodexAccountCliError('Configuration file does not exist; codex-account requires a V2 configuration');
  const config = v2Config({ config: options.config });
  if (!config) throw new CodexAccountCliError('codex-account requires a V2 configuration (schemaVersion 2)');

  if (action === 'list') {
    const { store, accounts } = openStores(configPath, config);
    try {
      listAccounts(accounts, writeLine);
    } finally {
      store.close();
    }
    return;
  }

  const release = lock(configPath);
  let store: ControlStore | undefined;
  try {
    await refuseRunning(config);
    const { store: opened, accounts } = openStores(configPath, config);
    store = opened;
    const session = createCodexBindingSession();
    if (action === 'auth') {
      const start = session.start();
      writeLine('Open this URL in a local browser and approve access:');
      writeLine(start.authorizeUrl.toString());
      writeLine(
        `After approval the browser redirects to ${CODEX_OAUTH_REDIRECT_URI}?code=...&state=... — this CLI does not listen on that port.`,
      );
      writeLine('Copy the code parameter value and paste it below, then press Enter.');
      const readCodeLine = options.readCodeLine ?? defaultReadCodeLine;
      const code = await readCodeLine();
      const registered = await registerCodexAccount(accounts, session, {
        codeOrAuthJson: code,
        fetch: options.fetch,
      });
      reportRegistered(registered, writeLine);
    } else {
      const text =
        arg === undefined || arg === ''
          ? await (options.readStdinText ?? defaultReadStdinText)()
          : readAuthJsonFile(arg);
      const registered = await registerCodexAccount(accounts, session, {
        codeOrAuthJson: text,
        fetch: options.fetch,
      });
      reportRegistered(registered, writeLine);
    }
  } finally {
    store?.close();
    release();
  }
}
