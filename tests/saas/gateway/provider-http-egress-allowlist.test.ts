import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  createProviderHttpEgressAllowlist,
  createProviderHttpTestAddressCapability,
  ProviderHttpAddressPolicyError,
  ProviderHttpEgressAllowlistError,
  ProviderHttpEgressProxyError,
  resolveEgressProxyTarget,
  selectPinnedProviderAddress,
} from '../../../src/saas/gateway/provider-http-address.js';
import {
  PROVIDER_EGRESS_ALLOWLIST_ENV_VAR,
  parseProviderEgressAllowlistSettings,
} from '../../../src/saas/gateway/provider-http-egress-allowlist.js';
import {
  type ProviderHttpFetch,
  type ProviderHttpPinnedConnectorFactory,
  ProviderHttpTransport,
  ProviderHttpTransportError,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  CredentialValidationHttpTransport,
  CredentialValidationTransportError,
} from '../../../src/saas/supply/credential-validation-http-transport.js';
import {
  compileApprovedCredentialValidationTargets,
  resolveApprovedCredentialValidationTarget,
} from '../../../src/saas/supply/credential-validation-targets.js';
import { approvedTarget, customJob } from '../supply/credential-validation-test-fixture.js';

const payload = new Uint8Array([0, 1, 2, 255, 10, 13]);
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const TEST_DISPATCHER = {} as Dispatcher;
const CONTAINER_NETWORK_ADDRESS = Object.freeze({ address: '172.20.1.5', family: 4 as const });

test('the default posture is unchanged: no allowlist and an empty allowlist behave identically', () => {
  const emptyAllowlist = createProviderHttpEgressAllowlist([]);
  assert.deepEqual(emptyAllowlist.entries, []);
  for (const address of [
    '172.20.1.5',
    '10.0.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '127.0.0.1',
    '::1',
    'fd00::1',
    '::ffff:8.8.8.8',
  ]) {
    assert.equal(emptyAllowlist.allows(address), false, address);
    assert.throws(
      () => selectPinnedProviderAddress(address, [], undefined, emptyAllowlist),
      ProviderHttpAddressPolicyError,
      address,
    );
    assert.throws(() => selectPinnedProviderAddress(address, []), ProviderHttpAddressPolicyError, address);
  }
  for (const allowlist of [undefined, emptyAllowlist]) {
    assert.deepEqual(selectPinnedProviderAddress('8.8.8.8', [], undefined, allowlist), {
      address: '8.8.8.8',
      family: 4,
    });
    assert.deepEqual(
      selectPinnedProviderAddress('provider.example', [{ address: '8.8.8.8', family: 4 }], undefined, allowlist),
      { address: '8.8.8.8', family: 4 },
    );
  }
});

test('valid CIDR entries permit otherwise-denied addresses, including explicit loopback and link-local opt-ins', () => {
  const allowlist = createProviderHttpEgressAllowlist(['172.16.0.0/12', 'FD00::/8']);
  assert.deepEqual(allowlist.entries, ['172.16.0.0/12', 'fd00::/8']);
  // Named host resolving into the allowed container range.
  assert.deepEqual(
    selectPinnedProviderAddress('provider.internal', [CONTAINER_NETWORK_ADDRESS], undefined, allowlist),
    { address: '172.20.1.5', family: 4 },
  );
  // Literal host inside an entry.
  assert.deepEqual(selectPinnedProviderAddress('172.31.255.254', [], undefined, allowlist), {
    address: '172.31.255.254',
    family: 4,
  });
  // IPv6 private range entry.
  assert.deepEqual(
    selectPinnedProviderAddress('provider.internal', [{ address: 'fd12:3456::1', family: 6 }], undefined, allowlist),
    { address: 'fd12:3456::1', family: 6 },
  );
  // Mixed answers stay valid when every answer is global or allowlisted.
  assert.deepEqual(
    selectPinnedProviderAddress(
      'provider.internal',
      [CONTAINER_NETWORK_ADDRESS, { address: '8.8.8.8', family: 4 }],
      undefined,
      allowlist,
    ),
    { address: '172.20.1.5', family: 4 },
  );
  // Loopback and link-local require the same explicit opt-in as any other range.
  const loopbackAllowlist = createProviderHttpEgressAllowlist(['127.0.0.0/8', '169.254.0.0/16']);
  assert.deepEqual(selectPinnedProviderAddress('127.0.0.1', [], undefined, loopbackAllowlist), {
    address: '127.0.0.1',
    family: 4,
  });
  assert.deepEqual(
    selectPinnedProviderAddress(
      'metadata.internal',
      [{ address: '169.254.169.254', family: 4 }],
      undefined,
      loopbackAllowlist,
    ),
    { address: '169.254.169.254', family: 4 },
  );
});

test('malformed CIDR entries are rejected at load (fail-closed)', () => {
  const malformed = [
    'not-a-cidr',
    '10.0.0.0',
    '10.0.0.0/8/9',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    '10.0.0.0/x',
    '10.1.2.3/8', // non-canonical: host bits set
    'fd00::1/8', // non-canonical: host bits set
    '10.0.0.0/0', // covers everything — not a narrow escape hatch
    '::/0',
    'fd00::/129',
    '10.0.0.0 /8',
    '',
  ];
  for (const entry of malformed) {
    assert.throws(() => createProviderHttpEgressAllowlist([entry]), ProviderHttpEgressAllowlistError, entry);
  }
  assert.throws(() => createProviderHttpEgressAllowlist(['10.0.0.0/8', 'oops']));
  assert.throws(() => createProviderHttpEgressAllowlist(['10.0.0.0/8', '10.0.0.0/8']));
  assert.throws(() => createProviderHttpEgressAllowlist([42]), ProviderHttpEgressAllowlistError);
  assert.throws(() => createProviderHttpEgressAllowlist('10.0.0.0/8' as unknown as string[]));
  assert.throws(
    () => createProviderHttpEgressAllowlist(Array.from({ length: 33 }, () => '10.0.0.0/8')),
    ProviderHttpEgressAllowlistError,
  );

  // The environment grammar fails closed the same way.
  assert.deepEqual(parseProviderEgressAllowlistSettings({}).entries, []);
  assert.deepEqual(parseProviderEgressAllowlistSettings({ [PROVIDER_EGRESS_ALLOWLIST_ENV_VAR]: '' }).entries, []);
  assert.deepEqual(
    parseProviderEgressAllowlistSettings({ [PROVIDER_EGRESS_ALLOWLIST_ENV_VAR]: '10.0.0.0/8, 172.16.0.0/12' }).entries,
    ['10.0.0.0/8', '172.16.0.0/12'],
  );
  for (const value of ['10.0.0.0/8,,172.16.0.0/12', '10.0.0.0/8,', ',10.0.0.0/8', 'bogus', '10.1.2.3/8']) {
    assert.throws(
      () => parseProviderEgressAllowlistSettings({ [PROVIDER_EGRESS_ALLOWLIST_ENV_VAR]: value }),
      ProviderHttpEgressAllowlistError,
      value,
    );
  }
});

test('deny still wins outside the configured entries', () => {
  const allowlist = createProviderHttpEgressAllowlist(['10.0.0.0/8']);
  for (const address of [
    '172.20.1.5',
    '192.168.1.1',
    '169.254.169.254',
    '127.0.0.1', // no implicit loopback carve-out
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1', // v4-mapped does not leak into the v4 entry
  ]) {
    assert.equal(allowlist.allows(address), false, address);
    assert.throws(
      () => selectPinnedProviderAddress(address, [], undefined, allowlist),
      ProviderHttpAddressPolicyError,
      address,
    );
  }
  // A mixed answer with one non-covered denied address rejects the whole set.
  assert.throws(() =>
    selectPinnedProviderAddress(
      'provider.internal',
      [
        { address: '10.0.0.5', family: 4 },
        { address: '192.168.0.1', family: 4 },
      ],
      undefined,
      allowlist,
    ),
  );
  assert.equal(allowlist.allows('provider.example'), false);
});

test('the transport dispatches to an allowlisted container-network address and still fails closed without the entry', async () => {
  const evidence = (): PreparedRequestEvidenceRecord =>
    ({
      evidenceId: 'evidence-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      publicModel: 'model-1',
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      upstreamId: 'upstream-1',
      accountId: 'account-1',
      credentialId: 'credential-1',
      credentialVersion: '7',
      routeTargetMode: 'tenant_account',
      payloadSha256,
      statementSha256: 'b'.repeat(64),
      status: 'claimed',
      claimedAt: '2026-09-28T00:00:00.000Z',
      claimedAttemptId: 'attempt-1',
      expiresAt: '2026-09-28T00:10:00.000Z',
    }) as PreparedRequestEvidenceRecord;
  const request = (): PreparedEvidenceTransportRequest => ({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes: payload,
    evidence: evidence(),
  });
  let fetchCalls = 0;
  let connectorAddress = '';
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 202 });
  };
  const connectorFactory: ProviderHttpPinnedConnectorFactory = ({ address }) => {
    connectorAddress = address;
    return { dispatcher: TEST_DISPATCHER, close: async () => {}, destroy: async () => {} };
  };
  const baseOptions = {
    fetch: fakeFetch,
    timeoutMs: 500,
    endpointPolicy: { allowedHosts: ['provider.internal'], allowedPorts: [443] },
    resolveAddresses: async () => [CONTAINER_NETWORK_ADDRESS],
    createConnector: connectorFactory,
    resolveDispatchProfile: async () => ({ url: 'https://provider.internal:443/v1/dispatch' }),
    resolveCredential: async (_input: unknown, useCredential: (c: { headerName: string; value: string }) => unknown) =>
      useCredential({ headerName: 'authorization', value: 'Bearer transient' }),
  } as const;

  const result = await new ProviderHttpTransport({
    ...baseOptions,
    egressAllowlist: createProviderHttpEgressAllowlist(['172.20.0.0/16']),
  }).send(request());
  assert.equal(result.resultHttpStatus, 202);
  assert.equal(fetchCalls, 1);
  assert.equal(connectorAddress, '172.20.1.5');

  fetchCalls = 0;
  await assert.rejects(
    new ProviderHttpTransport({
      ...baseOptions,
      egressAllowlist: createProviderHttpEgressAllowlist(['10.0.0.0/8']),
    }).send(request()),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
  );
  await assert.rejects(
    new ProviderHttpTransport({ ...baseOptions }).send(request()),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
  );
  assert.equal(fetchCalls, 0);

  assert.throws(
    () => new ProviderHttpTransport({ ...baseOptions, egressAllowlist: {} }),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('egress proxy targets honor the same operator allowlist', async () => {
  const resolveAddresses = async () => [{ address: '172.18.0.9', family: 4 as const }];
  const proxy = { url: 'http://egress-proxy.internal:8080' };
  const target = await resolveEgressProxyTarget(proxy, {
    resolveAddresses,
    egressAllowlist: createProviderHttpEgressAllowlist(['172.16.0.0/12']),
  });
  assert.equal(target.address, '172.18.0.9');
  assert.equal(target.family, 4);
  await assert.rejects(
    resolveEgressProxyTarget(proxy, { resolveAddresses }),
    (error: unknown) => error instanceof ProviderHttpEgressProxyError,
  );
});

test('credential validation probes consult the same operator allowlist', async (t) => {
  // The test address capability requires the test-runner environment the
  // shared validation fixture sets up (local HTTPS fixtures do the same).
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
  const target = approvedTarget({ baseUrl: 'https://provider.internal/v1/' });
  const resolved = resolveApprovedCredentialValidationTarget(
    compileApprovedCredentialValidationTargets([target]),
    customJob(target),
  );
  assert.ok(resolved);
  const testOptions = {
    addressCapability: createProviderHttpTestAddressCapability(
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
    ),
    resolveAddresses: async () => [CONTAINER_NETWORK_ADDRESS],
  };
  const rejectedWith = async (transport: CredentialValidationHttpTransport): Promise<void> => {
    await assert.rejects(
      transport.prepare(resolved),
      (error: unknown) =>
        error instanceof CredentialValidationTransportError && error.code === 'provider_address_rejected',
    );
  };

  // Allowlisted container-network provider: the probe plan pins the address.
  const allowed = new CredentialValidationHttpTransport(
    testOptions,
    createProviderHttpEgressAllowlist(['172.20.0.0/16']),
  );
  const plan = await allowed.prepare(resolved);
  await allowed.release(plan);
  await allowed.close();

  // An allowlist without the entry keeps the address denied.
  const notCovered = new CredentialValidationHttpTransport(
    testOptions,
    createProviderHttpEgressAllowlist(['10.0.0.0/8']),
  );
  await rejectedWith(notCovered);
  await notCovered.close();

  // Default posture (no allowlist) is byte-identical strict behavior.
  const strict = new CredentialValidationHttpTransport(testOptions);
  await rejectedWith(strict);
  await strict.close();

  // A malformed allowlist fails transport construction closed.
  assert.throws(
    () => new CredentialValidationHttpTransport(testOptions, {} as never),
    (error: unknown) => error instanceof TypeError,
  );
});
