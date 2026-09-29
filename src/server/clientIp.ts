import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

function trustedPeer(remote: string, trustProxy: boolean | string[]): boolean {
  if (typeof trustProxy === 'boolean') return trustProxy;
  if (trustProxy.length === 0) return false;
  const normalized = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  const family = isIP(normalized);
  if (!family) return false;
  const list = new BlockList();
  for (const cidr of trustProxy) {
    const slash = cidr.lastIndexOf('/');
    const address = slash < 0 ? cidr : cidr.slice(0, slash);
    const type = isIP(address);
    if (!type) continue;
    const prefix = slash < 0 ? (type === 4 ? 32 : 128) : Number(cidr.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (type === 4 ? 32 : 128)) continue;
    list.addSubnet(address, prefix, type === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export function getClientIp(req: IncomingMessage, trustProxy: boolean | string[]): string {
  const remote = req.socket.remoteAddress || '';
  if (trustedPeer(remote, trustProxy)) {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof raw === 'string' && raw.length > 0) {
      const first = raw.split(',')[0]?.trim();
      if (first && isIP(first)) return first;
    }
  }
  return remote;
}
