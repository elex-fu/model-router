import type { IncomingMessage } from 'node:http';
import type { ConfigStore } from '../config/store.js';
import type { ProxyKey } from '../config/types.js';

export function authenticateProxyKey(
  store: ConfigStore,
  req: IncomingMessage,
): { ok: true; key: ProxyKey; rawAuth?: string } | { ok: false } {
  let raw = req.headers['x-api-key'] || req.headers['authorization'];
  if (Array.isArray(raw)) {
    raw = raw[0];
  }
  let apiKey = '';
  let rawAuth: string | undefined;
  if (typeof raw === 'string') {
    rawAuth = raw;
    if (raw.startsWith('Bearer ')) {
      apiKey = raw.slice(7);
    } else {
      apiKey = raw;
    }
  }

  const proxyKey = store.getProxyKeyByKey(apiKey);
  if (!proxyKey || !proxyKey.enabled) {
    return { ok: false };
  }
  if (proxyKey.expiresAt && Date.now() >= Date.parse(proxyKey.expiresAt)) {
    return { ok: false };
  }

  return { ok: true, key: proxyKey, rawAuth };
}
