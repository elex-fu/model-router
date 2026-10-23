import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { PlatformAdminAuthService } from '../../../src/saas/platform/auth/service.js';
import { totpCode } from '../../../src/saas/platform/auth/totp.js';

import { createUnknownOutcomeRecoveryWorkflow } from '../../../src/saas/metering/unknown-outcome-recovery-worker.js';

export async function diagnoseEarlyRecoveryHttp(input: {
  response?: Response; observation: SaasDatabase; tenantId: string; projectId: string; keyId: string;
  diagnostic(safe: string): void;
}): Promise<void> {
  const codes = new Set(['GROUP_NOT_FOUND', 'GROUP_INACTIVE', 'GROUP_STORAGE_ERROR', 'GROUP_SPEND_STORAGE_ERROR',
    'GROUP_SPEND_CURRENCY_MISMATCH', 'GROUP_SPEND_EXCEEDED', 'capability_unavailable', 'rate_limit_exceeded',
    'budget_exceeded', 'upstream_unavailable', 'invalid_request', 'internal_error', 'service_unavailable']);
  let code: string | null = null;
  if (input.response) {
    try {
      const value = await input.response.clone().json() as { error?: { code?: unknown } };
      code = typeof value.error?.code === 'string' && codes.has(value.error.code) ? value.error.code : 'unclassified';
    } catch { code = 'unclassified'; }
  }
  const states = new Set(['pending', 'unknown', 'succeeded', 'failed', 'none', 'resolved', 'reconciliation_pending',
    'not_applicable', 'reserved', 'released', 'settled', 'not_sent', 'sent', 'prepared', 'in_progress']);
  const rows = (await input.observation.query<Record<string, unknown>>(`SELECT r.execution_state,r.reconciliation_state,r.financial_status,
    a.dispatch_state,a.result_state FROM saas_requests r LEFT JOIN saas_attempts a
    ON a.tenant_id=r.tenant_id AND a.request_id=r.id
    WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.proxy_key_id=$3 ORDER BY r.id,a.id`, [input.tenantId, input.projectId, input.keyId])).rows;
  input.diagnostic(JSON.stringify({ stage: 'upstream_receipt_missing', status: input.response?.status ?? null, code,
    requests: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : states.has(String(value)) ? value : 'unclassified']))) }));
}

export function observeOperatorRecoveryWorkflow(diagnostic: (safeCode: string) => void): typeof createUnknownOutcomeRecoveryWorkflow {
  return options => {
    const workflow = createUnknownOutcomeRecoveryWorkflow(options);
    const resolve = workflow.operatorResolution.resolveNotExecuted.bind(workflow.operatorResolution);
    workflow.operatorResolution.resolveNotExecuted = async input => {
      try { return await resolve(input); }
      catch (error) {
        const chain: Array<{ name: string; code: string | null }> = [];
        let current: unknown = error;
        for (let depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
          const item = current as { name?: unknown; code?: unknown; cause?: unknown };
          const name = ['Error', 'DatabaseError', 'SaasBillingError', 'SaasMeteringError'].includes(String(item.name)) ? String(item.name) : 'unclassified';
          const code = typeof item.code === 'string' && (/^[0-9A-Z]{5}$/.test(item.code) || ['STORAGE_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT', 'RECONCILIATION_REQUIRED', 'RESERVATION_STATE_CONFLICT'].includes(item.code)) ? item.code : null;
          chain.push({ name, code });
          current = item.cause;
        }
        diagnostic(`resolve_failure:${JSON.stringify(chain)}`);
        throw error;
      }
    };
    return workflow;
  };
}

type Row = Record<string, unknown>;
export async function proveOperatorRecoveryHttp(input: {
  database: SaasDatabase; observation: SaasDatabase; origin: string;
  keys: ConstructorParameters<typeof PlatformAdminAuthService>[1];
  email: string; password: string; actorId: string; tenantId: string; wrongTenantId: string;
  requestId: string; attemptId: string; evidenceReference: string; billingGroupId: string;
  snapshot(): Promise<unknown>; assertResolved(): Promise<void>; diagnostic(stage: string): void;
}): Promise<void> {
  let stage = 'original_hold';
  try {
  const { database, observation, origin, tenantId, requestId, attemptId } = input;
  const readOriginalHold = () => observation.query<Row>(`SELECT id, tenant_id, request_id, idempotency_namespace, business_key, wallet_id, state, amount_minor_units::text AS amount,
    currency, price_snapshot_ref, reconciliation_reference FROM saas_billing_reservations
    WHERE tenant_id=$1 AND request_id=$2`, [tenantId, requestId]);
  const originalHold = (await readOriginalHold()).rows;
  assert.equal(originalHold.length, 1, 'the original dispatched platform request owns exactly one hold');
  assert.equal(originalHold[0]!.state, 'reconciliation_pending');
  assert.equal(originalHold[0]!.reconciliation_reference, `normal-success-unknown:${tenantId}:${requestId}:${attemptId}`, 'retain the original HTTP unknown reference even when a scanner tick raced this read');
  stage = 'original_group_spend';
  const readGroupSpend = async () => (await observation.query<Row>(`SELECT r.tenant_id,r.request_id,r.billing_group_id,
    r.window_kind,r.window_start::text,r.amount_minor_units::text AS amount,r.charge_currency,
    r.state,r.settled_amount_minor_units::text AS settled_amount,
    c.charge_outstanding_reserved::text AS outstanding,c.charge_settled::text AS charge_settled,c.charge_currency AS counter_currency
    FROM saas_billing_group_spend_reservations r JOIN saas_billing_group_spend_counters c
      ON c.billing_group_id=r.billing_group_id AND c.window_kind=r.window_kind AND c.window_start=r.window_start
    WHERE r.tenant_id=$1 AND r.request_id=$2 AND r.billing_group_id=$3 ORDER BY r.window_kind`, [tenantId, requestId, input.billingGroupId])).rows;
  const originalGroupSpend = await readGroupSpend();
  assert.equal(originalGroupSpend.length, 1, 'normal admission must create exactly one nonempty daily group hold');
  const groupHold = originalGroupSpend[0]!;
  assert.equal(groupHold.window_kind, 'daily'); assert.equal(groupHold.amount, '80');
  assert.equal(groupHold.state, 'outstanding'); assert.equal(groupHold.settled_amount, null);
  assert.equal(groupHold.charge_currency, 'USD'); assert.equal(groupHold.counter_currency, 'USD');
  assert.equal(groupHold.outstanding, '80'); assert.equal(groupHold.charge_settled, '0');
  // Use the existing runtime scanner. No case/lease/financial row is written by this fixture.
  stage = 'scanner_capture';
  let recoveryCase: Row | undefined;
  const deadline = Date.now() + 30_000;
  do {
    recoveryCase = (await observation.query<Row>(`SELECT * FROM saas_unknown_outcome_reconciliation_cases
      WHERE tenant_id=$1 AND request_id=$2`, [tenantId, requestId])).rows[0];
    if (recoveryCase?.case_state === 'operator_required') break;
    await delay(25);
  } while (Date.now() < deadline);
  const scannerDiagnostic = JSON.stringify({ caseState: recoveryCase?.case_state ?? null, scanAttempts: recoveryCase?.scan_attempt_count ?? null, lastErrorCode: recoveryCase?.last_error_code ?? null });
  assert.equal(recoveryCase?.case_state, 'operator_required', `the normal scanner must capture the original request: ${scannerDiagnostic}`);
  assert.ok(Number(recoveryCase!.scan_attempt_count) >= 1);
  assert.equal(recoveryCase!.lease_token, null);
  assert.equal(recoveryCase!.lease_expires_at, null);
  assert.deepEqual((await readOriginalHold()).rows, originalHold, 'scanner capture must preserve the original hold identity, amount, currency, price snapshot and reconciliation reference');
  assert.deepEqual(await readGroupSpend(), originalGroupSpend, 'scanner preserves the original group window and outstanding amount');
  const caseId = String(recoveryCase!.id);
  stage = 'mfa_issuance';
  const auth = new PlatformAdminAuthService(database, input.keys);
  const enrollment = await auth.issueMfaEnrollmentToken(input.email, {
    operatorId: 'p10-recovery-fixture-operator', reasonCode: 'initial-enrollment', requestId: randomUUID(),
  });
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { response, json: await response.json() as { data?: Row; error?: { code: string } } };
  };
  stage = 'mfa_start';
  const started = await request('/admin/api/v1/auth/mfa/enrollment/start', 'POST', { issuer: 'P10 recovery fixture' }, {
    origin, authorization: `Bearer ${enrollment.token}`,
  });
  assert.equal(started.response.status, 200);
  const secret = new URL(String(started.json.data!.otpauthUri)).searchParams.get('secret');
  assert.ok(secret);
  const confirmedStep = Math.floor(Date.now() / 30_000);
  const confirmedCode = totpCode(secret, Date.now());
  stage = 'mfa_confirm';
  const confirmed = await request('/admin/api/v1/auth/mfa/enrollment/confirm', 'POST', { code: confirmedCode }, {
    origin, authorization: `Bearer ${String(started.json.data!.confirmationToken)}`,
  });
  assert.equal(confirmed.response.status, 200);
  // Wait for a real fresh TOTP step, without changing a stored replay counter or service clock.
  const loginDeadline = Date.now() + 65_000;
  while (Math.floor(Date.now() / 30_000) <= confirmedStep || totpCode(secret, Date.now()) === confirmedCode) {
    assert.ok(Date.now() < loginDeadline, 'a distinct real TOTP login step must arrive');
    await delay(50);
  }
  stage = 'mfa_login';
  const login = await request('/admin/api/v1/auth/session', 'POST', {
    email: input.email, password: input.password, code: totpCode(secret, Date.now()),
  }, { origin });
  assert.equal(login.response.status, 200);
  const cookies = login.response.headers.getSetCookie().filter(value => !value.includes('Max-Age=0'));
  const cookie = cookies.map(value => value.split(';')[0]!).join('; ');
  assert.ok(cookie.includes('mr_platform_admin_session=') && cookie.includes('mr_platform_admin_csrf='));
  const headers = { origin, cookie, 'x-csrf-token': String(login.json.data!.csrfToken), 'idempotency-key': `p10-${randomUUID()}` };
  const prefix = '/admin/api/v1/ops/unknown-outcomes';
  const query = `?tenantId=${encodeURIComponent(tenantId)}`;
  const path = `${prefix}/${encodeURIComponent(caseId)}/resolve-not-executed${query}`;
  const body = { supportTicketRef: `test-only:p10:${requestId}`, reason: 'Reviewed controlled upstream branch: no execution branch exists after receipt',
    coverage: [{ attemptId, outcome: 'not_executed', evidenceReference: input.evidenceReference }] };
  const snapshot = async () => ({ business: await input.snapshot(), groupSpend: await readGroupSpend(), recovery: (await observation.query<Row>(`SELECT
    (SELECT to_jsonb(c) FROM saas_unknown_outcome_reconciliation_cases c WHERE id=$1 AND tenant_id=$2) AS recovery_case,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM saas_unknown_outcome_reconciliation_observations o WHERE case_id=$1 AND tenant_id=$2) AS observations,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM saas_audit_events a WHERE tenant_id=$2 AND request_id=$3) AS audits`, [caseId, tenantId, requestId])).rows });
  stage = 'operator_denials';
  const before = await snapshot();
  const denied = async (status: number, promise: ReturnType<typeof request>) => {
    assert.equal((await promise).response.status, status);
    assert.deepEqual(await snapshot(), before, 'rejected operator HTTP must preserve all original facts');
  };
  await denied(401, request(`${prefix}${query}`));
  await denied(401, request(path, 'POST', body, { origin }));
  const { origin: _origin, ...withoutOrigin } = headers;
  await denied(403, request(path, 'POST', body, withoutOrigin));
  await denied(403, request(path, 'POST', body, { ...headers, origin: 'https://wrong-origin.example' }));
  const { 'x-csrf-token': _csrf, ...withoutCsrf } = headers;
  await denied(403, request(path, 'POST', body, withoutCsrf));
  await denied(403, request(path, 'POST', body, { ...headers, 'x-csrf-token': 'wrong-csrf' }));
  await denied(404, request(`${prefix}/${caseId}/resolve-not-executed?tenantId=${encodeURIComponent(input.wrongTenantId)}`, 'POST', body, headers));
  await denied(400, request(path, 'POST', { ...body, coverage: [] }, headers));
  await denied(400, request(path, 'POST', { ...body, coverage: [body.coverage[0], body.coverage[0]] }, headers));
  stage = 'operator_list';
  const listed = await request(`${prefix}${query}`, 'GET', undefined, { cookie });
  assert.equal(listed.response.status, 200);
  assert.ok((listed.json.data!.items as Row[]).some(item => item.caseId === caseId && item.requestId === requestId));
  stage = 'operator_detail';
  const detail = await request(`${prefix}/${caseId}${query}`, 'GET', undefined, { cookie });
  assert.equal(detail.response.status, 200);
  const summary = detail.json.data!.summary as Row;
  assert.equal(summary.caseId, caseId); assert.equal(summary.requestId, requestId); assert.equal(summary.tenantId, tenantId);
  stage = 'operator_resolve';
  const resolved = await request(path, 'POST', body, headers);
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.json.data!.status, 'resolved');
  stage = 'resolved_financial_facts';
  await input.assertResolved();
  assert.deepEqual(await readGroupSpend(), [{ ...groupHold, state: 'released', settled_amount: '0', outstanding: '0' }], 'operator release must clear the exact original daily reservation without a settled group charge');
  stage = 'resolution_audit';
  const audit = (await observation.query<Row>(`SELECT c.case_state,c.resolution_audit_event_id, c.resolution_reason,
      c.resolution_support_ticket_ref,c.resolution_evidence_digest,c.resolution_actor_user_id,
      o.audit_event_id,o.actor_user_id,o.reason,o.support_ticket_ref,o.evidence_reference,o.attempt_id,
      a.id AS audit_id,a.actor_user_id AS audit_actor,a.tenant_id AS audit_tenant,a.target_id,a.request_id,a.action
    FROM saas_unknown_outcome_reconciliation_cases c
    JOIN saas_unknown_outcome_reconciliation_observations o ON o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.observation_kind='operator_resolution'
    JOIN saas_audit_events a ON a.id=c.resolution_audit_event_id
    WHERE c.id=$1 AND c.tenant_id=$2`, [caseId, tenantId])).rows;
  assert.equal(audit.length, 1);
  const row = audit[0]!;
  assert.equal(row.case_state, 'resolved');
  assert.equal(row.audit_id, row.resolution_audit_event_id);
  assert.equal(row.audit_event_id, row.audit_id);
  for (const key of ['actor_user_id', 'resolution_actor_user_id', 'audit_actor']) assert.equal(row[key], input.actorId);
  assert.equal(row.audit_tenant, tenantId); assert.equal(row.target_id, caseId); assert.equal(row.request_id, requestId);
  assert.equal(row.action, 'request.unknown_outcome.operator_not_executed');
  assert.equal(row.attempt_id, attemptId); assert.equal(row.evidence_reference, input.evidenceReference);
  for (const key of ['reason', 'resolution_reason']) assert.equal(row[key], body.reason);
  for (const key of ['support_ticket_ref', 'resolution_support_ticket_ref']) assert.equal(row[key], body.supportTicketRef);
  assert.equal(row.resolution_evidence_digest, createHash('sha256').update(JSON.stringify([[attemptId, input.evidenceReference]])).digest('hex'));
  stage = 'operator_replay';
  const after = await snapshot();
  const replay = await request(path, 'POST', body, headers);
  assert.equal(replay.response.status, 200); assert.equal(replay.json.data!.status, 'replayed');
  assert.deepEqual(await snapshot(), after, 'canonical operator replay must not append another audit or charge');
  stage = 'operator_conflicts';
  for (const [changedBody, changedHeaders] of [
    [{ ...body, reason: `${body.reason} altered` }, headers],
    [body, { ...headers, 'idempotency-key': `${headers['idempotency-key']}-changed` }],
  ] as const) {
    const conflict = await request(path, 'POST', changedBody, changedHeaders);
    assert.equal(conflict.response.status, 409); assert.equal(conflict.json.error!.code, 'RESOLUTION_CONFLICT');
    assert.deepEqual(await snapshot(), after);
  }
  } catch (error) {
    input.diagnostic(stage); // Fixed stage only; never credentials, body or database exception text.
    throw error; // Preserve the first assertion/exception and its stack.
  }
}
