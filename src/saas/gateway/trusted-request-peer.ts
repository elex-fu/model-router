import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const peers = new WeakMap<IncomingMessage, string>();

/** Only the private IPC-authenticated gateway boundary may bind this fact. Never read an HTTP header here. */
export function bindTrustedRequestPeer(request: IncomingMessage, peer: string): void {
  if (!isIP(peer) || peers.has(request)) throw new Error('INVALID_TRUSTED_REQUEST_PEER');
  peers.set(request, peer);
}

export function requestPeerAddress(request: IncomingMessage): string | undefined {
  return peers.get(request) ?? request.socket?.remoteAddress;
}
