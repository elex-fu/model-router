import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { PLATFORM_OPERATIONS_SUMMARY_SQL } from '../../dist/saas/platform/operations/summary-service.js';
import { encryptCredential } from '../../src/saas/credentials/crypto.js';
import { createProviderCredentialContext, sealProviderCredential } from '../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase } from '../../src/saas/db/index.js';
import type { SaasDatabase } from '../../src/saas/db/types.js';
import { hashPassword } from '../../src/saas/identity/password.js';
import { generateTotpSecret, totpCode } from '../../src/saas/platform/auth/totp.js';
import { anyRoleConfigured, roleUrls, seedFixture } from '../saas/metering/normal-success-postgres-fixture.js';

export { anyRoleConfigured };

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

export async function artifactDigest(): Promise<string> {
  const digest = createHash('sha256');
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!path.endsWith('.map') && !path.endsWith('.d.ts')) digest.update(path).update(await readFile(path));
    }
  }
  await walk(resolve('dist'));
  await walk(resolve('web/dist'));
  return digest.digest('hex');
}

export async function waitFor<T>(label: string, work: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  do {
    const value = await work();
    if (value !== undefined) return value;
    await delay(100);
  } while (Date.now() < until);
  throw new Error(`Browser fixture timed out: ${label}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

export interface BrowserOperator {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly totp: string;
}

export async function seedBrowserOperator(
  database: SaasDatabase,
  key: Uint8Array,
  role: 'operations' | 'support-readonly',
  userId: string = randomUUID(),
): Promise<BrowserOperator> {
  const email = `browser-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const totp = generateTotpSecret();
  const mfaId = randomUUID();
  const envelope = await encryptCredential(
    totp,
    { userId, provider: 'platform-totp', credentialId: mfaId },
    {
      getCurrentKey: () => ({ keyId: 'browser-fixture-totp', key }),
      getKey: () => key,
    },
  );
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO saas_users(id,email,password_hash) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash`,
      [userId, email, await hashPassword(password)],
    );
    await tx.query('DELETE FROM saas_platform_role_assignments WHERE user_id=$1', [userId]);
    await tx.query('INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,$2)', [userId, role]);
    await tx.query(
      `INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at)
      VALUES($1,$2,'totp',$3,clock_timestamp())`,
      [mfaId, userId, Buffer.from(JSON.stringify(envelope))],
    );
  });
  return { userId, email, password, totp };
}

/** Historical failed Kimi validation receipt only; no worker/provider is started. */
export async function seedBrowserValidationIncident(database: SaasDatabase) {
  const accountId = `browser-retry-account-${randomUUID()}`;
  const credentialId = `browser-retry-credential-${randomUUID()}`;
  const rightsId = `browser-retry-rights-${randomUUID()}`;
  const model = `browser-retry-model-${randomUUID()}`;
  const envelope = await sealProviderCredential(
    randomBytes(32),
    createProviderCredentialContext({
      ownerKind: 'platform',
      supplyMode: 'platform',
      deployment: 'platform-browser-fixture',
      environment: 'test',
      purpose: 'inference',
      providerId: 'kimi',
      productId: 'kimi-code',
      credentialType: 'api-key',
      accountId,
      credentialId,
      credentialVersion: 1,
    }),
    { generateDataKey: async () => ({ plaintextKey: randomBytes(32), ciphertextBlob: randomBytes(48) }) },
    'browser-fixture-not-dispatched',
  );
  const jobId = await database.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO saas_provider_products(provider_id,product_id,display_name) VALUES('kimi','kimi-code','Browser fixture Kimi') ON CONFLICT DO NOTHING",
    );
    await tx.query(
      `INSERT INTO saas_provider_capabilities(provider_id,product_id,model,endpoint,protocol,version,support_level,validation_state,evidence_version,discovery_source,evidence_ref,evidence_sha256)
      VALUES('kimi','kimi-code',$1,'messages','anthropic-compatible',1,'supported','verified','browser-fixture-v1','manual','browser-fixture-evidence',$2)`,
      [model, randomBytes(32).toString('hex')],
    );
    await tx.query(
      `INSERT INTO saas_provider_rights(rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,approval_ref,status,evidence_ref,evidence_sha256)
      VALUES($1,1,'kimi','kimi-code','api-key','platform','test-region','inference',ARRAY[$2]::text[],ARRAY['messages']::text[],clock_timestamp()-interval '1 minute','browser-fixture-approval','active','browser-fixture-evidence',$3)`,
      [rightsId, model, randomBytes(32).toString('hex')],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_accounts(id,display_name,provider_id,product_id,credential_type,region,purpose,rights_id,rights_version)
      VALUES($1,'Browser incident validation account','kimi','kimi-code','api-key','test-region','inference',$2,1)`,
      [accountId, rightsId],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_account_capabilities(account_id,provider_id,product_id,model,endpoint,capability_version) VALUES($1,'kimi','kimi-code',$2,'messages',1)",
      [accountId, model],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_credentials(id,account_id,provider_id,product_id,credential_type) VALUES($1,$2,'kimi','kimi-code','api-key')",
      [credentialId, accountId],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_credential_versions(account_id,credential_id,version,schema_version,context_version,algorithm,kms_purpose,kms_key_id,wrapped_dek,nonce,ciphertext,auth_tag)
      VALUES($1,$2,1,$3,$4,$5,'inference',$6,$7,$8,$9,$10)`,
      [
        accountId,
        credentialId,
        envelope.schemaVersion,
        envelope.contextVersion,
        envelope.algorithm,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await tx.query(
      "UPDATE saas_platform_provider_credentials SET current_version=1,validation_state='failed',validation_error_code='provider_response_too_large' WHERE id=$1",
      [credentialId],
    );
    await tx.query(
      "UPDATE saas_platform_provider_accounts SET validation_state='failed',validation_error_code='provider_response_too_large' WHERE id=$1",
      [accountId],
    );
    const job = (
      await tx.query<{ id: string }>(
        `INSERT INTO saas_platform_provider_credential_validation_jobs(account_id,credential_id,credential_version,provider_id,product_id,credential_type,allowed_models,target_model,target_endpoint,capability_version,idempotency_key)
      VALUES($1,$2,1,'kimi','kimi-code','api-key',ARRAY[$3]::text[],$3,'messages',1,$4) RETURNING id`,
        [accountId, credentialId, model, randomBytes(32).toString('hex')],
      )
    ).rows[0];
    assert.ok(job);
    await tx.query(
      "UPDATE saas_platform_provider_credential_validation_jobs SET status='failed',attempt_count=1,lease_generation=2,last_error_code='provider_response_too_large',completed_at=clock_timestamp() WHERE id=$1",
      [job.id],
    );
    return job.id;
  });
  return { accountId, credentialId, jobId };
}

export async function startPlatformOperationsBrowser() {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const workerUrl = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL;
  assert.ok(workerUrl, 'Run the isolated runner with --worker-role');
  const parsedWorker = new URL(workerUrl);
  const parsedControl = new URL(controlUrl);
  assert.equal(decodeURIComponent(parsedWorker.username), 'model_router_saas_validation_worker');
  assert.equal(`${parsedWorker.host}${parsedWorker.pathname}`, `${parsedControl.host}${parsedControl.pathname}`);
  assert.equal(parsedWorker.search + parsedWorker.hash, '');
  const directory = await mkdtemp(join(tmpdir(), 'model-router-platform-browser-'));
  await chmod(directory, 0o700);
  const database = createSaasDatabase({ connectionString: migratorUrl, max: 3 });
  const control = createSaasDatabase({ connectionString: controlUrl, max: 1 });
  const gateway = createSaasDatabase({ connectionString: gatewayUrl, max: 2 });
  const children: ChildProcess[] = [];
  const captures = new Map<ChildProcess, string>();
  let context: BrowserContext | undefined;
  const key = randomBytes(32);
  const before = await artifactDigest();
  const start = (binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn(binary, args, { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    captures.set(child, '');
    const capture = (chunk: Buffer) =>
      captures.set(child, (captures.get(child) + chunk.toString('utf8')).slice(0, 32_768));
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    return child;
  };
  async function close() {
    const results = await Promise.allSettled([context?.close(), ...children.map(stop)]);
    await Promise.allSettled([database.close(), control.close(), gateway.close()]);
    key.fill(0);
    let after: string;
    try {
      after = await artifactDigest();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    assert.ok(
      results.every((result) => result.status === 'fulfilled'),
      'Every owned browser/CLI/Redis resource closed',
    );
    assert.equal(after, before, 'Current dist and web/dist artifacts must stay unchanged during browser acceptance');
    assert.ok(
      children.every((child) => child.exitCode !== null || child.signalCode !== null),
      'Every owned CLI/Redis child stopped',
    );
  }
  let stage = 'seed';
  try {
    await database.verifySchema();
    const seed = await seedFixture(database, gateway, 'platform');
    const operator = await seedBrowserOperator(database, key, 'operations', seed.userId);
    const account = (
      await database.query<{ account_id: string; credential_id: string; credential_version: string }>(
        'SELECT account_id,credential_id,credential_version FROM saas_attempts WHERE tenant_id=$1 AND id=$2',
        [seed.tenantId, seed.input.attemptId],
      )
    ).rows[0];
    assert.ok(account, 'Synthetic accepted task must have its original account binding');
    const taskId = `browser-video-${randomUUID()}`;
    await gateway.query(
      `INSERT INTO saas_video_tasks(request_id,tenant_id,proxy_key_id,provider_account_id,credential_id,credential_version,
      gateway_request_id,gateway_attempt_id,model,resolution,duration_seconds,video_count,billing_state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'browser-fixture-model','720p',1,1,'pending',clock_timestamp()+interval '1 day')`,
      [
        taskId,
        seed.tenantId,
        seed.keyId,
        account.account_id,
        account.credential_id,
        String(account.credential_version),
        seed.input.requestId,
        seed.input.attemptId,
      ],
    );
    await gateway.query(
      "UPDATE saas_video_tasks SET poll_failures=5,next_poll_at=clock_timestamp()-interval '2 minutes' WHERE request_id=$1",
      [taskId],
    );
    const modulePath = join(directory, 'fixture-totp-provider.mjs');
    // Standard external provider contract, real envelope crypto and loader probe.
    // This fixture-only local key is not a production KMS readiness claim.
    await writeFile(
      modulePath,
      `export async function createCredentialKeyProvider({env,purpose}) {
      if(purpose!=='platform-totp') throw new Error('fixture purpose mismatch');
      const key=Buffer.from(env.PLATFORM_BROWSER_TOTP_KEY,'hex');
      if(key.length!==32) throw new Error('fixture key unavailable');
      let closed=false; const ready=()=>{if(closed)throw new Error('fixture closed')};
      return {getCurrentKey(){ready();return {keyId:'browser-fixture-totp',key:new Uint8Array(key)}},
        getKey(id){ready();return id==='browser-fixture-totp'?new Uint8Array(key):undefined},
        async checkReady(){ready()},async close(){closed=true;key.fill(0)}};
    }`,
      { mode: 0o600 },
    );
    const platformPort = await freePort();
    const customerPort = await freePort();
    const redisPort = await freePort();
    const origin = `http://127.0.0.1:${platformPort}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'test',
      MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
      MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'control-plane',
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'platform-browser-fixture',
      MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: controlUrl,
      MODEL_ROUTER_SAAS_KMS_PROVIDER: modulePath,
      PLATFORM_BROWSER_TOTP_KEY: key.toString('hex'),
      MODEL_ROUTER_SAAS_REDIS_PROVIDER: resolve('dist/saas/runtime/redis-rate-limit-provider.js'),
      MODEL_ROUTER_SAAS_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS: '127.0.0.1',
      MODEL_ROUTER_SAAS_PLATFORM_PORT: String(platformPort),
      MODEL_ROUTER_SAAS_PLATFORM_ORIGIN: origin,
      MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS: '127.0.0.1',
      MODEL_ROUTER_SAAS_CUSTOMER_PORT: String(customerPort),
      MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN: `http://127.0.0.1:${customerPort}`,
    };
    stage = 'redis-start';
    const redisBinary = '/opt/homebrew/bin/redis-server';
    await access(redisBinary);
    const redis = start(
      redisBinary,
      ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', directory],
      { PATH: process.env.PATH },
    );
    await waitFor('owned Redis listener', async () => {
      if (redis.exitCode !== null) throw new Error('Owned Redis exited');
      return captures.get(redis)?.includes('Ready to accept connections') ? true : undefined;
    });
    stage = 'standard-control-plane-cli-start';
    const cli = start(process.execPath, [resolve('dist/cli/index.js'), 'start', '--role', 'control-plane'], env);
    await waitFor('standard control-plane CLI listener', async () => {
      if (cli.exitCode !== null || cli.signalCode !== null) {
        const text = captures.get(cli) ?? '';
        const codes = [...new Set(text.match(/\b(?:[A-Z][A-Z_]{5,80}|42[0-9A-Z]{3}|55000|23514)\b/g) ?? [])];
        throw new Error(
          `Control-plane CLI exited: ${JSON.stringify({
            codes,
            text: text
              .replace(/[a-f0-9]{64}/g, '[digest]')
              .replace(/postgres(?:ql)?:\/\/\S+/g, '[database]')
              .slice(-4_000),
          })}`,
        );
      }
      try {
        const response = await fetch(`${origin}/admin/api/v1/auth/session`, { signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        return response.status === 401 ? true : undefined;
      } catch {
        return undefined;
      }
    });
    stage = 'headless-browser-start';
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1440, height: 1100 },
    });
    context.setDefaultTimeout(10_000);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      directory,
      database,
      gateway,
      page,
      context,
      origin,
      seed,
      taskId,
      account,
      operator,
      key,
      artifactDigest: before,
      close,
      async diagnoseSummary() {
        const to = new Date();
        const from = new Date(to.getTime() - 86_400_000);
        try {
          const result = await control.query<Record<string, unknown>>(PLATFORM_OPERATIONS_SUMMARY_SQL, [
            from.toISOString(),
            to.toISOString(),
          ]);
          const row = result.rows[0];
          return {
            sqlstate: null,
            rowCount: result.rows.length,
            fields: row
              ? {
                  webhookPendingType: typeof row.webhook_pending_count,
                  webhookProcessingType: typeof row.webhook_processing_count,
                  oldestAgeNull: row.webhook_oldest_unprocessed_age_ms === null,
                }
              : null,
          };
        } catch (error) {
          const code =
            error !== null && typeof error === 'object'
              ? Object.getOwnPropertyDescriptor(error, 'code')?.value
              : undefined;
          return {
            sqlstate:
              typeof code === 'string' && ['42803', '42501', '42703', '42P01', '42883', '42601'].includes(code)
                ? code
                : 'UNCLASSIFIED',
          };
        }
      },
      async login(page: Page, identity: BrowserOperator) {
        await page.goto(`${origin}/admin/platform/ops`);
        await page.getByLabel('管理员邮箱').fill(identity.email);
        await page.getByLabel('密码', { exact: true }).fill(identity.password);
        await page.getByLabel(/^MFA 验证码/).fill(totpCode(identity.totp));
        const response = page.waitForResponse(
          (value) => value.url().endsWith('/auth/session') && value.request().method() === 'POST',
        );
        await page.getByRole('button', { name: '登录', exact: true }).click();
        assert.equal((await response).status(), 200, 'Actual platform MFA login must succeed');
      },
    };
  } catch (error) {
    await close();
    if (error instanceof Error) throw new Error(`platform-browser harness stage=${stage}: ${error.message}`);
    throw new Error(`platform-browser harness stage=${stage}`);
  }
}
