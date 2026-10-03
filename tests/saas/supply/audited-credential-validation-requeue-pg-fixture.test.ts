import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Source contracts only: never import/evaluate the PG helper, connect to a
// database, or substitute for its restricted-role PG integration gate.
const source = readFileSync(resolve(process.cwd(),
  'tests/saas/supply/audited-credential-validation-requeue-pg-fixture.ts'), 'utf8');

test('retry fixture is exactly the failed result branch with unchanged synthetic outcome facts', () => {
  assert.match(source, /export const REQUEUE_PG_FAILED: Extract<ProviderCredentialValidationResult, \{ state: 'failed' \}> = \{\s*state: 'failed',\s*errorCode: 'provider_timeout',\s*retryable: false,\s*adapterId: 'synthetic-requeue-controlled-probe',\s*httpStatus: null,\s*durationMs: 0\s*\};/);
  assert.doesNotMatch(source, /export const REQUEUE_PG_FAILED:\s*ProviderCredentialValidationResult\s*=/);
  assert.doesNotMatch(source, /\bas\s+(?:any|unknown)\b|@ts-(?:ignore|expect-error|nocheck)\b/);
});

test('claim and retry/terminal completion remain calls to the actual dedicated worker store', () => {
  assert.match(source, /import \{ PostgresCredentialValidationWorkerStore, type CredentialValidationLease \} from '\.\.\/\.\.\/\.\.\/src\/saas\/supply\/credential-validation-worker\.js';/);
  assert.match(source, /store: new PostgresCredentialValidationWorkerStore\(worker, kms, \{ \.\.\.invalidationStoreOptions\(\), approvedTargets: targets \}\)/);
  const claim = source.match(/export async function actualRequeueClaim\b[\s\S]*?(?=\nexport async function actualRequeueTerminal\b)/)?.[0];
  const terminal = source.match(/export async function actualRequeueTerminal\b[\s\S]*?(?=\nexport async function requeueCommand\b)/)?.[0];
  assert.ok(claim && terminal, 'real claim and terminal fixture functions must remain present');
  assert.match(claim, /const deadline = Date\.now\(\) \+ 5000;/);
  assert.match(claim, /const lease = await fixture\.store\.claimNext\(\);/);
  assert.match(claim, /assert\.ok\(lease\.job\.id === fixture\.supply\.jobId,/);
  assert.match(claim, /while \(Date\.now\(\) < deadline\);/);
  assert.match(terminal, /for \(let index = 0; index < attempts; index \+= 1\)/);
  assert.match(terminal, /last = await actualRequeueClaim\(fixture\);/);
  assert.match(terminal, /assert\.ok\(await fixture\.store\.complete\(last, \{ \.\.\.REQUEUE_PG_FAILED, retryable: index < attempts - 1 \}\) === true,/);
  assert.match(terminal, /assert\.ok\(last, 'at least one genuine worker attempt required'\);/);
  assert.match(terminal, /return last;/);
});

test('fixture retains real restricted actors and only legal migrator seed writes, without CAS or schema substitutes', () => {
  for (const actor of ['MIGRATOR', 'CONTROL_PLANE', 'GATEWAY', 'WORKER']) {
    assert.ok(source.includes('MODEL_ROUTER_SAAS_REQUEUE_E2E_' + actor + '_URL'));
  }
  assert.match(source, /identity === role/);
  assert.match(source, /parsed\.search === '' && parsed\.hash === ''/);
  assert.match(source, /candidate === target/);
  assert.doesNotMatch(source, /\b(?:Fake\w*|readonlyMock\w*|mock\w*|stub\w*)\b/);
  assert.doesNotMatch(source, /\b(?:claimNext|complete)\s*[:=]\s*(?:async\b|\()/);
  assert.doesNotMatch(source, /Object\.defineProperty|Object\.assign|\.prototype\b/);
  assert.doesNotMatch(source, /['"\x60]\s*(?:UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
  assert.doesNotMatch(source, /\bquery(?:<[^()\n]*>)?\(\s*['"\x60]\s*INSERT\s+INTO\s+saas_(?:tenant_provider_|credential_validation_)/i);
  assert.doesNotMatch(source, /\b(?:SET\s+(?:LOCAL\s+)?(?:ROLE|search_path)|set_config)\b/i);
  for (const table of ['saas_memberships', 'saas_projects', 'saas_sessions']) {
    assert.ok(source.includes('INSERT INTO ' + table + '('), 'retain legal actor/session/project seed facts');
  }
  assert.match(source, /const result = await tx\.query<Row>\(sql, values\);/);
  assert.match(source, /assert\.ok\(result\.rowCount === 1 && result\.rows\.length === 1,/);
  assert.match(source, /await afterSuccessfulInsert\(tx, result\);/);
  assert.match(source, /return result;/);
});
