import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountIdentityNamespace,
  buildCanonicalIdentity,
  CODEX_BASELINE_VERSION,
  CODEX_DEFAULT_ORIGINATOR,
  CODEX_MIN_VERSION,
  deriveStableUUIDv4,
  isolateSessionId,
  resolveFingerprintIds,
  semverGte,
} from '../../../../src/saas/gateway/codex/identity.js';

test('semverGte compares numerically across all three components', () => {
  assert.equal(semverGte('0.146.0', CODEX_MIN_VERSION), true);
  assert.equal(semverGte('0.144.0', CODEX_MIN_VERSION), true);
  assert.equal(semverGte('0.143.9', CODEX_MIN_VERSION), false);
  assert.equal(semverGte('1.0.0', '0.999.999'), true);
  assert.equal(semverGte('0.9.0', '0.10.0'), false);
  assert.equal(semverGte('0.146.1', '0.146.0'), true);
  assert.equal(semverGte('0.146.0', '0.146.1'), false);
});

test('semverGte treats prereleases as older than their release and malformed input as less', () => {
  assert.equal(semverGte('0.146.0-rc.1', '0.146.0'), false);
  assert.equal(semverGte('0.146.0', '0.146.0-rc.1'), true);
  assert.equal(semverGte('0.146.0-rc.1', '0.145.0'), true);
  assert.equal(semverGte('not-a-version', CODEX_MIN_VERSION), false);
  assert.equal(semverGte('', CODEX_MIN_VERSION), false);
});

test('buildCanonicalIdentity returns a self-consistent default trio', () => {
  const identity = buildCanonicalIdentity();
  assert.equal(identity.originator, CODEX_DEFAULT_ORIGINATOR);
  assert.equal(identity.version, CODEX_BASELINE_VERSION);
  assert.equal(
    identity.userAgent,
    `${CODEX_DEFAULT_ORIGINATOR}/${CODEX_BASELINE_VERSION} (Mac OS X 10.15.7; arm64) Apple_Terminal`,
  );
  assert.match(identity.userAgent, /^codex_cli_rs\/0\.146\.0 \([^)]+; [^)]+\) .+$/);
});

test('buildCanonicalIdentity honors a valid version override but never emits below the minimum', () => {
  assert.deepEqual(buildCanonicalIdentity('0.150.2'), {
    ...buildCanonicalIdentity(),
    version: '0.150.2',
    userAgent: 'codex_cli_rs/0.150.2 (Mac OS X 10.15.7; arm64) Apple_Terminal',
  });
  // Below the minimum the upstream answers 404, so the override is discarded.
  assert.equal(buildCanonicalIdentity('0.100.0').version, CODEX_BASELINE_VERSION);
  assert.equal(buildCanonicalIdentity('garbage').version, CODEX_BASELINE_VERSION);
  assert.equal(buildCanonicalIdentity('').version, CODEX_BASELINE_VERSION);
});

test('buildCanonicalIdentity supports a custom terminal profile', () => {
  const identity = buildCanonicalIdentity('0.146.0', {
    os: 'Windows',
    osVersion: '11.0.0',
    arch: 'x86_64',
    terminal: 'WindowsTerminal',
  });
  assert.equal(identity.userAgent, 'codex_cli_rs/0.146.0 (Windows 11.0.0; x86_64) WindowsTerminal');
});

test('accountIdentityNamespace builds the chatgpt account namespace and rejects malformed accounts', () => {
  assert.equal(
    accountIdentityNamespace({ chatgptAccountId: 'acct-1', chatgptUserId: 'user-9' }),
    'chatgpt:acct-1:user:user-9',
  );
  assert.throws(() => accountIdentityNamespace({ chatgptAccountId: '', chatgptUserId: 'user-9' }));
  assert.throws(() => accountIdentityNamespace({ chatgptAccountId: 'acct-1', chatgptUserId: '' }));
});

test('isolateSessionId is deterministic and isolates key and account namespaces', () => {
  const first = isolateSessionId('key-1', 'chatgpt:acct-1:user:user-9', 'client-session-abc');
  const again = isolateSessionId('key-1', 'chatgpt:acct-1:user:user-9', 'client-session-abc');
  assert.equal(first, again);
  assert.match(first, /^[0-9a-f]{8}$/);

  // Different proxy key on the same account → different session id.
  assert.notEqual(first, isolateSessionId('key-2', 'chatgpt:acct-1:user:user-9', 'client-session-abc'));
  // Same key on a different account (the failover case) → different session id.
  assert.notEqual(first, isolateSessionId('key-1', 'chatgpt:acct-2:user:user-9', 'client-session-abc'));
  // Different raw client session → different session id.
  assert.notEqual(first, isolateSessionId('key-1', 'chatgpt:acct-1:user:user-9', 'client-session-xyz'));
  assert.throws(() => isolateSessionId('', 'ns', 'raw'));
  assert.throws(() => isolateSessionId('key', '', 'raw'));
});

test('deriveStableUUIDv4 is deterministic and forces the UUIDv4 version/variant bits', () => {
  const uuid = deriveStableUUIDv4('mr:codex-install-id:v1:seed-a');
  assert.equal(uuid, deriveStableUUIDv4('mr:codex-install-id:v1:seed-a'));
  assert.notEqual(uuid, deriveStableUUIDv4('mr:codex-install-id:v1:seed-b'));
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => deriveStableUUIDv4(''));
});

test('resolveFingerprintIds mode off passes client identifiers through untouched', () => {
  assert.deepEqual(
    resolveFingerprintIds({ mode: 'off', seed: '', clientSessionId: 'client-1', adminDeviceId: 'admin-device-1' }),
    { installationId: 'admin-device-1', sessionId: 'client-1', threadId: 'client-1' },
  );
  assert.deepEqual(resolveFingerprintIds({ mode: 'off', seed: '', clientSessionId: null }), {
    installationId: null,
    sessionId: null,
    threadId: null,
  });
});

test('resolveFingerprintIds mode device converges only the installation id', () => {
  const resolved = resolveFingerprintIds({ mode: 'device', seed: 'seed-a', clientSessionId: 'client-1' });
  assert.equal(resolved.installationId, deriveStableUUIDv4('mr:codex-install-id:v1:seed-a'));
  assert.equal(resolved.sessionId, 'client-1');
  assert.equal(resolved.threadId, 'client-1');
});

test('resolveFingerprintIds mode session derives the thread id from the client session id', () => {
  const resolved = resolveFingerprintIds({ mode: 'session', seed: 'seed-a', clientSessionId: 'client-1' });
  assert.equal(resolved.installationId, deriveStableUUIDv4('mr:codex-install-id:v1:seed-a'));
  assert.equal(resolved.sessionId, 'client-1');
  assert.equal(resolved.threadId, deriveStableUUIDv4('mr:codex-thread-id:v1:seed-a:client-1'));
  // Same seed, different client session → different thread, same installation.
  const other = resolveFingerprintIds({ mode: 'session', seed: 'seed-a', clientSessionId: 'client-2' });
  assert.notEqual(resolved.threadId, other.threadId);
  assert.equal(resolved.installationId, other.installationId);
});

test('resolveFingerprintIds mode full converges all three ids on the seed alone', () => {
  const resolved = resolveFingerprintIds({ mode: 'full', seed: 'seed-a', clientSessionId: 'client-1' });
  assert.deepEqual(resolved, {
    installationId: deriveStableUUIDv4('mr:codex-install-id:v1:seed-a'),
    sessionId: deriveStableUUIDv4('mr:codex-session-id:v1:seed-a'),
    threadId: deriveStableUUIDv4('mr:codex-thread-id:v1:seed-a'),
  });
  // Client session id is irrelevant in full mode.
  assert.deepEqual(resolved, resolveFingerprintIds({ mode: 'full', seed: 'seed-a', clientSessionId: 'client-2' }));
  // Different seed → entirely different identity.
  const other = resolveFingerprintIds({ mode: 'full', seed: 'seed-b', clientSessionId: 'client-1' });
  assert.notEqual(resolved.installationId, other.installationId);
  assert.notEqual(resolved.sessionId, other.sessionId);
  assert.notEqual(resolved.threadId, other.threadId);
});

test('resolveFingerprintIds requires a seed in converging modes and rejects unknown modes', () => {
  assert.throws(() => resolveFingerprintIds({ mode: 'device', seed: '', clientSessionId: 'client-1' }));
  assert.throws(() => resolveFingerprintIds({ mode: 'session', seed: '', clientSessionId: 'client-1' }));
  assert.throws(() => resolveFingerprintIds({ mode: 'full', seed: '', clientSessionId: 'client-1' }));
  assert.throws(() => resolveFingerprintIds({ mode: 'unknown' as 'off', seed: 'seed-a', clientSessionId: 'client-1' }));
});
