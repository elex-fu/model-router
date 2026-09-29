import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { afterEach, test } from 'node:test';
import type { CustomerWalletQuery, CustomerWalletSnapshot } from '../../../src/saas/billing/customer-query.js';
import {
  createSaasConsoleHandler,
  type SaasConsoleHttpHandler,
  type SaasConsoleHttpOptions,
} from '../../../src/saas/console/http.js';
import type {
  ConsoleRequest,
  ConsoleRequestDetail,
  ConsoleRequestListQuery,
  ConsoleUsageSummary,
  ConsoleUsageSummaryQuery,
} from '../../../src/saas/console/index.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';

const SESSION_TOKEN = 'valid-session-token-123456';
const USER_ID = 'user-from-session';

const testServers = new Set<Server>();

function closeTestServer(server: Server): Promise<void> {
  if (!server.listening) {
    testServers.delete(server);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      testServers.delete(server);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function listenTestServer(server: Server) {
  testServers.add(server);
  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address;
  } catch (error) {
    await closeTestServer(server);
    throw error;
  }
}

afterEach(async () => {
  const results = await Promise.allSettled([...testServers].map(closeTestServer));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});

function requestSummary(): ConsoleUsageSummary {
  return {
    from: '2026-09-27T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
    requestCount: '2',
    eventCount: '2',
    inputTotal: '900719925474099312345',
    inputUncached: '1',
    cacheRead: '2',
    cacheWrite: '3',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    outputTotal: '4',
    reasoningOutput: '0',
    totalTokens: '900719925474099312349',
  };
}

async function createTestServer(
  overrides: Partial<SaasConsoleHttpOptions['queryService']> = {},
  settings: { readonly tenantRole?: TenantContext['tenantRole']; readonly walletQueryService?: boolean } = {},
) {
  const calls: {
    usage: ConsoleUsageSummaryQuery[];
    requests: ConsoleRequestListQuery[];
    contexts: Array<{ readonly userId: string; readonly tenantId: string }>;
    wallets: Array<{ readonly context: TenantContext; readonly query: CustomerWalletQuery }>;
  } = { usage: [], requests: [], contexts: [], wallets: [] };
  const queryService = {
    getUsageSummary: async (input: ConsoleUsageSummaryQuery) => {
      calls.usage.push(input);
      return requestSummary();
    },
    listRequests: async (input: ConsoleRequestListQuery) => {
      calls.requests.push(input);
      return { items: [] as ConsoleRequest[], nextCursor: null, hasMore: false };
    },
    getRequestDetail: async () => null as ConsoleRequestDetail | null,
    ...overrides,
  } as unknown as SaasConsoleHttpOptions['queryService'];
  const options: SaasConsoleHttpOptions = {
    service: {
      getSession: async (token: string) =>
        token === SESSION_TOKEN
          ? {
              userId: USER_ID,
              activeTenantId: null,
              expiresAt: '2099-01-01T00:00:00.000Z',
              createdAt: '2026-09-28T00:00:00.000Z',
            }
          : undefined,
      resolveTenantContext: async ({ userId, tenantId }) => {
        calls.contexts.push({ userId, tenantId });
        return {
          userId,
          tenantId,
          projectId: 'project-from-identity',
          tenantRole: settings.tenantRole ?? 'owner',
          projectRole: 'viewer',
        };
      },
    },
    queryService,
    ...(settings.walletQueryService === false
      ? {}
      : {
          customerWalletQueryService: {
            getWallet: async (resolvedContext: TenantContext, query: CustomerWalletQuery) => {
              calls.wallets.push({ context: resolvedContext, query });
              return {
                wallet: {
                  currency: query.currency,
                  postedBalanceMinorUnits: '1000',
                  activeHoldsMinorUnits: '125',
                  frozenAmountMinorUnits: '0',
                  availableMinorUnits: '875',
                  spendingFrozen: false,
                },
                ledger: { items: [], nextCursor: null, hasMore: false },
              } satisfies CustomerWalletSnapshot;
            },
          },
        }),
    publicOrigin: 'http://managed-console.test',
  };
  let handler: SaasConsoleHttpHandler;
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      }
    });
  });
  const address = await listenTestServer(server);
  handler = createSaasConsoleHandler(options);
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

function sessionHeaders(cookie = SESSION_TOKEN): HeadersInit {
  return { cookie: `mr_saas_session=${cookie}` };
}

test('authenticates usage and request queries from the single session cookie', async () => {
  const app = await createTestServer();
  const usage = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-a/usage?from=2026-09-27T00%3A00%3A00.000Z&to=2026-09-28T00%3A00%3A00.000Z&projectId=project-a&status=succeeded&supplyMode=platform`,
    {
      headers: { ...sessionHeaders(), 'x-user-id': 'must-not-be-trusted' },
    },
  );
  assert.equal(usage.status, 200);
  const usageBody = (await usage.json()) as { data?: ConsoleUsageSummary; meta?: { requestId?: string } };
  assert.equal(usageBody.data?.inputTotal, '900719925474099312345');
  assert.match(usageBody.meta?.requestId ?? '', /^saas_console_/);
  assert.equal(app.calls.usage[0]?.userId, USER_ID);
  assert.equal(app.calls.usage[0]?.tenantId, 'tenant-a');

  const requests = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-a/requests?limit=2&cursor=c1.not-a-real-cursor`,
    { headers: sessionHeaders() },
  );
  assert.equal(requests.status, 200);
  assert.equal(app.calls.requests[0]?.limit, 2);
  assert.equal(app.calls.requests[0]?.cursor, 'c1.not-a-real-cursor');
});

test('rejects duplicate or malformed cookies before calling the identity service', async () => {
  let getSessionCalls = 0;
  const originalHandler = createSaasConsoleHandler({
    service: {
      getSession: async () => {
        getSessionCalls += 1;
        return undefined;
      },
      resolveTenantContext: async ({ userId, tenantId }) => ({
        userId,
        tenantId,
        projectId: 'project-a',
        tenantRole: 'owner',
        projectRole: 'owner',
      }),
    },
    queryService: {
      getUsageSummary: async () => requestSummary(),
      listRequests: async () => ({ items: [], nextCursor: null, hasMore: false }),
      getRequestDetail: async () => null,
    } as unknown as SaasConsoleHttpOptions['queryService'],
    publicOrigin: 'http://managed-console.test',
  });
  const server = http.createServer((req, res) => {
    void originalHandler(req, res);
  });
  const address = await listenTestServer(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const path = '/console/api/v1/tenants/tenant-a/requests';

  const duplicate = await fetch(`${origin}${path}`, {
    headers: { cookie: `mr_saas_session=${SESSION_TOKEN}; mr_saas_session=other-session-token` },
  });
  const malformed = await fetch(`${origin}${path}`, { headers: { cookie: 'mr_saas_session=%zz' } });
  assert.equal(duplicate.status, 401);
  assert.equal(malformed.status, 401);
  assert.equal(getSessionCalls, 0);
});

test('keeps routes GET-only, rejects userId and unknown filters, and returns safe detail errors', async () => {
  const app = await createTestServer();
  const post = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/requests`, {
    method: 'POST',
    headers: sessionHeaders(),
    body: '{}',
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');

  const forgedUser = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-a/usage?userId=attacker&from=2026-09-27&to=2026-09-28`,
    {
      headers: sessionHeaders(),
    },
  );
  const unknownFilter = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/requests?responseBody=secret`, {
    headers: sessionHeaders(),
  });
  assert.equal(forgedUser.status, 400);
  assert.equal(unknownFilter.status, 400);
  assert.equal(app.calls.usage.length, 0);

  const detail = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/requests/request-a`, {
    headers: sessionHeaders(),
  });
  assert.equal(detail.status, 404);
  const detailBody = (await detail.json()) as { error?: { code?: string; requestId?: string } };
  assert.equal(detailBody.error?.code, 'NOT_FOUND');
  assert.match(detailBody.error?.requestId ?? '', /^saas_console_/);

  const unknownRoute = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/not-a-route`, {
    headers: sessionHeaders(),
  });
  assert.equal(unknownRoute.status, 404);
});

test('resolves the wallet tenant and actor from the session context and returns a read-only page', async () => {
  const app = await createTestServer();
  const response = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-selected-by-path/wallet?currency=USD&limit=2`,
    {
      headers: { ...sessionHeaders(), 'x-user-id': 'forged-user', 'x-tenant-id': 'forged-tenant' },
    },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { data?: CustomerWalletSnapshot };
  assert.equal(body.data?.wallet.postedBalanceMinorUnits, '1000');
  assert.equal(body.data?.wallet.activeHoldsMinorUnits, '125');
  assert.equal(body.data?.wallet.frozenAmountMinorUnits, '0');
  assert.equal(app.calls.contexts.length, 1);
  assert.deepEqual(app.calls.contexts[0], {
    userId: USER_ID,
    tenantId: 'tenant-selected-by-path',
  });
  assert.equal(app.calls.wallets[0]?.context.userId, USER_ID);
  assert.equal(app.calls.wallets[0]?.context.tenantId, 'tenant-selected-by-path');
  assert.equal(app.calls.wallets[0]?.context.tenantRole, 'owner');
  assert.deepEqual(app.calls.wallets[0]?.query, { currency: 'USD', limit: 2 });

  const forgedActor = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-selected-by-path/wallet?currency=USD&userId=attacker`,
    { headers: sessionHeaders() },
  );
  assert.equal(forgedActor.status, 400);
  assert.equal(app.calls.wallets.length, 1);
});

test('requires a tenant owner/admin and reports the explicit wallet query wiring gap', async () => {
  const nonAdmin = await createTestServer({}, { tenantRole: 'developer' });
  const denied = await fetch(`${nonAdmin.origin}/console/api/v1/tenants/tenant-a/wallet?currency=USD`, {
    headers: sessionHeaders(),
  });
  assert.equal(denied.status, 403);
  assert.equal(nonAdmin.calls.wallets.length, 0);

  const unwired = await createTestServer({}, { walletQueryService: false });
  const unavailable = await fetch(`${unwired.origin}/console/api/v1/tenants/tenant-a/wallet?currency=USD`, {
    headers: sessionHeaders(),
  });
  assert.equal(unavailable.status, 503);
  const body = (await unavailable.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'CUSTOMER_WALLET_UNAVAILABLE');
});
