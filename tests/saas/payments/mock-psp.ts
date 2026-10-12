import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Shared programmable mock PSP server for EasyPay provider/drill tests.
// Routes mapi.php / api.php?act=order / api.php?act=refund to per-endpoint
// handlers and records raw form params for signature/plaintext assertions.

export type PspHandler = (params: Record<string, string>) => { status?: number; json?: unknown; raw?: string };

export interface MockPsp {
  readonly url: string;
  readonly calls: { mapi: Record<string, string>[]; query: Record<string, string>[]; refund: Record<string, string>[] };
  readonly setHandler: (endpoint: 'mapi' | 'query' | 'refund', handler: PspHandler) => void;
  readonly close: () => Promise<void>;
}

export async function startMockPsp(): Promise<MockPsp> {
  const calls: MockPsp['calls'] = { mapi: [], query: [], refund: [] };
  const handlers = new Map<string, PspHandler>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((value, key) => {
        params[key] = value;
      });
      let endpoint: 'mapi' | 'query' | 'refund' | null = null;
      if (url.pathname.endsWith('/mapi.php')) endpoint = 'mapi';
      else if (
        url.pathname.endsWith('/api.php') &&
        (url.searchParams.get('act') === 'refund' || params.act === 'refund')
      )
        endpoint = 'refund';
      else if (url.pathname.endsWith('/api.php') && params.act === 'order') endpoint = 'query';
      if (endpoint === null) {
        res.writeHead(404).end('not found');
        return;
      }
      calls[endpoint].push(params);
      const handler = handlers.get(endpoint);
      if (!handler) {
        res.writeHead(500).end('no handler');
        return;
      }
      const outcome = handler(params);
      if (outcome.raw !== undefined) {
        res.writeHead(outcome.status ?? 200, { 'content-type': 'text/plain' }).end(outcome.raw);
        return;
      }
      res
        .writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(outcome.json ?? { code: 1 }));
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
