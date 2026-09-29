import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlaygroundRuns } from '../../src/admin/playground.js';
import type { UpstreamActions } from '../../src/admin/upstream-actions.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import type { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import type { QuotaAdmission, SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { quotaPeriod } from '../../src/quota/period.js';
import type { QuotaTimezoneVersions } from '../../src/quota/timezone-versions.js';
import type { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

async function runPlayground(
  quotaTimezoneVersions?: Pick<QuotaTimezoneVersions, 'resolveForAdmission'>,
): Promise<{ admissions: QuotaAdmission[]; close: () => void }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-playground-quota-'));
  const store = new ControlStore(path.join(directory, 'control'));
  const config = defaultConfigV2(path.join(directory, 'config.json'), 'playground-quota-test');
  config.quota.timezone = 'Asia/Tokyo';
  config.proxyKeys.push({
    id: 'test-key',
    name: 'Test key',
    enabled: true,
    createdAt: new Date(0).toISOString(),
    keyHash: 'a'.repeat(64),
    keyPrefix: 'mr_test',
    dailyTokens: 1000,
    rpm: 10,
    maxConcurrentRequests: 2,
  });

  const control = {
    raw: async () => config,
    previewRoute: async () => ({
      matched: true,
      routeId: 'route-1',
      candidates: [{ configured: true, upstreamId: 'upstream-1', model: 'actual-model', protocol: 'openai' }],
    }),
  } as unknown as ControlService;
  const admissions: QuotaAdmission[] = [];
  const ledger = {
    admit: async (admission: QuotaAdmission) => {
      admissions.push(admission);
      return { allowed: true };
    },
    markAttemptSent: async () => {},
    settle: async () => {},
  } as unknown as SQLiteQuotaLedger;
  const telemetry = {
    upsertRequest: async () => {},
    upsertAttempt: async () => {},
  } as unknown as SQLiteTelemetryStore;
  const actions = {
    generate: async () => ({
      output: 'ok',
      status: 200,
      upstreamId: 'upstream-1',
      model: 'actual-model',
      durationMs: 1,
      usage: null,
    }),
  } as unknown as UpstreamActions;
  const runs = new PlaygroundRuns(control, store, actions, telemetry, ledger, undefined, quotaTimezoneVersions);

  try {
    await runs.run({ keyId: 'test-key', model: 'public-model', protocol: 'openai', input: 'hello' }, 'admin');
  } catch (error) {
    runs.close();
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    admissions,
    close: () => {
      runs.close();
      store.db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('playground resolves the versioned quota period once and passes its fixed identity to admission', async () => {
  const resolutionTimes: number[] = [];
  const versions: Pick<QuotaTimezoneVersions, 'resolveForAdmission'> = {
    resolveForAdmission: (atMs) => {
      resolutionTimes.push(atMs);
      return {
        ...quotaPeriod(atMs, 'Asia/Tokyo', 37),
        versionId: 37,
        timezone: 'Asia/Tokyo',
        effectiveFromMs: 0,
      };
    },
  };
  const run = await runPlayground(versions);
  try {
    assert.equal(resolutionTimes.length, 1);
    assert.equal(run.admissions.length, 1);
    assert.equal(run.admissions[0].atMs, resolutionTimes[0]);
    assert.equal(run.admissions[0].periodId, quotaPeriod(resolutionTimes[0], 'Asia/Tokyo', 37).id);
    assert.equal(run.admissions[0].periodStartMs, quotaPeriod(resolutionTimes[0], 'Asia/Tokyo', 37).startMs);
    assert.equal(run.admissions[0].periodEndMs, quotaPeriod(resolutionTimes[0], 'Asia/Tokyo', 37).endMs);
    assert.equal(run.admissions[0].timezoneVersionId, 37);
  } finally {
    run.close();
  }
});

test('playground retains the configured timezone fallback without a version resolver', async () => {
  const run = await runPlayground();
  try {
    assert.equal(run.admissions.length, 1);
    const fallbackPeriod = quotaPeriod(run.admissions[0].atMs, 'Asia/Tokyo');
    assert.equal(run.admissions[0].periodId, fallbackPeriod.id);
    assert.equal(run.admissions[0].periodStartMs, fallbackPeriod.startMs);
    assert.equal(run.admissions[0].periodEndMs, fallbackPeriod.endMs);
    assert.equal(run.admissions[0].timezoneVersionId, undefined);
  } finally {
    run.close();
  }
});
