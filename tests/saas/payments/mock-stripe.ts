import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Programmable mock Stripe server for the C5 provider/drill tests. Routes the
// v1 PaymentIntents/Refunds endpoints the adapter calls, records form params
// plus authorization/idempotency headers, and signs webhook payloads exactly
// like Stripe's v1 scheme (the adapter never talks to real Stripe in tests).

export interface MockStripeCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
}

export type StripeMockEndpoint =
  | 'paymentIntentsCreate'
  | 'paymentIntentsRetrieve'
  | 'paymentIntentsSearch'
  | 'refundsCreate'
  | 'refundsRetrieve';

export type StripeMockHandler = (call: MockStripeCall) => { status?: number; json?: unknown; raw?: string };

export interface MockStripe {
  readonly url: string;
  readonly calls: Record<StripeMockEndpoint, MockStripeCall[]>;
  readonly setHandler: (endpoint: StripeMockEndpoint, handler: StripeMockHandler) => void;
  readonly close: () => Promise<void>;
}

export async function startMockStripe(): Promise<MockStripe> {
  const calls: Record<StripeMockEndpoint, MockStripeCall[]> = {
    paymentIntentsCreate: [],
    paymentIntentsRetrieve: [],
    paymentIntentsSearch: [],
    refundsCreate: [],
    refundsRetrieve: [],
  };
  const handlers = new Map<StripeMockEndpoint, StripeMockHandler>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((value, key) => {
        params[key] = value;
      });
      url.searchParams.forEach((value, key) => {
        if (!(key in params)) params[key] = value;
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const method = req.method ?? 'GET';
      let endpoint: StripeMockEndpoint | null = null;
      if (method === 'POST' && url.pathname === '/v1/payment_intents') endpoint = 'paymentIntentsCreate';
      else if (method === 'GET' && url.pathname === '/v1/payment_intents/search') endpoint = 'paymentIntentsSearch';
      else if (method === 'GET' && /^\/v1\/payment_intents\/[^/]+$/.test(url.pathname))
        endpoint = 'paymentIntentsRetrieve';
      else if (method === 'POST' && url.pathname === '/v1/refunds') endpoint = 'refundsCreate';
      else if (method === 'GET' && /^\/v1\/refunds\/[^/]+$/.test(url.pathname)) endpoint = 'refundsRetrieve';
      if (endpoint === null) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { type: 'invalid_request_error', code: 'resource_missing', message: 'not found' },
          }),
        );
        return;
      }
      const call: MockStripeCall = { method, path: url.pathname, headers, params };
      calls[endpoint].push(call);
      const handler = handlers.get(endpoint);
      if (!handler) {
        res.writeHead(500).end('no handler');
        return;
      }
      const outcome = handler(call);
      if (outcome.raw !== undefined) {
        res.writeHead(outcome.status ?? 200, { 'content-type': 'text/plain' }).end(outcome.raw);
        return;
      }
      res
        .writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(outcome.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler: (endpoint, handler) => handlers.set(endpoint, handler),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** Builds the `stripe-signature` header value for a raw event body, exactly the v1 scheme. */
export function stripeSignatureHeader(rawBody: Buffer, webhookSecret: string, timestampSec: number): string {
  const signature = createHmac('sha256', webhookSecret)
    .update(String(timestampSec), 'utf8')
    .update('.')
    .update(rawBody)
    .digest('hex');
  return `t=${timestampSec},v1=${signature}`;
}

export interface StripeEventIntent {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly metadata?: Record<string, string>;
  readonly clientSecret?: string;
}

/** Serializes a Stripe event envelope carrying a PaymentIntent object. */
export function stripeEventBody(input: {
  readonly eventId: string;
  readonly type: string;
  readonly intent: StripeEventIntent;
  readonly createdSec?: number;
}): Buffer {
  const intent: Record<string, unknown> = {
    id: input.intent.id,
    object: 'payment_intent',
    amount: input.intent.amount,
    currency: input.intent.currency,
    status: input.intent.status,
    metadata: input.intent.metadata ?? {},
  };
  if (input.intent.clientSecret !== undefined) intent.client_secret = input.intent.clientSecret;
  return Buffer.from(
    JSON.stringify({
      id: input.eventId,
      object: 'event',
      type: input.type,
      created: input.createdSec ?? 1_791_532_800,
      data: { object: intent },
    }),
    'utf8',
  );
}

/** Canonical PaymentIntent JSON answer for create/retrieve endpoints. */
export function stripePaymentIntentJson(intent: StripeEventIntent): Record<string, unknown> {
  return {
    id: intent.id,
    object: 'payment_intent',
    amount: intent.amount,
    currency: intent.currency,
    status: intent.status,
    metadata: intent.metadata ?? {},
    ...(intent.clientSecret === undefined ? {} : { client_secret: intent.clientSecret }),
  };
}

/** Canonical Refund JSON answer for create/retrieve endpoints. */
export function stripeRefundJson(input: {
  readonly id: string;
  readonly paymentIntent: string;
  readonly amount: number;
  readonly status: string;
  readonly metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: 'refund',
    amount: input.amount,
    currency: 'usd',
    payment_intent: input.paymentIntent,
    status: input.status,
    metadata: input.metadata ?? {},
  };
}
