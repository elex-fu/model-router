import type { IncomingMessage } from 'node:http';
import type { ConfigStore } from '../config/store.js';

export function authenticateProxyKey(
  store: ConfigStore,
  req: IncomingMessage
): { ok: true; keyName: string } | { ok: false } {
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
