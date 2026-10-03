import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import { createPlatformAdminReadHandler } from '../../../../src/saas/platform/http/index.js';
import { PlatformAuditHistoryQueryService } from '../../../../src/saas/platform/audit/service.js';
import { FakeAuditExecutor } from './fake-executor.js';

test('operator projection does not let forged UA or non-security roles reach the audit query', async () => {
  for (const role of [undefined, 'finance', 'operations', 'support-readonly'] as const) {
    const database = new FakeAuditExecutor();
    const audit = new PlatformAuditHistoryQueryService(database);
    const actor: PlatformAdminActor | undefined = role === undefined ? undefined : {
      userId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', roles: [role],
    };
    const handler = createPlatformAdminReadHandler({
      access: { authenticate: async () => actor },
      operations: { getSummary: async () => ({}) },
      catalog: {
        listProducts: async () => ({}), listCapabilities: async () => ({}), listRights: async () => ({}),
      },
      audit,
    });
    let status = 0;
    let body = '';
    const res = {
      destroyed: false, writableEnded: false,
      writeHead(code: number) { status = code; return this; },
      end(value: string) { body = value; this.writableEnded = true; return this; },
    } as unknown as ServerResponse;
    const req = {
      method: 'GET', url: '/admin/api/v1/audit/events',
      headers: { 'user-agent': '{"actor_kind":"trusted_operator","operator_id":"forged"}' },
    } as IncomingMessage;
    assert.equal(await handler(req, res), true);
    assert.equal(status, role === undefined ? 401 : 403);
    assert.equal(database.calls.length, 0);
    assert.doesNotMatch(body, /forged|trusted_operator|operatorAttestation/);
  }
});
