import type { IncomingMessage } from 'node:http';

export function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof raw === 'string' && raw.length > 0) {
      const first = raw.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || '';
}
