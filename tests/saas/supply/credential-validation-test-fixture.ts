import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createProviderHttpTestAddressCapability } from '../../../src/saas/gateway/provider-http-address.js';
import type { CredentialValidationTransportTestOptions } from '../../../src/saas/supply/credential-validation-http-transport.js';
import { credentialValidationTargetEvidenceSha256 } from '../../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget, ProviderCredentialValidationJobRecord } from '../../../src/saas/supply/types.js';

export function approvedTarget(
  overrides: Partial<Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>> = {},
): ApprovedCredentialValidationTarget {
  const descriptor: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'> = {
    providerId: 'custom', productId: 'custom-openai', credentialType: 'api-key',
    model: 'organisation/model-v1', endpoint: 'chat-completions', capabilityVersion: 1,
    protocol: 'openai-compatible', authProfile: 'openai-bearer-v1',
    baseUrl: 'https://validation.example/v1/', approvalReference: 'operator-review-fixture-v1', expiresAt: null,
    ...overrides,
  };
  return { ...descriptor, evidenceSha256: credentialValidationTargetEvidenceSha256(descriptor) };
}

export function customJob(target: ApprovedCredentialValidationTarget = approvedTarget()): ProviderCredentialValidationJobRecord {
  return {
    id: 'job-custom', tenantId: 'tenant-fixture', accountId: 'account-fixture', credentialId: 'credential-fixture',
    credentialVersion: 1, providerId: target.providerId, productId: target.productId, credentialType: 'api-key',
    allowedModels: [target.model], target: { model: target.model, endpoint: target.endpoint, version: target.capabilityVersion },
    idempotencyKey: 'a'.repeat(64), state: 'failed', attemptCount: 5, availableAt: '2026-09-29T00:00:00.000Z',
    leaseUntil: null, leaseGeneration: 6, lastErrorCode: 'adapter_unsupported',
    completedAt: '2026-09-29T00:01:00.000Z', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z',
  };
}

export function probeEnvelope(kind: 'chat' | 'messages', model = 'organisation/model-v1') {
  return kind === 'chat' ? {
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  } : {
    id: 'msg-fixture', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  };
}

/** Fail promptly if a real operation ends before its expected fixture event. */
export async function waitForValidationFixtureSignal(signal: Promise<void>, operation: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      operation.then(() => { throw new Error('Validation operation ended before the expected fixture event'); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Validation fixture event deadline exceeded')), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ValidationHttpsFixture {
  readonly baseUrl: string;
  readonly server: Server;
  readonly testOptions: CredentialValidationTransportTestOptions;
  readonly certificatePem: string;
}

/** Only local, ephemeral HTTPS and generated fixture keys. No provider credentials or traffic. */
export async function validationHttpsFixture(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<ValidationHttpsFixture> {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
  const directory = await mkdtemp(join(tmpdir(), 'credential-validation-https-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificatePath = join(directory, 'fixture.crt');
  const privateKeyPath = join(directory, 'fixture.key');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-sha256', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
    '-keyout', privateKeyPath, '-out', certificatePath,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(generated.status, 0, 'OpenSSL must generate the local test-only HTTPS certificate');
  const [certificatePem, key] = await Promise.all([readFile(certificatePath, 'utf8'), readFile(privateKeyPath, 'utf8')]);
  const server = createServer({ cert: certificatePem, key }, handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { baseUrl: `https://127.0.0.1:${address.port}/v1/`, server, certificatePem,
    testOptions: { addressCapability: createProviderHttpTestAddressCapability(certificatePem) } };
}
