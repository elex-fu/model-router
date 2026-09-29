import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../../web/src/api/types.ts';
import {
  configConflictFieldPresentation,
  configConflictFields,
  isSensitiveConfigConflictField,
  rebaseConfigDraft,
} from '../../web/src/features/settings.tsx';

function config(value: Record<string, unknown>): Config {
  return { schemaVersion: 2, revision: 4, ...value } as Config;
}

function softLimit(value: Config): number {
  return (value.quota as { limits: { soft: number } }).limits.soft;
}

test('field diff and rebase merge independent nested changes onto the latest revision', () => {
  const base = config({ quota: { limits: { soft: 10, hard: 20 }, timezone: 'UTC' } });
  const mine = config({ quota: { limits: { soft: 11, hard: 20 }, timezone: 'UTC' } });
  const latest = config({ quota: { limits: { soft: 10, hard: 25 }, timezone: 'UTC' } });
  latest.revision = 5;

  const fields = configConflictFields(base, mine, latest);
  assert.deepEqual(
    fields.map((field) => [field.path, field.mineChanged, field.latestChanged, field.conflict]),
    [
      ['quota.limits.hard', false, true, false],
      ['quota.limits.soft', true, false, false],
    ],
  );
  const result = rebaseConfigDraft(base, mine, latest);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.draft.revision, 5);
  assert.deepEqual(result.draft.quota?.limits, { soft: 11, hard: 25 });
});

test('same-field conflicts remain unresolved until the administrator explicitly chooses a value', () => {
  const base = config({ quota: { limits: { soft: 10 } } });
  const mine = config({ quota: { limits: { soft: 11 } } });
  const latest = config({ quota: { limits: { soft: 12 } } });
  latest.revision = 6;

  const [field] = configConflictFields(base, mine, latest);
  assert.equal(field?.path, 'quota.limits.soft');
  assert.equal(field?.conflict, true);
  const unresolved = rebaseConfigDraft(base, mine, latest);
  assert.deepEqual(unresolved.unresolved, ['quota.limits.soft']);
  assert.equal(softLimit(unresolved.draft), 12);

  const keepMine = rebaseConfigDraft(base, mine, latest, { 'quota.limits.soft': 'mine' });
  assert.deepEqual(keepMine.unresolved, []);
  assert.equal(softLimit(keepMine.draft), 11);
  const keepLatest = rebaseConfigDraft(base, mine, latest, { 'quota.limits.soft': 'latest' });
  assert.equal(softLimit(keepLatest.draft), 12);
});

test('nested additions and deletions rebase without dropping independent latest values', () => {
  const base = config({ settings: { removed: 'old', flags: {} } });
  const mine = config({ settings: { flags: { mineOnly: true } } });
  const latest = config({ settings: { removed: 'old', latestOnly: 'kept', flags: { latestOnly: true } } });
  latest.revision = 9;

  const result = rebaseConfigDraft(base, mine, latest);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.draft.settings, {
    latestOnly: 'kept',
    flags: { latestOnly: true, mineOnly: true },
  });
  assert.equal(result.draft.revision, 9);
});

test('arrays are reported and resolved as one atomic field', () => {
  const base = config({ routes: [{ id: 'route-a', targets: ['upstream-a'] }] });
  const mine = config({ routes: [{ id: 'route-a', targets: ['upstream-mine'] }] });
  const latest = config({ routes: [{ id: 'route-a', targets: ['upstream-latest'] }] });
  latest.revision = 7;

  const fields = configConflictFields(base, mine, latest);
  assert.deepEqual(
    fields.map((field) => field.path),
    ['routes'],
  );
  assert.equal(fields[0]?.conflict, true);
  const result = rebaseConfigDraft(base, mine, latest, { routes: 'mine' });
  assert.deepEqual(result.draft.routes, mine.routes);
  assert.deepEqual(result.unresolved, []);
});

test('sensitive values inside an atomic credentials array are redacted from every diff side', () => {
  const base = config({ upstreams: [{ id: 'upstream-a', credentials: [{ secret: 'BASE_SENTINEL_CREDENTIAL' }] }] });
  const mine = config({ upstreams: [{ id: 'upstream-a', credentials: [{ secret: 'DRAFT_SENTINEL_CREDENTIAL' }] }] });
  const latest = config({ upstreams: [{ id: 'upstream-a', credentials: [{ secret: 'LATEST_SENTINEL_CREDENTIAL' }] }] });
  const [field] = configConflictFields(base, mine, latest);
  assert.equal(field?.path, 'upstreams');
  assert.ok(field && isSensitiveConfigConflictField(field));

  const visible = field ? configConflictFieldPresentation(field) : undefined;
  assert.deepEqual(visible, {
    path: '（敏感字段已隐藏）',
    base: '（敏感字段已隐藏）',
    mine: '（敏感字段已隐藏）',
    latest: '（敏感字段已隐藏）',
    redacted: true,
  });
  assert.doesNotMatch(JSON.stringify(visible), /SENTINEL_CREDENTIAL/);
});
