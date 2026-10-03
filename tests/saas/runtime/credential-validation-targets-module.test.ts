import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import {
  CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE,
  CredentialValidationTargetsModuleError,
  type CredentialValidationTargetsFactoryOptions,
  type CredentialValidationTargetsModuleLoaderOptions,
  loadCredentialValidationTargetsModule,
  MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
} from '../../../src/saas/runtime/credential-validation-targets-module.js';
import type { ProviderEnvironment } from '../../../src/saas/runtime/providers.js';
import {
  compileApprovedCredentialValidationTargets,
  credentialValidationTargetEvidenceSha256,
  credentialValidationTargetRequestUrl,
  isApprovedCredentialValidationTargets,
  resolveApprovedCredentialValidationTarget,
} from '../../../src/saas/supply/credential-validation-targets.js';
import type {
  ApprovedCredentialValidationTarget,
  ProviderCredentialValidationJobRecord,
} from '../../../src/saas/supply/types.js';

const MODULE = 'trusted-fixture-validation-targets';
const SECRET = 'fake-target-module-secret-never-public';
const HOST = 'reviewed-target.example.test';
const DIAGNOSTIC = `${SECRET}:https://operator:${SECRET}@${HOST}/private-target-config.mjs?key=${SECRET}`;
const NOW = Date.parse('2026-10-01T00:00:00.000Z');

function target(
  overrides: Partial<Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>> = {},
): ApprovedCredentialValidationTarget {
  const descriptor: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'> = {
    providerId: 'custom',
    productId: 'custom-openai',
    credentialType: 'api-key',
    model: 'reviewed-org/model-v1:variant',
    endpoint: 'chat-completions',
    capabilityVersion: 1,
    protocol: 'openai-compatible',
    authProfile: 'openai-bearer-v1',
    baseUrl: `https://${HOST}:8443/api/v1/`,
    approvalReference: 'operator-review:fixture-001',
    expiresAt: null,
    ...overrides,
  };
  return { ...descriptor, evidenceSha256: credentialValidationTargetEvidenceSha256(descriptor) };
}

/** Pure consumer-lookup fixture; it is never an input to the module or factory. */
function consumerJob(descriptor: ApprovedCredentialValidationTarget): ProviderCredentialValidationJobRecord {
  return {
    id: 'lookup-fixture-job', tenantId: 'lookup-fixture-tenant', accountId: 'lookup-fixture-account',
    credentialId: 'lookup-fixture-credential', credentialVersion: 1,
    providerId: descriptor.providerId, productId: descriptor.productId, credentialType: descriptor.credentialType,
    allowedModels: [descriptor.model],
    target: { model: descriptor.model, endpoint: descriptor.endpoint, version: descriptor.capabilityVersion },
    idempotencyKey: 'a'.repeat(64), state: 'failed', attemptCount: 1,
    availableAt: '2026-10-01T00:00:00.000Z', leaseUntil: null, leaseGeneration: 1,
    lastErrorCode: 'adapter_unsupported', completedAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function loadFactory(
  factory: (options: CredentialValidationTargetsFactoryOptions) => unknown,
  overrides: CredentialValidationTargetsModuleLoaderOptions = {},
) {
  return loadCredentialValidationTargetsModule({
    env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: MODULE },
    now: () => NOW,
    importer: () => ({ createCredentialValidationTargets: factory }),
    ...overrides,
  });
}

function loadTargets(raw: unknown) {
  return loadFactory(() => raw);
}

async function assertSafeError(
  action: () => Promise<unknown>,
  code: CredentialValidationTargetsModuleError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof CredentialValidationTargetsModuleError, 'failure must use the public loader error');
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    const publicView = [String(error), error.stack, JSON.stringify(error), inspect(error)].join('\n');
    for (const privateValue of [SECRET, HOST, MODULE, 'private-target-config.mjs']) {
      assert.equal(publicView.includes(privateValue), false, 'failure must discard untrusted diagnostics');
    }
    return true;
  });
}

test('missing own setting disables custom targets without import, clock, or another target/KMS source', async () => {
  const environments: ProviderEnvironment[] = [
    {},
    { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: undefined },
    {
      SAAS_PROVIDER_TARGET_BINDINGS_MODULE: 'not-a-validation-target-source',
      SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: 'not-a-target-source',
      MODEL_ROUTER_SAAS_KMS_PROVIDER: 'not-a-target-source',
      MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: 'not-a-target-source',
    },
    Object.create({ [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: MODULE }) as ProviderEnvironment,
  ];
  for (const env of environments) {
    let imports = 0;
    let clockReads = 0;
    const loaded = await loadCredentialValidationTargetsModule({
      env,
      importer: () => { imports += 1; throw new Error(DIAGNOSTIC); },
      now: () => { clockReads += 1; throw new Error(DIAGNOSTIC); },
    });
    assert.equal(loaded, undefined);
    assert.equal(imports, 0);
    assert.equal(clockReads, 0);
    const empty = compileApprovedCredentialValidationTargets(loaded ?? []);
    assert.equal(resolveApprovedCredentialValidationTarget(empty, consumerJob(target()), NOW), null);
  }
});

test('explicit empty metadata is frozen and remains custom-unavailable, not an invented approval', async () => {
  const loaded = await loadTargets([]);
  assert.ok(loaded);
  assert.equal(loaded.length, 0);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(isApprovedCredentialValidationTargets(loaded), false);
  const registry = compileApprovedCredentialValidationTargets(loaded);
  assert.equal(resolveApprovedCredentialValidationTarget(registry, consumerJob(target()), NOW), null);
});

test('reads only the dedicated setting and gives the exact frozen metadata-only purpose to its named factory', async () => {
  let secretReads = 0;
  let imports = 0;
  let factories = 0;
  const env: Record<string, string | undefined> = {
    [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: MODULE,
  };
  for (const key of [
    'MODEL_ROUTER_SAAS_DATABASE_URL', 'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL',
    'MODEL_ROUTER_SAAS_REDIS_URL', 'MODEL_ROUTER_SAAS_KMS_PROVIDER',
    'SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE',
    'KIMI_API_KEY', 'UPSTREAM_API_KEY', 'HTTP_PROXY', 'TENANT_TARGET_URL',
  ]) {
    Object.defineProperty(env, key, {
      enumerable: true,
      get() { secretReads += 1; throw new Error(DIAGNOSTIC); },
    });
  }
  const loaded = await loadCredentialValidationTargetsModule({
    env,
    now: () => NOW,
    importer: (specifier) => {
      imports += 1;
      assert.equal(specifier, MODULE);
      const module = {
        createCredentialValidationTargets(options: CredentialValidationTargetsFactoryOptions) {
          factories += 1;
          assert.equal(this, module);
          assert.deepEqual(Reflect.ownKeys(options), ['purpose']);
          assert.equal(options.purpose, CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE);
          assert.equal(Object.isFrozen(options), true);
          for (const key of ['env', 'database', 'kms', 'job', 'tenant', 'headers', 'fetch', 'lifecycle']) {
            assert.equal(Object.hasOwn(options, key), false);
          }
          assert.equal(Reflect.set(options, 'purpose', 'tenant-supplied'), false);
          return [target()];
        },
      };
      Object.defineProperty(module, 'createCredentialValidationWorkerUnsealingKms', {
        get() { throw new Error(DIAGNOSTIC); },
      });
      return module;
    },
  });
  assert.ok(loaded);
  assert.equal(imports, 1);
  assert.equal(factories, 1);
  assert.equal(secretReads, 0);
});

test('uses the existing trusted package/path/file resolution and compatibility importer spelling', async (t) => {
  for (const [raw, expected] of [
    ['@trusted-fixture/validation-targets', '@trusted-fixture/validation-targets'],
    ['/operator fixture/targets.mjs', 'file:///operator%20fixture/targets.mjs'],
    ['./targets.mjs', 'file:///operator-fixture/targets.mjs'],
    ['../targets.mjs', 'file:///targets.mjs'],
    ['file:///operator-fixture/targets.mjs', 'file:///operator-fixture/targets.mjs'],
  ] as const) {
    await t.test(raw, async () => {
      let imports = 0;
      const loaded = await loadCredentialValidationTargetsModule({
        env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: raw },
        cwd: '/operator-fixture',
        now: () => NOW,
        importModule: (specifier) => {
          imports += 1;
          assert.equal(specifier, expected);
          return { createCredentialValidationTargets: () => [target()] };
        },
      });
      assert.equal(loaded?.length, 1);
      assert.equal(imports, 1);
    });
  }
});

test('malformed explicit settings fail before any import and never become a missing/default target source', async () => {
  for (const raw of [
    '', ' ', ' trusted-fixture', 'trusted-fixture ', null, 1,
    'x'.repeat(4097), `trusted\u0000${SECRET}`, 'trusted\nmodule',
    `https://${HOST}/private-target-config.mjs?key=${SECRET}`, 'node:fs', 'data:text/javascript,export{}',
    'file://remote-fixture.example/targets.mjs', 'file:///operator-fixture/targets.mjs?override=1',
    'file:///operator-fixture/targets.mjs#override',
  ]) {
    let imports = 0;
    await assertSafeError(() => loadCredentialValidationTargetsModule({
      env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: raw } as never,
      importer: () => { imports += 1; return {}; },
    }), 'INVALID_MODULE_SPECIFIER');
    assert.equal(imports, 0);
  }
});

test('invalid loader controls and configuration accessors are redacted before import', async () => {
  const badOptions = [
    null, [], 1, { env: null }, { env: [] }, { importer: 1 }, { importModule: true },
    { now: 1 }, { cwd: '' }, { cwd: 1 }, { cwd: 'x'.repeat(4097) }, { cwd: `x\u0000${SECRET}` },
    { env: {}, job: { target: DIAGNOSTIC } }, { env: {}, fetch: () => undefined },
    { env: {}, [Symbol('private-fixture')]: SECRET },
    Object.defineProperty({}, 'env', { get() { throw new Error(DIAGNOSTIC); } }),
    new Proxy({}, { ownKeys() { throw new Error(DIAGNOSTIC); } }),
  ];
  for (const options of badOptions) {
    await assertSafeError(() => loadCredentialValidationTargetsModule(options as never), 'INVALID_CONFIGURATION');
  }
  for (const env of [
    Object.defineProperty({}, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE, {
      get() { throw new Error(DIAGNOSTIC); },
    }),
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(DIAGNOSTIC); } }),
  ]) {
    await assertSafeError(() => loadCredentialValidationTargetsModule({ env }), 'INVALID_CONFIGURATION');
  }
});

test('import and factory errors discard raw secrets, bodies, URLs and causes without retry or fallback', async () => {
  let imports = 0;
  let factories = 0;
  await assertSafeError(() => loadFactory(() => {
    factories += 1;
    return [target()];
  }, {
    importer: () => { imports += 1; throw Object.assign(new Error(DIAGNOSTIC), { body: SECRET, cause: SECRET }); },
    importModule: () => { throw new Error('must not retry via a secondary importer'); },
  }), 'MODULE_LOAD_FAILED');
  assert.equal(imports, 1);
  assert.equal(factories, 0);

  const revokedArray = Proxy.revocable([target()], {});
  revokedArray.revoke();
  for (const factory of [
    () => { throw Object.assign(new Error(DIAGNOSTIC), { body: SECRET, cause: SECRET }); },
    async () => { throw new Error(DIAGNOSTIC); },
    () => Object.defineProperty({}, 'then', { get() { throw new Error(DIAGNOSTIC); } }),
    // Await reads the result's `then` before metadata validation. A revoked
    // top-level array therefore rejects factory-result assimilation here.
    () => revokedArray.proxy,
    () => { throw Object.assign(new CredentialValidationTargetsModuleError('TARGETS_INVALID'), { message: DIAGNOSTIC }); },
  ]) {
    let calls = 0;
    let clockReads = 0;
    await assertSafeError(() => loadFactory(() => { calls += 1; return factory(); }, {
      now: () => { clockReads += 1; return NOW; },
    }), 'FACTORY_FAILED');
    assert.equal(calls, 1);
    assert.equal(clockReads, 0);
  }
});

test('only an own named callable factory is accepted; no default, KMS, static binding, inherited, or accessor fallback', async () => {
  for (const module of [
    null, undefined, [], 'not-a-module', 1, () => undefined, {},
    { default: { createCredentialValidationTargets: () => [target()] } },
    { createCredentialValidationWorkerUnsealingKms: () => [target()] },
    { providerTargetBindings: [target()] },
    { createCredentialValidationTargets: [target()] },
    Object.create({ createCredentialValidationTargets: () => [target()] }),
    Object.defineProperty({}, 'createCredentialValidationTargets', { get() { throw new Error(DIAGNOSTIC); } }),
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(DIAGNOSTIC); } }),
  ]) {
    await assertSafeError(() => loadFactory(() => [target()], { importer: () => module }), 'MODULE_EXPORT_INVALID');
  }
});

test('factory must return a bounded dense metadata array, never a registry, callback or runtime handle', async () => {
  for (const raw of [
    undefined, null, false, 1, 'not-metadata', target(), { targets: [target()] }, () => [target()],
    compileApprovedCredentialValidationTargets([target()]),
    { bindings: [target()], fetch: () => undefined, close: () => undefined },
    [null], [false], [SECRET], [() => undefined], new Array(1), new Array(1025).fill(target()),
    Object.assign([target()], { headers: { Authorization: SECRET } }),
    Object.assign([target()], { [Symbol('private-fixture')]: SECRET }),
    Object.defineProperty([target()], '0', { get() { throw new Error(DIAGNOSTIC); } }),
    new Proxy([target()], { ownKeys() { throw new Error(DIAGNOSTIC); } }),
  ]) {
    await assertSafeError(() => loadTargets(raw), 'TARGETS_INVALID');
  }
});

test('retains the compiler target-count bound and rejects oversized aggregate metadata', async () => {
  const maximum = Array.from({ length: 1024 }, (_, index) => target({ model: `reviewed-org/model-${index}` }));
  const loaded = await loadTargets(maximum);
  assert.equal(loaded?.length, 1024);
  assert.equal(Object.isFrozen(loaded), true);
  const oversized = Object.fromEntries(Object.keys(target()).map((key) => [key,
    key === 'capabilityVersion' ? 1 : key === 'expiresAt' ? null : 'x'.repeat(4096),
  ]));
  await assertSafeError(() => loadTargets(new Array(1024).fill(oversized)), 'TARGETS_INVALID');
});

test('requires every canonical descriptor field, rejects hidden/symbol/extra metadata and unsafe value types', async () => {
  const approved = target();
  for (const key of Object.keys(approved)) {
    const missing: Record<string, unknown> = { ...approved };
    delete missing[key];
    await assertSafeError(() => loadTargets([missing]), 'TARGETS_INVALID');
  }
  for (const extra of [
    { headers: { Authorization: SECRET } }, { fetch: () => undefined }, { tenantId: 'tenant-fixture' },
    { job: { target: DIAGNOSTIC } }, { database: {} }, { approved: true },
    { capabilityCatalogEvidence: approved.evidenceSha256 }, { requestUrl: DIAGNOSTIC },
  ]) {
    await assertSafeError(() => loadTargets([{ ...approved, ...extra }]), 'TARGETS_INVALID');
  }
  for (const raw of [
    { ...approved, model: { toString() { throw new Error(DIAGNOSTIC); } } },
    { ...approved, model: () => DIAGNOSTIC }, { ...approved, capabilityVersion: 1n },
    { ...approved, approvalReference: 'x'.repeat(4097) }, { ...approved, baseUrl: 'x'.repeat(4097) },
    Object.defineProperty({ ...approved }, 'headers', { value: SECRET, enumerable: false }),
    Object.defineProperty({ ...approved }, 'model', { value: approved.model, enumerable: false }),
    { ...approved, [Symbol('private-fixture')]: SECRET },
    Object.assign(Object.create({ inherited: SECRET }), approved),
  ]) {
    await assertSafeError(() => loadTargets([raw]), 'TARGETS_INVALID');
  }
});

test('descriptor and array getters/proxies cannot supply changing authority or leak their errors', async () => {
  let reads = 0;
  const changing = Object.defineProperty({ ...target() }, 'baseUrl', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? target().baseUrl : DIAGNOSTIC; },
  });
  await assertSafeError(() => loadTargets([changing]), 'TARGETS_INVALID');
  assert.equal(reads, 0, 'descriptor accessors must be rejected without invoking them');
  for (const raw of [
    Object.defineProperty({ ...target() }, 'evidenceSha256', { get() { throw new Error(DIAGNOSTIC); } }),
    new Proxy(target(), { getPrototypeOf() { throw new Error(DIAGNOSTIC); } }),
    new Proxy(target(), { ownKeys() { throw new Error(DIAGNOSTIC); } }),
    new Proxy(target(), { getOwnPropertyDescriptor() { throw new Error(DIAGNOSTIC); } }),
  ]) {
    await assertSafeError(() => loadTargets([raw]), 'TARGETS_INVALID');
  }
  // An ordinary outer array survives await assimilation, so the revoked
  // descriptor is rejected specifically while copying metadata, not earlier.
  const revoked = Proxy.revocable(target(), {});
  revoked.revoke();
  await assertSafeError(() => loadTargets([revoked.proxy]), 'TARGETS_INVALID');
});

test('canonical HTTPS and fixed protocol/auth profiles remain owned by the existing compiler', async () => {
  const approved = target();
  for (const changes of [
    { providerId: 'kimi' }, { productId: 'tenant-product' }, { credentialType: 'oauth' },
    { model: 'https://private-fixture/model' }, { model: 'model with space' }, { model: 'x'.repeat(257) },
    { endpoint: 'tenant-route' }, { capabilityVersion: 0 }, { capabilityVersion: Number.MAX_SAFE_INTEGER + 1 },
    { protocol: 'tenant-protocol' }, { authProfile: 'custom-header' }, { productId: 'custom-anthropic' },
    { baseUrl: `http://${HOST}/api/` }, { baseUrl: `https://operator:${SECRET}@${HOST}/api/` },
    { baseUrl: `https://${HOST}/api/?key=${SECRET}` }, { baseUrl: `https://${HOST}/api/#fragment` },
    { baseUrl: `https://${HOST.toUpperCase()}/api/` }, { baseUrl: `https://${HOST}/api` },
    { baseUrl: `https://${HOST}:0/api/` }, { baseUrl: `https://${HOST}/../api/` },
    { baseUrl: `https://${HOST}/%2fapi/` }, { approvalReference: 'x'.repeat(257) },
    { expiresAt: '2027-01-01' }, { expiresAt: '2027-01-01T00:00:00.000+00:00' },
  ]) {
    await assertSafeError(() => loadTargets([{ ...approved, ...changes }]), 'TARGETS_INVALID');
  }
});

test('checks complete reviewed evidence without manufacturing/repairing its digest or accepting approval flags', async () => {
  const approved = target();
  for (const changes of [
    { model: 'another-org/model' }, { capabilityVersion: 2 },
    { baseUrl: 'https://another-fixture.example.test/api/' }, { approvalReference: 'different-review' },
    { expiresAt: new Date(NOW + 60_000).toISOString() },
    { evidenceSha256: '' }, { evidenceSha256: 'f'.repeat(64) },
    { evidenceSha256: `A${approved.evidenceSha256.slice(1)}` },
  ]) {
    await assertSafeError(() => loadTargets([{ ...approved, ...changes }]), 'TARGETS_INVALID');
  }
  await assertSafeError(() => loadTargets([{
    ...approved, productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible',
    authProfile: 'anthropic-api-key-2023-06-01',
  }]), 'TARGETS_INVALID');
});

test('duplicate tuple/version bindings are rejected even if both distinct descriptors have valid review digests', async () => {
  const first = target();
  const conflicting = target({ baseUrl: 'https://another-fixture.example.test/api/', approvalReference: 'another-review' });
  await assertSafeError(() => loadTargets([first, first]), 'TARGETS_INVALID');
  await assertSafeError(() => loadTargets([first, conflicting]), 'TARGETS_INVALID');
});

test('expired or exact-deadline metadata rejects the whole load; expiry is checked after the awaited factory', async () => {
  for (const expiry of [NOW - 1, NOW]) {
    await assertSafeError(() => loadTargets([target(), target({
      model: 'another-org/model', expiresAt: new Date(expiry).toISOString(),
    })]), 'TARGETS_INVALID');
  }
  let current = NOW;
  const expiring = target({ expiresAt: new Date(NOW + 1).toISOString() });
  await assertSafeError(() => loadFactory(async () => {
    await Promise.resolve();
    current = NOW + 1;
    return [expiring];
  }, { now: () => current }), 'TARGETS_INVALID');

  const loaded = await loadTargets([expiring]);
  assert.ok(loaded);
  const registry = compileApprovedCredentialValidationTargets(loaded);
  assert.ok(resolveApprovedCredentialValidationTarget(registry, consumerJob(expiring), NOW));
  assert.equal(resolveApprovedCredentialValidationTarget(registry, consumerJob(expiring), NOW + 1), null,
    'startup load must not promote metadata past the compiler/resolver runtime expiry gate');
});

test('a broken trusted expiry clock is sanitized and never converted into unlimited approval', async () => {
  for (const now of [
    () => NaN, () => Infinity, () => -Infinity, () => NOW + 0.5, () => 8_640_000_000_000_001,
    () => { throw new Error(DIAGNOSTIC); },
    (() => `${SECRET}`) as never,
  ]) {
    await assertSafeError(() => loadFactory(() => [target()], { now }), 'INVALID_CONFIGURATION');
  }
});

test('captures loading controls before await and copies/freezes metadata without freezing caller input', async () => {
  const original = target();
  const raw = [original];
  const originalSnapshot = { ...original };
  const options: {
    env: Record<string, string>;
    importer: NonNullable<CredentialValidationTargetsModuleLoaderOptions['importer']>;
    now: () => number;
  } = {
    env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: MODULE },
    importer: async () => {
      options.env[MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE] = 'must-not-reload';
      options.now = () => { throw new Error(DIAGNOSTIC); };
      options.importer = () => { throw new Error(DIAGNOSTIC); };
      return { createCredentialValidationTargets: () => raw };
    },
    now: () => NOW,
  };
  const loaded = await loadCredentialValidationTargetsModule(options);
  assert.ok(loaded);
  assert.notEqual(loaded, raw);
  assert.notEqual(loaded[0], original);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded[0]), true);
  assert.deepEqual({ ...loaded[0] }, originalSnapshot);
  const mutable = original as { baseUrl: string; model: string; evidenceSha256: string };
  mutable.baseUrl = 'https://unreviewed-fixture.example.test/';
  mutable.model = 'unreviewed/model';
  mutable.evidenceSha256 = '0'.repeat(64);
  raw.length = 0;
  assert.deepEqual({ ...loaded[0] }, originalSnapshot);
  assert.equal(Reflect.set(loaded[0]!, 'baseUrl', mutable.baseUrl), false);
  assert.equal(Reflect.set(loaded, '0', original), false);
});

test('both compiler-supported profiles retain exact request paths; slash models never interpolate into URLs', async () => {
  const chat = target();
  const messages = target({
    productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible',
    authProfile: 'anthropic-api-key-2023-06-01', baseUrl: `https://${HOST}:8443/anthropic/v1/`,
  });
  const loaded = await loadTargets([chat, messages]);
  assert.ok(loaded);
  const registry = compileApprovedCredentialValidationTargets(loaded);
  for (const [descriptor, path] of [[chat, '/api/v1/chat/completions'], [messages, '/anthropic/v1/messages']] as const) {
    const binding = resolveApprovedCredentialValidationTarget(registry, consumerJob(descriptor), NOW);
    assert.ok(binding);
    const url = credentialValidationTargetRequestUrl(binding);
    assert.equal(url.pathname, path);
    assert.equal(url.href.includes(descriptor.model), false);
    assert.equal(binding.model, descriptor.model);
    assert.equal(binding.evidenceSha256, descriptor.evidenceSha256);
  }
});

test('the default importer accepts the own named factory from a real ESM namespace', async () => {
  // A .ts test self-import in this CommonJS package can be transpiled into
  // accessor/default interop exports. Use actual .mjs files instead, without
  // changing package settings or substituting a test importer. Only these
  // freshly owned disposable fixture files are created and removed by the test.
  const directory = await mkdtemp(join(tmpdir(), 'model-router-validation-targets-esm-'));
  try {
    const expected = target();
    const factorySource = `
const metadata = ${JSON.stringify([expected])};
function createCredentialValidationTargets(options) {
  if (!options || Reflect.ownKeys(options).length !== 1 ||
      options.purpose !== ${JSON.stringify(CREDENTIAL_VALIDATION_TARGETS_FACTORY_PURPOSE)} ||
      !Object.isFrozen(options)) {
    throw new Error('Invalid metadata-only fixture options');
  }
  return metadata;
}
`;
    const namedPath = join(directory, 'named-targets.mjs');
    const defaultOnlyPath = join(directory, 'default-only-targets.mjs');
    const writeOptions = { encoding: 'utf8', flag: 'wx', mode: 0o600 } as const;
    // The factories contain static fake metadata only: no imports, environment,
    // credentials, network access, resource acquisition or catalog approval.
    await writeFile(namedPath, `${factorySource}\nexport { createCredentialValidationTargets };\n`, writeOptions);
    await writeFile(defaultOnlyPath, `${factorySource}\nexport default { createCredentialValidationTargets };\n`, writeOptions);

    const namedUrl = pathToFileURL(namedPath).href;
    const namespace = await import(namedUrl);
    assert.equal(Object.getPrototypeOf(namespace), null);
    assert.equal(Object.prototype.toString.call(namespace), '[object Module]');
    assert.equal(Object.hasOwn(namespace, 'default'), false);
    const factoryDescriptor = Object.getOwnPropertyDescriptor(namespace, 'createCredentialValidationTargets');
    assert.ok(factoryDescriptor);
    assert.equal(Object.hasOwn(factoryDescriptor, 'value'), true);
    assert.equal(typeof factoryDescriptor.value, 'function');
    assert.equal(factoryDescriptor.get, undefined);
    assert.equal(factoryDescriptor.set, undefined);

    const loaded = await loadCredentialValidationTargetsModule({
      env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: namedUrl },
      now: () => NOW,
    });
    assert.ok(loaded);
    assert.deepEqual({ ...loaded[0] }, expected);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded[0]), true);

    const defaultOnlyUrl = pathToFileURL(defaultOnlyPath).href;
    const defaultOnlyNamespace = await import(defaultOnlyUrl);
    assert.equal(Object.getPrototypeOf(defaultOnlyNamespace), null);
    assert.equal(Object.hasOwn(defaultOnlyNamespace, 'createCredentialValidationTargets'), false);
    assert.equal(typeof defaultOnlyNamespace.default.createCredentialValidationTargets, 'function');
    await assertSafeError(() => loadCredentialValidationTargetsModule({
      env: { [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: defaultOnlyUrl },
      now: () => NOW,
    }), 'MODULE_EXPORT_INVALID');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
