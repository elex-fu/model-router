import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import { PLATFORM_ADMIN_BULK_IMPORT_PATHS } from '../../../../src/saas/platform/http/bulk-import.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminReadHandlerOptions,
} from '../../../../src/saas/platform/http/index.js';
import type {
  BulkImportItemRecord,
  BulkImportItemStatus,
  BulkImportJobRecord,
  BulkImportRequest,
  BulkImportResult,
} from '../../../../src/saas/supply/bulk-import-service.js';
import type {
  BulkImportItemListQuery,
  BulkImportJobStatusSnapshot,
} from '../../../../src/saas/supply/postgres-bulk-import-read-store.js';

const ACTOR: PlatformAdminActor = {
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  sessionId: 'session-1',
  roles: ['operations'],
};
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const EGRESS_PROXY_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-02T03:04:05.000Z';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const SECRET = ['fixture', 'bulk-http', 'credential'].join(':');

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

class FakeBulkImport {
  readonly imports: BulkImportRequest[] = [];
  readonly itemQueries: BulkImportItemListQuery[] = [];
  job: BulkImportJobRecord | null = null;
  items: BulkImportItemRecord[] = [];
  failure: Error | undefined;

  async importAccounts(input: BulkImportRequest): Promise<BulkImportResult> {
    this.imports.push(structuredClone(input));
    if (this.failure) throw this.failure;
    const items = input.items.map((item, itemIndex): BulkImportItemRecord => {
      const failed = item.material.outcome === 'fail';
      return {
        jobId: JOB_ID,
        itemIndex,
        provider: item.provider,
        credentialFingerprint: itemIndex === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
        status: failed ? 'failed' : 'succeeded',
        accountRef: failed ? null : `platform-account-${itemIndex}`,
        errorReason: failed ? 'CREDENTIALS_JSON_INVALID' : null,
        displayName: item.displayName ?? null,
        egressProxyId: item.egressProxyId ?? null,
        validationState: failed ? 'not_requested' : 'queued',
        optionWarnings: item.displayName === undefined ? [] : ['DISPLAY_NAME_UNSUPPORTED'],
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
        // Deliberately adversarial extra field: the transport allowlist must drop it.
        material: item.material,
      } as BulkImportItemRecord;
    });
    const failureCount = items.filter((item) => item.status === 'failed').length;
    const job: BulkImportJobRecord = {
      id: JOB_ID,
      status: 'completed',
      totalCount: items.length,
      successCount: items.length - failureCount,
      failureCount,
      createdBy: input.audit.actorUserId,
      errorSummary: failureCount === 0 ? {} : { CREDENTIALS_JSON_INVALID: failureCount },
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    };
    this.job = job;
    this.items = items;
    return { job, items };
  }

  async getJobStatus(id: string): Promise<BulkImportJobStatusSnapshot | null> {
    if (this.job?.id !== id) return null;
    const counts: Record<BulkImportItemStatus, number> = {
      pending: 0,
      succeeded: 0,
      deduplicated: 0,
      failed: 0,
    };
    for (const item of this.items) counts[item.status] += 1;
    return { job: this.job, counts };
  }

  async listItems(query: BulkImportItemListQuery): Promise<readonly BulkImportItemRecord[]> {
    this.itemQueries.push({ ...query });
    return this.items
      .filter((item) => item.jobId === query.jobId && item.itemIndex > (query.afterItemIndex ?? -1))
      .slice(0, query.limit);
  }
}

function writeInit(body: unknown, overrides: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: 'https://platform-admin.test',
      host: 'platform-admin.test',
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
      'user-agent': 'platform-admin-bulk-import-test',
      ...overrides,
    },
    body: JSON.stringify(body),
  };
}

function startHarness(actor: PlatformAdminActor | undefined, bulkImport?: FakeBulkImport) {
  const options: PlatformAdminReadHandlerOptions = {
    access: { authenticate: async () => actor },
    operations: { getSummary: async () => ({}) },
    catalog: {
      listProducts: async () => ({ items: [] }),
      listCapabilities: async () => ({ items: [] }),
      listRights: async () => ({ items: [] }),
    },
    bulkImport: bulkImport === undefined ? undefined : { service: bulkImport, store: bulkImport },
    writeSecurity: {
      publicOrigin: 'https://platform-admin.test',
      authService: {
        verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
      },
    },
  };
  const handler = createPlatformAdminReadHandler(options);
  return {
    async request(target: string, init: RequestInit = {}): Promise<TestResponse> {
      const url = new URL(target, 'https://platform-admin.test');
      const body = init.body === undefined ? undefined : String(init.body);
      const req = {
        url: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseHeaders = new Headers();
      let responseBody = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number, headers: Record<string, unknown> = {}) {
          status = code;
          responseHeaders = new Headers(
            Object.entries(headers).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : String(value)]],
            ),
          );
          return res;
        },
        end(value?: unknown) {
          responseBody = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      assert.equal(await handler(req, res), true);
      return {
        status,
        headers: responseHeaders,
        body: JSON.parse(responseBody) as Record<string, unknown>,
        rawBody: responseBody,
      };
    },
  };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  return (error as Record<string, unknown>).code as string;
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.data;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertSafeHeaders(response: TestResponse): void {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

test('bulk import requires an authenticated operations actor and valid write CSRF', async () => {
  const bulk = new FakeBulkImport();
  const unauthenticated = startHarness(undefined, bulk);
  const denied = await unauthenticated.request(
    PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs,
    writeInit({ provider: 'codex', items: [{ material: {} }] }),
  );
  assert.equal(denied.status, 401);
  assert.equal(errorCode(denied.body), 'UNAUTHENTICATED');

  const readOnly = startHarness({ ...ACTOR, roles: ['security'] }, bulk);
  const forbidden = await readOnly.request(`${PLATFORM_ADMIN_BULK_IMPORT_PATHS.job.replace(':jobId', JOB_ID)}`);
  assert.equal(forbidden.status, 403);
  assert.equal(errorCode(forbidden.body), 'FORBIDDEN');

  const app = startHarness(ACTOR, bulk);
  const csrf = await app.request(PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs, {
    ...writeInit({ provider: 'codex', items: [{ material: {} }] }),
    headers: {
      ...writeInit({}).headers,
      'x-csrf-token': 'wrong',
    },
  });
  assert.equal(csrf.status, 403);
  assert.equal(errorCode(csrf.body), 'CSRF_REJECTED');
  assert.equal(bulk.imports.length, 0);
});

test('bulk import happy path maps provider and audit context without echoing credential material', async () => {
  const bulk = new FakeBulkImport();
  const app = startHarness(ACTOR, bulk);
  const response = await app.request(
    PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs,
    writeInit({
      provider: 'codex',
      items: [
        {
          material: { tokens: { access_token: SECRET, refresh_token: 'fixture-refresh' } },
          displayName: 'Imported account',
          egressProxyId: EGRESS_PROXY_ID,
        },
      ],
    }),
  );
  assert.equal(response.status, 201);
  assertSafeHeaders(response);
  assert.equal(response.rawBody.includes(SECRET), false);
  assert.equal(response.rawBody.includes('fixture-refresh'), false);
  assert.equal(response.rawBody.includes('material'), false);
  assert.equal(response.rawBody.includes('access_token'), false);
  const result = data(response.body);
  assert.deepEqual(Object.keys(result).sort(), ['items', 'job']);
  assert.equal((result.job as Record<string, unknown>).status, 'completed');
  assert.equal(bulk.imports.length, 1);
  const input = bulk.imports[0];
  assert.ok(input);
  assert.equal(input.items[0]?.provider, 'codex');
  assert.equal(input.items[0]?.displayName, 'Imported account');
  assert.equal(input.items[0]?.egressProxyId, EGRESS_PROXY_ID);
  assert.deepEqual(input.audit, {
    actorUserId: ACTOR.userId,
    sourceIp: '203.0.113.10',
    userAgent: 'platform-admin-bulk-import-test',
  });
});

test('per-item failures and option warnings pass through create and item-list responses', async () => {
  const bulk = new FakeBulkImport();
  const app = startHarness(ACTOR, bulk);
  const created = await app.request(
    PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs,
    writeInit({
      provider: 'claude',
      items: [
        { material: { credential: SECRET }, displayName: 'Supported only by a future sink' },
        { material: { credential: 'fixture-good' } },
        { material: { credential: 'fixture-bad', outcome: 'fail' } },
      ],
    }),
  );
  // The fake's failure marker is inside material, matching the real service's
  // per-item isolation contract rather than failing the whole HTTP request.
  assert.equal(created.status, 201);
  const createdData = data(created.body);
  const job = createdData.job as Record<string, unknown>;
  assert.equal(job.successCount, 2);
  assert.equal(job.failureCount, 1);
  assert.deepEqual(job.errorSummary, { CREDENTIALS_JSON_INVALID: 1 });
  const items = createdData.items as Record<string, unknown>[];
  assert.equal(items[2]?.status, 'failed');
  assert.equal(items[2]?.errorReason, 'CREDENTIALS_JSON_INVALID');
  assert.deepEqual(items[0]?.optionWarnings, ['DISPLAY_NAME_UNSUPPORTED']);
  assert.equal(created.rawBody.includes(SECRET), false);

  const listed = await app.request(`${PLATFORM_ADMIN_BULK_IMPORT_PATHS.items.replace(':jobId', JOB_ID)}?limit=2`);
  assert.equal(listed.status, 200);
  const page = data(listed.body);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, '1');
  assert.equal((page.items as unknown[]).length, 2);
  assert.equal(listed.rawBody.includes('material'), false);

  const remaining = await app.request(
    `${PLATFORM_ADMIN_BULK_IMPORT_PATHS.items.replace(':jobId', JOB_ID)}?limit=2&cursor=1`,
  );
  const remainingItems = data(remaining.body).items as Record<string, unknown>[];
  assert.equal(remainingItems[0]?.errorReason, 'CREDENTIALS_JSON_INVALID');
  assert.equal(data(remaining.body).hasMore, false);
  assert.equal(data(remaining.body).nextCursor, null);
});

test('job status returns all item-state counts and unknown jobs are metadata-only 404s', async () => {
  const bulk = new FakeBulkImport();
  const app = startHarness(ACTOR, bulk);
  const missing = await app.request(PLATFORM_ADMIN_BULK_IMPORT_PATHS.job.replace(':jobId', JOB_ID));
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing.body), 'BULK_IMPORT_JOB_NOT_FOUND');

  await app.request(
    PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs,
    writeInit({
      provider: 'gemini',
      items: [{ material: { credential: SECRET } }, { material: { credential: 'bad', outcome: 'fail' } }],
    }),
  );
  const response = await app.request(PLATFORM_ADMIN_BULK_IMPORT_PATHS.job.replace(':jobId', JOB_ID));
  assert.equal(response.status, 200);
  assertSafeHeaders(response);
  const result = data(response.body);
  assert.deepEqual(result.counts, { pending: 0, succeeded: 1, deduplicated: 0, failed: 1 });
  assert.equal((result.job as Record<string, unknown>).totalCount, 2);
  assert.equal(response.rawBody.includes(SECRET), false);
});

test('bulk import enforces strict bodies, the 1000-item bound, and safe service failures', async () => {
  const bulk = new FakeBulkImport();
  const app = startHarness(ACTOR, bulk);
  for (const body of [
    { provider: 'unknown', items: [{ material: {} }] },
    { provider: 'codex', items: [] },
    { provider: 'codex', items: Array.from({ length: 1001 }, () => ({ material: {} })) },
    { provider: 'codex', items: [{ material: {}, provider: 'claude' }] },
    { provider: 'codex', items: [{ material: [] }] },
  ]) {
    const response = await app.request(PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs, writeInit(body));
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), 'INVALID_BODY');
  }
  assert.equal(bulk.imports.length, 0);

  bulk.failure = new Error(`credential=${SECRET}`);
  const failed = await app.request(
    PLATFORM_ADMIN_BULK_IMPORT_PATHS.jobs,
    writeInit({ provider: 'codex', items: [{ material: { credential: SECRET } }] }),
  );
  assert.equal(failed.status, 500);
  assert.equal(errorCode(failed.body), 'INTERNAL_ERROR');
  assert.equal(failed.rawBody.includes(SECRET), false);
});
