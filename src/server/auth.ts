import type { IncomingMessage } from 'node:http';
import type { ConfigStore } from '../config/store.js';

export function authenticateProxyKey(store: ConfigStore, req: IncomingMessage): { ok: true; keyName: string } | { ok: false } {
  let raw = req.headers['x-api-key'] || req.headers['authorization'];
  if (Array.isArray(raw)) {
    raw = raw[0];
  }
  let apiKey = '';
  if (typeof raw === 'string') {
    if (raw.startsWith('Bearer ')) {
      apiKey = raw.slice(7);
    } else {
      apiKey = raw;
    }
  }

  const proxyKey = store.getProxyKeyByKey(apiKey);
  if (!proxyKey) {
    return { ok: false };
  }

  return { ok: true, keyName: proxyKey.name };
}

export function sendAuthError(res: import('node:http').ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid proxy key',
      },
    })
  );
}

export function sendNoUpstreamError(res: import('node:http').ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'No available upstream for the requested model',
      },
    })
  );
}
