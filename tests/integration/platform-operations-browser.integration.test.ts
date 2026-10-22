import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import {
  anyRoleConfigured,
  seedBrowserOperator,
  seedBrowserValidationIncident,
  startPlatformOperationsBrowser,
} from './platform-operations-browser-harness.js';

// Real current dist CLI + web/dist + Chromium, real HTTP/RBAC/CSRF and restricted
// control-plane PostgreSQL. No page.route, fake handler, provider call, or build.
// node scripts/run-commercial-postgres-gate.mjs --pg-bin ... --worker-role
//   --test-file tests/integration/platform-operations-browser.integration.test.ts
test('platform operations browser: real CLI pages and audited video requeue', { timeout: 120_000 }, async (t) => {
  if (!anyRoleConfigured) {
    assert.notEqual(
      process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED,
      '1',
      'Required isolated PostgreSQL roles missing',
    );
    t.skip('requires the isolated PostgreSQL runner with --worker-role');
    return;
  }
  let app: Awaited<ReturnType<typeof startPlatformOperationsBrowser>> | undefined;
  const evidence = await mkdtemp(join(tmpdir(), 'model-router-platform-browser-evidence-'));
  let stage = 'standard-cli-harness';
  const responses: Array<{ path: string; method: string; status: number }> = [];
  const pageErrors: string[] = [];
  const scenarios: Record<string, unknown> = {};
  try {
    app = await startPlatformOperationsBrowser();
    const live = app;
    live.page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/admin/api/v1/'))
        responses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
    });
    live.page.on('pageerror', (error) => pageErrors.push(error.name));
    const summaryRead = live.page.waitForResponse(
      (response) => response.url().includes('/ops/summary?') && response.request().method() === 'GET',
    );
    stage = 'real-mfa-login-and-ops-mount';
    await live.login(live.page, live.operator);
    await expect(live.page.getByRole('heading', { name: '运营概览', exact: true })).toBeVisible();
    stage = 'operations-summary-contract';
    const summary = await summaryRead;
    if (summary.status() !== 200) {
      const data = await summary.json();
      const code = data?.error?.code;
      const diagnostic = {
        httpStatus: summary.status(),
        httpCode: [
          'INTERNAL_ERROR',
          'OPERATIONS_STORAGE_ERROR',
          'OPERATIONS_INVALID_INPUT',
          'FORBIDDEN',
          'UNAUTHENTICATED',
        ].includes(code)
          ? code
          : 'UNCLASSIFIED',
        ...(await live.diagnoseSummary()),
      };
      await writeFile(join(evidence, 'summary-diagnostic.json'), JSON.stringify(diagnostic), { mode: 0o600 });
      throw new Error(`Operations summary fixed diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    await expect(live.page.getByText('运营摘要读取失败', { exact: true })).toHaveCount(0);
    const summaryData = (await summary.json()).data;
    assert.deepEqual(
      summaryData.metrics.paymentWebhookBacklog,
      {
        pending: '0',
        processing: '0',
        oldestUnprocessedAgeMs: null,
      },
      'Actual empty PostgreSQL inbox must produce exact zero counts and a null age',
    );
    await expect(live.page.getByRole('heading', { name: '故障队列与数据新鲜度', exact: true })).toBeVisible();
    await expect(live.page.getByText('尚未配置 PostgreSQL 备份或 PITR 策略', { exact: true })).toBeVisible();
    await expect(live.page.getByText('最近验证完成记录', { exact: true })).toBeVisible();
    for (const path of ['/admin/api/v1/ops/summary', '/admin/api/v1/ops/diagnostics', '/admin/api/v1/ops/backups']) {
      assert.ok(
        responses.some((row) => row.path === path && row.status === 200),
        `Actual ${path} response consumed by React`,
      );
    }
    await live.page.screenshot({ path: join(evidence, 'operations-overview.png'), fullPage: true });
    stage = 'navigate-and-requeue-original-video';
    await live.page.getByRole('link', { name: '媒体恢复队列', exact: true }).click();
    const row = live.page.locator('tbody tr').filter({ hasText: live.taskId });
    await expect(row).toContainText('回查到期超过 1 分钟');
    await row.getByRole('button', { name: '重排状态回查', exact: true }).click();
    const submit = live.page.getByRole('button', { name: '确认重排回查', exact: true });
    await expect(submit).toBeDisabled();
    const reason = 'Browser fixture verified original task recovery';
    await live.page.getByLabel('处置原因').fill(reason);
    await expect(submit).toBeDisabled();
    await live.page.getByLabel('已检查账号与原任务，确认提前排入状态回查').check();
    const posted = live.page.waitForResponse(
      (response) => response.url().endsWith(`/video/${live.taskId}/requeue`) && response.request().method() === 'POST',
    );
    await submit.click();
    const response = await posted;
    assert.equal(response.status(), 200, 'Browser POST must reach the actual HTTP mutation');
    const headers = response.request().headers();
    assert.ok(headers['x-csrf-token']);
    assert.ok(headers['idempotency-key']);
    assert.deepEqual(response.request().postDataJSON(), {
      tenantId: live.seed.tenantId,
      expectedLeaseEpoch: 0,
      reason,
    });
    const receipt = (await response.json()).data;
    await expect(live.page.getByRole('status').filter({ hasText: '状态回查已排队' })).toContainText(
      receipt.auditEventId,
    );
    stage = 'postgres-receipt-audit-and-epoch-proof';
    const proof = (
      await live.database.query<{
        lease_epoch: string;
        billing_state: string;
        poll_failures: number;
        audit_event_id: string;
        reason: string;
        actor_id: string;
        receipts: string;
      }>(
        `SELECT v.lease_epoch,v.billing_state,v.poll_failures,r.audit_event_id::text,r.reason,a.actor_user_id::text AS actor_id,
        (SELECT count(*)::text FROM saas_ops_media_requeue_requests WHERE task_id=v.request_id) AS receipts
      FROM saas_video_tasks v JOIN saas_ops_media_requeue_requests r ON r.task_id=v.request_id AND r.tenant_id=v.tenant_id
      JOIN saas_audit_events a ON a.id=r.audit_event_id WHERE v.request_id=$1`,
        [live.taskId],
      )
    ).rows[0];
    assert.ok(proof);
    assert.equal(proof.audit_event_id, receipt.auditEventId);
    assert.equal(proof.lease_epoch, '1');
    assert.equal(proof.billing_state, 'pending');
    assert.equal(proof.poll_failures, 5);
    assert.equal(proof.reason, reason);
    assert.equal(proof.actor_id, live.operator.userId);
    assert.equal(proof.receipts, '1');
    await expect(row).toContainText(receipt.auditEventId);
    await live.page.screenshot({ path: join(evidence, 'media-requeue-receipt.png'), fullPage: true });
    stage = 'stale-epoch-real-http-conflict';
    await row.getByRole('button', { name: '重排状态回查', exact: true }).click();
    await live.page.getByLabel('处置原因').fill('Browser fixture stale snapshot');
    await live.page.getByLabel('已检查账号与原任务，确认提前排入状态回查').check();
    await live.gateway.query('UPDATE saas_video_tasks SET lease_epoch=lease_epoch+1 WHERE request_id=$1', [
      live.taskId,
    ]);
    const conflicted = live.page.waitForResponse(
      (value) => value.url().endsWith(`/video/${live.taskId}/requeue`) && value.request().method() === 'POST',
    );
    await live.page.getByRole('button', { name: '确认重排回查', exact: true }).click();
    assert.equal((await conflicted).status(), 409);
    await expect(live.page.getByRole('alert')).toContainText('任务已变化');
    await expect(live.page.getByLabel('处置原因')).toHaveValue('Browser fixture stale snapshot');
    const afterConflict = (
      await live.database.query<{ epoch: string; receipts: string }>(
        `SELECT lease_epoch::text AS epoch,
      (SELECT count(*)::text FROM saas_ops_media_requeue_requests WHERE task_id=$1) AS receipts FROM saas_video_tasks WHERE request_id=$1`,
        [live.taskId],
      )
    ).rows[0];
    assert.deepEqual(afterConflict, { epoch: '2', receipts: '1' });
    await live.page.getByRole('button', { name: '重新读取任务', exact: true }).click();
    await expect(live.page.getByRole('heading', { name: '重排视频状态回查', exact: true })).toHaveCount(0);
    await expect(row).toContainText('版本 2');
    scenarios.staleEpoch = { httpStatus: 409, ...afterConflict };

    stage = 'scheduling-success-only-freshness';
    const incident = await seedBrowserValidationIncident(live.database);
    await live.database.query(
      "UPDATE saas_platform_provider_accounts SET kimi_usage_updated_at=clock_timestamp()-interval '2 hours',kimi_usage_attempted_at=clock_timestamp() WHERE id=$1",
      [live.account.account_id],
    );
    await live.page
      .getByRole('navigation', { name: '平台管理导航' })
      .getByRole('link', { name: '故障处置', exact: true })
      .click();
    const healthRow = live.page.locator('tbody tr').filter({ hasText: live.account.account_id });
    await expect(healthRow).toContainText('配额滞后');
    const onlyConstrained = live.page.getByLabel('仅显示已扫描账号中的调度限制');
    const filtered = live.page.waitForResponse(
      (value) =>
        value.url().includes('/ops/scheduling-health?') &&
        new URL(value.url()).searchParams.get('onlyConstrained') === 'true',
    );
    await onlyConstrained.check();
    assert.equal((await filtered).status(), 200);
    await expect(healthRow).toHaveCount(0, { timeout: 10_000 });
    await expect(live.page.locator('tbody tr').filter({ hasText: incident.accountId })).toContainText(
      'provider_response_too_large',
    );
    await onlyConstrained.uncheck();
    // The existing five-second React Query cache can restore this view without
    // another HTTP request. The explicit refresh below must fetch new facts.
    await expect(healthRow).toContainText('配额滞后');
    await live.database.query(
      'UPDATE saas_platform_provider_accounts SET kimi_usage_updated_at=clock_timestamp() WHERE id=$1',
      [live.account.account_id],
    );
    const freshRead = live.page.waitForResponse(
      (value) => value.url().includes('/ops/scheduling-health?') && value.request().method() === 'GET',
    );
    await live.page.getByRole('button', { name: '刷新', exact: true }).click();
    const freshResponse = await freshRead;
    assert.equal(freshResponse.status(), 200);
    const observed = (await freshResponse.json()).data.rows.find(
      (entry: { accountId: string }) => entry.accountId === live.account.account_id,
    );
    assert.equal(observed.quotaFreshness, 'fresh');
    await expect(healthRow).toContainText('近期配额');
    scenarios.freshness = { attemptedOnly: 'stale', successfulObservation: 'fresh', httpStatus: 200 };

    stage = 'incident-validation-requeue-only';
    const incidentRow = live.page.locator('tbody tr').filter({ hasText: incident.accountId });
    await expect(incidentRow).toContainText('provider_response_too_large');
    await incidentRow.getByLabel('验证重试原因').fill('Browser fixture response-bound repair verified');
    live.page.once('dialog', (dialog) => void dialog.accept());
    const validationPost = live.page.waitForResponse(
      (value) =>
        value.url().endsWith(`/credentials/${incident.credentialId}/validation-requeue`) &&
        value.request().method() === 'POST',
    );
    await incidentRow.getByRole('button', { name: '重新验证凭据', exact: true }).click();
    const validationResponse = await validationPost;
    assert.equal(validationResponse.status(), 200);
    const validationReceipt = (await validationResponse.json()).data;
    await expect(incidentRow.getByRole('status')).toContainText('已进入验证队列');
    const validationProof = (
      await live.database.query(
        `SELECT j.status,j.attempt_count,j.lease_generation::text,
      r.audit_event_id::text,r.prior_snapshot->>'attempt_count' AS prior_attempt_count,a.actor_user_id::text AS actor_id
      FROM saas_platform_provider_credential_validation_jobs j
      JOIN saas_platform_credential_validation_requeue_requests r ON r.job_id=j.id
      JOIN saas_audit_events a ON a.id=r.audit_event_id WHERE j.id=$1`,
        [incident.jobId],
      )
    ).rows[0] as Record<string, unknown>;
    assert.deepEqual(validationProof, {
      status: 'queued',
      attempt_count: 0,
      lease_generation: '3',
      audit_event_id: validationReceipt.auditEventId,
      prior_attempt_count: '1',
      actor_id: live.operator.userId,
    });
    scenarios.validation = validationProof;
    await live.page.screenshot({ path: join(evidence, 'scheduling-validation-queued.png'), fullPage: true });

    stage = 'support-readonly-real-rbac';
    const support = await seedBrowserOperator(live.database, live.key, 'support-readonly');
    const logout = live.page.waitForResponse(
      (value) => value.url().endsWith('/auth/session') && value.request().method() === 'DELETE',
    );
    await live.page.getByRole('button', { name: '退出登录', exact: true }).click();
    assert.equal((await logout).status(), 200);
    await live.login(live.page, support);
    await expect(live.page.getByText('尚未配置 PostgreSQL 备份或 PITR 策略', { exact: true })).toBeVisible();
    await live.page.getByRole('link', { name: '媒体恢复队列', exact: true }).click();
    await expect(
      live.page
        .locator('tbody tr')
        .filter({ hasText: live.taskId })
        .getByRole('button', { name: '重排状态回查', exact: true }),
    ).toBeDisabled();
    const csrf = (await live.context.cookies(`${live.origin}/admin/api/v1`)).find(
      (cookie) => cookie.name === 'mr_platform_admin_csrf',
    );
    assert.ok(csrf);
    const denied = await live.context.request.post(
      `${live.origin}/admin/api/v1/ops/media-tasks/video/${live.taskId}/requeue`,
      {
        headers: { origin: live.origin, 'x-csrf-token': csrf.value, 'idempotency-key': `readonly-${live.taskId}` },
        data: { tenantId: live.seed.tenantId, expectedLeaseEpoch: 2, reason: 'Readonly must not mutate' },
      },
    );
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).error.code, 'FORBIDDEN');
    const unchanged = (
      await live.database.query(
        `SELECT lease_epoch::text AS epoch,
      (SELECT count(*)::text FROM saas_ops_media_requeue_requests WHERE task_id=$1) AS receipts FROM saas_video_tasks WHERE request_id=$1`,
        [live.taskId],
      )
    ).rows[0];
    assert.deepEqual(unchanged, { epoch: '2', receipts: '1' });
    await live.page
      .getByRole('navigation', { name: '平台管理导航' })
      .getByRole('link', { name: '故障处置', exact: true })
      .click();
    await expect(live.page.getByRole('heading', { name: '故障处置', exact: true })).toBeVisible();
    await expect(live.page.locator('tbody tr').filter({ hasText: live.account.account_id })).toContainText('近期配额');
    await expect(live.page.getByRole('button', { name: '排入探活', exact: true })).toHaveCount(2);
    for (const button of await live.page.getByRole('button', { name: '排入探活', exact: true }).all())
      await expect(button).toBeDisabled();
    await expect(live.page.getByRole('button', { name: '重新验证凭据', exact: true })).toHaveCount(0);
    scenarios.readonly = { httpStatus: 403, ...(unchanged as object) };
    assert.deepEqual(pageErrors, []);
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          format: 'platform-operations-browser-v1',
          runtime: 'current-dist-standard-control-plane-cli',
          ui: 'current-web-dist-headless-chrome',
          auth: 'real-password-and-totp-from-dynamic-fixture-seed',
          artifactDigest: live.artifactDigest,
          responses,
          proof,
          scenarios,
          passed: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    t.diagnostic(`platform_browser_evidence=${evidence}`);
  } catch (error) {
    const code = error instanceof assert.AssertionError ? 'ASSERTION' : error instanceof Error ? error.name : 'UNKNOWN';
    const message = error instanceof Error ? error.message : 'unknown';
    const safe = app
      ? message.replaceAll(app.operator.password, '[password]').replaceAll(app.operator.totp, '[totp]')
      : message;
    await writeFile(
      join(evidence, 'failure.json'),
      JSON.stringify({ stage, code, message: safe.slice(0, 5000), responses, pageErrors }),
      { mode: 0o600 },
    );
    t.diagnostic(`platform_browser_failure stage=${stage} evidence=${evidence}`);
    throw new Error(`Platform browser failed at ${stage}: ${safe.slice(0, 1500)}`);
  } finally {
    await app?.close();
  }
});
