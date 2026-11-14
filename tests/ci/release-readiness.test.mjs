import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { releaseReadiness, strictC0Artifacts } from '../../scripts/ci/release-readiness.mjs';

const candidate = { sha: 'a'.repeat(40), clean: true };
const artifact = (version) => Buffer.from(JSON.stringify({
  fixtureOnly: true, ok: true, commit: candidate.sha, postgresVersion: `postgres (PostgreSQL) ${version}.1`,
  candidateBefore: { ...candidate, fingerprint: 'f'.repeat(64) }, candidateAfter: { ...candidate, fingerprint: 'f'.repeat(64) },
  suites: ['tests/integration/kimi-commercial-live.test.ts', 'tests/integration/platform-access-cli-workflow-live.test.ts',
    'tests/saas/risk/content-moderation.postgres.integration.test.ts'].map((test) => ({
      test, ok: true, code: 0, counts: { tests: 1, pass: 1, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    })),
}));
const gates = {
  A0: ['realUpstream', 'firstRequest', 'nativeJson', 'nativeSse', 'durableUsage'],
  A1: ['realUpstream', 'realCli', 'twoToolRounds', 'thinking', 'cancellation', 'durableUsage', 'reconnectConsistency'],
  'moderation-auto-ban': ['realGatewayRole', 'keyRevocation', 'authorizationFence', 'operatorProtection', 'atomicRollback'],
};
function manifest() {
  return { schema: 1, candidateSha: candidate.sha, milestone: 'M1', features: { fast: false, codex: false, realtime: false },
    evidence: Object.entries(gates).map(([gate, names]) => ({
      gate, sourceSha: candidate.sha, sourceClean: true, sourceStable: true, result: 'pass',
      finishedAt: '2026-11-12T00:00:00Z', kind: gate.startsWith('A') ? 'live' : 'synthetic',
      postgresMajors: [15, 18], checks: Object.fromEntries(names.map((name) => [name, true])),
      artifacts: [15, 18].map((version) => ({ path: `/synthetic/${version}`, sha256: createHash('sha256').update(artifact(version)).digest('hex') })),
    })) };
}
const validate = (value, source = candidate) => releaseReadiness(value, source, (path) => artifact(Number(path.split('/').at(-1))));

test('C0 reads actual hashed report facts rather than accepting handwritten performance claims', () => {
  const documents = [{ path: '/fixture/r9', data: {
    ok: true, serialProfile: true, requestDiagnostics: { enabled: false }, postgresPreparedStatements: 'off',
    postgresDurability: { fsync: 'on', synchronousCommit: 'on' }, sourceChanged: false, distChanged: false, harnessChanged: false,
    candidateBefore: { ...candidate, fingerprint: 'f'.repeat(64) }, candidateAfter: { ...candidate, fingerprint: 'f'.repeat(64) },
    cleanup: { processesStopped: true, postgresStopped: true, runtimeRemoved: true }, scenes: [{ ok: true, report: '/fixture/bench' }],
  } }, { path: '/fixture/bench', data: {
    tool: 'bench-gateway', violations: [], config: { requests: 100, streamSamples: 100, warmupInflight: 1, instanceCount: 3,
      noFail: false, p99OverheadMs: 30, ttfbOverheadMs: 10 },
    scenarios: { latency: { direct: { n: 100 }, gateway: { n: 100 }, p99OverheadMs: 30 },
      ttfb: { direct: { n: 100 }, gateway: { n: 100 }, gatewayErrors: 0, ttfbOverheadMs: 10 } },
  } }];
  assert.equal(strictC0Artifacts(documents, candidate.sha), true);
  for (const mutate of [
    (d) => { d[1].data.scenarios.latency.p99OverheadMs = 647.73; },
    (d) => { d[1].data.scenarios.ttfb.gatewayErrors = 1; },
    (d) => { d[1].data.config.noFail = true; },
    (d) => { d[0].data.requestDiagnostics.enabled = true; },
    (d) => { d[0].data.candidateBefore.clean = false; },
    (d) => { d[1].path = '/fixture/unrelated'; },
  ]) {
    const broken = structuredClone(documents); mutate(broken);
    assert.equal(strictC0Artifacts(broken, candidate.sha), false);
  }
});

test('release readiness binds exact clean SHA and rejects historic or simulated live evidence', () => {
  assert.equal(validate(manifest()).ok, true);
  assert.equal(validate(manifest(), { ...candidate, clean: false }).ok, false);
  for (const patch of [{ sourceSha: 'b'.repeat(40) }, { sourceClean: false }, { sourceStable: false }, { kind: 'synthetic' }, { result: 'fail' }, { artifacts: [] }]) {
    const value = manifest();
    Object.assign(value.evidence[0], patch);
    assert.equal(validate(value).ok, false);
  }
  const value = manifest();
  value.evidence[0].artifacts[0].sha256 = '0'.repeat(64);
  assert.equal(validate(value).ok, false);
});

test('paid operation and optional features cannot inherit M1 or missing external evidence', () => {
  for (const milestone of ['M2', 'M3']) {
    const value = manifest(); value.milestone = milestone;
    const result = validate(value);
    assert.equal(result.ok, false);
    for (const gate of ['B0', 'B1', 'C0', 'C1', 'C2']) assert.ok(result.errors.some((error) => error.startsWith(`${gate}:`)));
  }
  for (const feature of ['fast', 'codex', 'realtime']) {
    const value = manifest(); value.features[feature] = true;
    assert.equal(validate(value).ok, false);
  }
});

test('valid artifact hashes cannot promote skipped tests or a dirty native runner', () => {
  for (const dirty of [false, true]) {
    const data = JSON.parse(artifact(18).toString());
    if (dirty) data.candidateBefore.clean = false;
    else for (const suite of data.suites) Object.assign(suite.counts, { pass: 0, skipped: 1 });
    const bytes = Buffer.from(JSON.stringify(data));
    const value = manifest();
    value.evidence[0].artifacts = [{ path: '/synthetic/broken', sha256: createHash('sha256').update(bytes).digest('hex') }];
    assert.equal(releaseReadiness(value, candidate, (path) => path.endsWith('broken') ? bytes : artifact(Number(path.split('/').at(-1)))).ok, false);
  }
});

test('C0 retains four complete serial legs, durability, production settings and the original thresholds', () => {
  const value = manifest(); value.features.fast = true;
  const entry = { gate: 'FAST', sourceSha: candidate.sha, sourceClean: true, sourceStable: true, result: 'pass', kind: 'performance',
    finishedAt: '2026-11-12T00:00:00Z', artifacts: value.evidence[0].artifacts,
    checks: Object.fromEntries(['openaiNative', 'anthropicNative', 'zeroRejections', 'stableAcceptance', 'T11', 'T12', 'T13', 'T14'].map((key) => [key, true])),
    performance: { strict: true, serial: true, fsync: 'on', synchronousCommit: 'on', preparedStatements: 'off', p99OverheadMs: 30, ttfbOverheadMs: 10,
      legs: ['direct-latency', 'gateway-latency', 'direct-ttfb', 'gateway-ttfb'].map((name) => ({ name, samples: 100, errors: 0, bodyComplete: true })) } };
  value.evidence.push(entry);
  assert.equal(validate(value).ok, true);
  for (const patch of [{ p99OverheadMs: 722.38 }, { ttfbOverheadMs: 481.1 }, { strict: false }, { fsync: 'off' }, { preparedStatements: 'native' }, { legs: entry.performance.legs.slice(1) }]) {
    const broken = structuredClone(value); Object.assign(broken.evidence.at(-1).performance, patch);
    assert.equal(validate(broken).ok, false);
  }
});
