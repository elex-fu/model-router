import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');
const path = '.github/workflows/fast-gateway-required.yml';
const workflow = read(path);
const nativeScenarioMatrix = `\${{ matrix.native-scenario }}`;
const journal = 'tests/saas/gateway/fast/journal.postgres.integration.test.ts';
const resolution = 'tests/saas/gateway/fast/resolution.postgres.integration.test.ts';
const journalCommand = `node --import tsx --test --test-concurrency=1 ${journal} ${resolution}`;
const redis = 'tests/saas/gateway/fast/redis-admission.local.integration.test.ts';
const native = 'tests/saas/gateway/fast/native-http.postgres.integration.test.ts';
const runtime = 'tests/saas/gateway/fast/native-http-runtime-fixture.ts';
const seed = 'tests/saas/gateway/fast/native-http-seed-fixture.ts';
const provision = 'bash tests/saas/db/managed-postgres-runtime-privileges.integration.sh';
const strictRoots = [
  'executor.test.ts',
  'journal.test.ts',
  'journal.postgres.integration.test.ts',
  'journal-crash-child.ts',
  'redis-admission.test.ts',
  'redis-admission.local.integration.test.ts',
  'redis-snapshot-store.test.ts',
  'postgres-snapshot-loader.test.ts',
  'runtime-snapshot.test.ts',
  'snapshots.test.ts',
  'terminal-gate.test.ts',
  'ticket-transport.test.ts',
  'resolution.postgres.integration.test.ts',
  'resolution-http.test.ts',
  'native-http-runtime-fixture.ts',
  'native-http-seed-fixture.ts',
  'native-http.postgres.integration.test.ts',
].map((name) => `tests/saas/gateway/fast/${name}`);
const roleEnv = {
  NODE_ENV: 'test',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL:
    'postgresql://model_router_saas_migrator@postgres:5432/model_router_saas_ci',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL:
    'postgresql://model_router_saas_control_plane@postgres:5432/model_router_saas_ci',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL:
    'postgresql://model_router_saas_gateway@postgres:5432/model_router_saas_ci',
};
function steps(source: string) {
  return source
    .split(/^ {6}- /m)
    .slice(1)
    .map((block) => {
      const env: Record<string, string> = {};
      for (const match of block.matchAll(/^ {10}([A-Z0-9_]+): "?([^"\n]+)"?$/gm)) {
        assert.ok(match[1] && match[2]);
        env[match[1]] = match[2];
      }
      const run = /^ {8}run: (.*)$/m.exec(block)?.[1] ?? '';
      return { block, env, run };
    });
}
function validate(source: string): void {
  const executable = source.replace(/^\s*#.*$/gm, '');
  assert.match(executable, /^on:\n {2}push:\n {2}pull_request:\n {2}workflow_dispatch:/m);
  assert.match(executable, /postgres-version: \["15", "18"\]/);
  assert.match(
    executable,
    /native-scenario: \["builtin-default", "fixed4096-control", "builtin-explicit1m-pressure"\]/,
  );
  assert.match(executable, /image: postgres:\$\{\{ matrix\.postgres-version \}\}/);
  assert.match(executable, /image: redis:7\.4-alpine/);
  assert.match(executable, /POSTGRES_DB: model_router_saas_ci/);
  assert.match(executable, /image: node:22\.16\.0-bookworm/);
  assert.match(executable, /postgresql-client openssl redis-server/);
  assert.doesNotMatch(
    executable,
    /\b(?:if|continue-on-error|needs|paths|paths-ignore):|\|\|\s*true|upload-artifact|\bFLUSHALL\b|pg_stat_statements|run-current-r9|managed-postgres-commercial-gateway/,
  );
  const actual = steps(source);
  assert.equal(actual.length, 9, 'no hidden bootstrap, preseed, or secret-artifact steps');
  assert.equal(actual[0]?.block.split('\n')[0], 'uses: actions/checkout@v4');
  assert.equal(actual[2]?.run, 'npm ci');
  assert.equal(actual[3]?.run, 'node --import tsx --test tests/ci/fast-gateway-required-gates.test.ts');
  const strict = actual[4];
  assert.ok(strict);
  const command = strict.block
    .split('        run: >-\n')[1]
    ?.split('\n')
    .map((line) => line.trim())
    .join(' ')
    .trim();
  assert.equal(
    command,
    [
      './node_modules/.bin/tsc --noEmit',
      '--target ES2022 --module NodeNext --moduleResolution NodeNext',
      '--lib ES2023 --strict --esModuleInterop --skipLibCheck --types node',
      'src/types/busboy.d.ts',
      ...strictRoots,
      'tests/ci/fast-gateway-required-gates.test.ts',
    ].join(' '),
  );
  assert.equal(actual[5]?.run, provision);
  for (const [index, command, env] of [
    [6, journalCommand, roleEnv],
    [
      7,
      `node --import tsx --test ${redis}`,
      {
        NODE_ENV: 'test',
        MODEL_ROUTER_FAST_ADMISSION_REDIS_TEST: '1',
        MODEL_ROUTER_TEST_REDIS_BIN: '/usr/bin/redis-server',
      },
    ],
    [
      8,
      `node --import tsx --test ${native}`,
      {
        ...roleEnv,
        MODEL_ROUTER_NATIVE_FAST_HTTP_REQUIRED: '1',
        MODEL_ROUTER_NATIVE_FAST_HTTP_SCENARIO: nativeScenarioMatrix,
        MODEL_ROUTER_NATIVE_FAST_HTTP_REDIS_URL: 'redis://redis:6379',
      },
    ],
  ] as const) {
    assert.equal(actual[index]?.run, command);
    assert.deepEqual(actual[index]?.env, env);
  }
}

test('native fast PG15/18 and Redis gates are unconditional, isolated and strictly typed', () => validate(workflow));
test('required fast wiring rejects disabled roots, altered roles, missing tools and swallowed failures', () => {
  for (const [original, replacement] of [
    ['postgres-version: ["15", "18"]', 'postgres-version: ["18"]'],
    ['image: redis:7.4-alpine', 'image: redis:latest'],
    [
      'native-scenario: ["builtin-default", "fixed4096-control", "builtin-explicit1m-pressure"]',
      'native-scenario: ["fixed4096-control"]',
    ],
    [
      `MODEL_ROUTER_NATIVE_FAST_HTTP_SCENARIO: ${nativeScenarioMatrix}`,
      'MODEL_ROUTER_NATIVE_FAST_HTTP_SCENARIO: fixed4096-control',
    ],
    ['postgresql-client openssl redis-server', 'postgresql-client openssl'],
    ['--lib ES2023 --strict', '--lib ES2023'],
    [`          ${runtime}\n`, ''],
    [`          ${seed}\n`, ''],
    [`          ${resolution}\n`, ''],
    [journalCommand, `node --import tsx --test ${journal}`],
    ['MODEL_ROUTER_NATIVE_FAST_HTTP_REQUIRED: "1"', 'MODEL_ROUTER_NATIVE_FAST_HTTP_REQUIRED: "0"'],
    ['MODEL_ROUTER_FAST_ADMISSION_REDIS_TEST: "1"', 'MODEL_ROUTER_FAST_ADMISSION_REDIS_TEST: "0"'],
    ['MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: "1"', 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: "0"'],
    [
      'postgresql://model_router_saas_gateway@postgres:5432/model_router_saas_ci',
      'postgresql://postgres@postgres:5432/model_router_saas_ci',
    ],
    [provision, 'echo skipped'],
    [`run: ${journalCommand}`, `run: ${journalCommand} || true`],
    [`run: node --import tsx --test ${native}`, `if: false\n        run: node --import tsx --test ${native}`],
  ]) {
    assert.notEqual(workflow.replace(original, replacement), workflow);
    assert.throws(() => validate(workflow.replace(original, replacement)), original);
  }
});
test('native HTTP fixture exercises actual composition, cold authority and exact financial drain without secret artifacts', () => {
  const source = read(native);
  assert.match(source, /process\.env\[REQUIRED_FLAG\] !== '1' && !anyRoleConfigured && !redisUrl/);
  assert.match(source, /const urls = roleUrls\(\)/);
  assert.match(source, /\['--import', 'tsx', 'src\/cli\/index\.ts', 'start', '--role', 'gateway'\]/);
  assert.match(source, /MODEL_ROUTER_FAST_GATEWAY: 'reserved-max'/);
  assert.match(source, /'x-model-router-execution-mode'\), 'fast-reserved-max'/);
  assert.match(source, /cold accounts must work without fabricated healthy rows/);
  assert.match(source, /drained is legal only for this new isolated namespace/);
  assert.match(source, /await stop\(child\)|t\.after\(\(\) => stop\(child\)\)/);
  assert.match(source, /rm\(directory, \{ recursive: true, force: true \}\)/);
  assert.match(source, /completed: expected\.count/);
  assert.match(source, /count: '4', charge: '140'/);
  assert.match(source, /count: '2', charge: '70'/);
  assert.match(source, /unresolved: '0'/);
  assert.match(source, /wallet: expected\.wallet/);
  assert.match(source, /postings: expected\.count/);
  assert.match(source, /unbalanced: '0'/);
  for (const key of ['legacy_requests', 'legacy_attempts', 'legacy_evidence', 'legacy_reservations', 'legacy_usage']) {
    assert.ok(source.includes(`${key}: '0'`));
  }
  assert.doesNotMatch(
    read(seed),
    /INSERT INTO saas_provider_account_runtime_health|INSERT INTO saas_requests|INSERT INTO saas_attempts/,
  );
  assert.match(read(runtime), /FROM saas_provider_capabilities/);
  assert.match(read(runtime), /FROM saas_platform_provider_credentials/);
  assert.doesNotMatch(read(runtime), /fastGateway:|journal:|reserveIntent:|appendReceipt:|sendFast:/);
});

test('default native gate uses actual built-in M and omitted automatic/pool settings, with explicit cap pressure control', () => {
  const source = read(native);
  assert.match(
    read(runtime),
    /createBuiltinUsageUpperBoundEstimator\(\{ maxInputTokens: 262144, maxOutputTokens: 131072 \}\)/,
  );
  assert.match(source, /Object\.hasOwn\(childEnvironment, name\), false/);
  for (const name of [
    'MODEL_ROUTER_SAAS_DB_POOL_MAX',
    'MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS',
    'MODEL_ROUTER_FAST_CREDIT_STRIPES',
    'MODEL_ROUTER_FAST_CONNECTION_REUSE',
  ])
    assert.ok(source.includes(`'${name}'`));
  assert.match(source, /FIRST funded attempt/);
  assert.doesNotMatch(source, /coldCreditDenials|response\.status === 429/);
  assert.match(source, /maximum = fixedControl \? '20480' : '524480'/);
  assert.match(source, /trustedConcurrency = 64n/);
  assert.match(source, /automaticTarget, 67133440n/);
  assert.match(source, /tlsConnections, 1/);
  assert.match(source, /denied\.status, 429/);
  assert.match(source, /after\.intents, before\.intents/);
  assert.match(source, /BigInt\(after\.backing\) <= 1_000_000n/);
});

test('default native gate requires actual TPM reconciliation without erasing RPM or changing limits', () => {
  const source = read(native);
  const defaultDrain = source.slice(source.lastIndexOf("if (scenario === 'builtin-default')"));
  assert.match(source, /rpm: '600000', tpm: '600000000', concurrency: '64'/);
  assert.match(defaultDrain, /readRateLimits\(\),\s*initialRateLimits/);
  assert.match(defaultDrain, /liveSlots, 0/);
  assert.match(defaultDrain, /leaseKeys.length, 4/);
  assert.match(defaultDrain, /lease.state, 'released'/);
  assert.match(defaultDrain, /bucketRequests, expectedBuckets.get\(bucket\)/);
  assert.match(defaultDrain, /bucketTokens, bucketRequests \* 15/);
  assert.match(defaultDrain, /requests, currentRequests/);
  assert.match(defaultDrain, /tokens, requests \* 15/);
  assert.doesNotMatch(defaultDrain, /redis\.(?:set|del|flushDb|flushAll)\(/);
});

test('required PG15/18 roots retain receipt-v2 money, race, restart and native pre-ledger proofs', () => {
  validate(workflow);
  const source = read(journal);
  for (const proof of [
    'receipt v2 reduces durable H before ledger, not wallet or backing; replay proof is digest-compatible',
    'receipt v2 keeps C=0, C=M and >2^53 exact, with no second surplus release',
    'receipt v2 missing, invalid, wrong-price and non-success proofs persist evidence but retain M',
    'receipt v2 worker outage retains only proven C and restart exact-drains unchanged cap',
    'receipt v2 active/retired/takeover ordering preserves original allocation and never requires current process epoch',
    'receipt v2 lost autocommit ACK and legacy-first proof replay release at most once',
    'receipt v2 current-target addition follows a concurrent intent version committed after its snapshot',
    'receipt v2 concurrent refill and retirement serialize without losing or duplicating liability',
    'receipt v2 allocation CHECK rolls back receipt+job+release on corrupt backing, rather than silently skipping compaction',
  ]) {
    assert.ok(source.includes(`'${proof}'`), `required full journal root must retain proof: ${proof}`);
  }
  assert.doesNotMatch(source, /\bt(?:est)?\.(?:skip|todo)\s*\(/);
  const resolutionSource = read(resolution);
  assert.match(resolutionSource, /versioned fast resolution preserves immutable paid evidence and retained liability/);
  assert.doesNotMatch(resolutionSource, /\bt(?:est)?\.(?:skip|todo)\s*\(/);
  const nativeSource = read(native);
  assert.match(nativeSource, /await tx\.query\(WALLET_FENCE_SQL, \[saasAdvisoryKey\.walletFence/);
  assert.match(nativeSource, /saas_fast_receipt_liability_releases/);
  assert.match(nativeSource, /max_cost_minor_units-released/);
  assert.match(nativeSource, /state='pending_v2'/);
  assert.match(nativeSource, /state IN \('blocked','blocked_v2'\)/);
  assert.match(nativeSource, /after\.backing, before\.backing/);
  assert.match(nativeSource, /after\.wallet, before\.wallet/);
  assert.match(nativeSource, /after\.postings,\s*before\.postings/);
  assert.match(nativeSource, /after\.maximum_held, before\.maximum_held/);
  assert.match(nativeSource, /BigInt\(after\.available\) - BigInt\(before\.available\),\s*released/);
  assert.match(nativeSource, /BigInt\(before\.held\) - BigInt\(after\.held\),\s*released/);
  assert.match(nativeSource, /upstreamRequests, sentBeforeDenial/);
  assert.match(nativeSource, /upstreamRequests, Number\(expected\.count\)/);
  assert.match(nativeSource, /finalLiability\.releases, expected\.count/);
});
