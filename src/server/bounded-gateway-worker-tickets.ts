import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { bindTrustedRequestPeer } from '../saas/gateway/trusted-request-peer.js';
import { BOUNDED_GATEWAY_TICKET_HEADER, isBoundedGatewayTicket } from './bounded-gateway-protocol.js';

/** One-use request capabilities arrive only over the authenticated parent IPC channel. */
export class BoundedGatewayWorkerTickets {
  private readonly tickets = new Map<
    string,
    { peer: string; active: boolean; probe: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly requests = new WeakMap<IncomingMessage, string>();
  private stopping = false;
  private businessCount = 0;
  private probeTicket: string | undefined;
  constructor(
    private readonly limit: number,
    private readonly completed: (ticket: string) => void,
    private readonly reservationTimeoutMs = 5000,
  ) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(reservationTimeoutMs) ||
      reservationTimeoutMs < 1
    )
      throw new Error('BOUNDED_GATEWAY_INVALID_TICKET_LIMIT');
  }
  reserve(ticket: string, peer: string): void {
    this.allocate(ticket, peer, false);
  }
  /** Exactly one private readiness request, outside but not convertible into business capacity. */
  reserveProbe(ticket: string): void {
    this.allocate(ticket, '127.0.0.1', true);
  }
  private allocate(ticket: string, peer: string, probe: boolean): void {
    if (
      this.stopping ||
      !isBoundedGatewayTicket(ticket) ||
      !isIP(peer) ||
      this.tickets.has(ticket) ||
      (probe ? this.probeTicket !== undefined : this.businessCount >= this.limit)
    ) {
      throw new Error('BOUNDED_GATEWAY_INVALID_RESERVATION');
    }
    const timer = setTimeout(() => this.cancel(ticket), this.reservationTimeoutMs);
    timer.unref();
    this.tickets.set(ticket, { peer, active: false, probe, timer });
    if (probe) this.probeTicket = ticket;
    else this.businessCount++;
  }
  accept(request: IncomingMessage, response: ServerResponse): boolean {
    const ticket = request.headers[BOUNDED_GATEWAY_TICKET_HEADER];
    delete request.headers[BOUNDED_GATEWAY_TICKET_HEADER];
    const owned = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (
      this.stopping ||
      !owned ||
      owned.active ||
      typeof ticket !== 'string' ||
      (owned.probe &&
        (request.method !== 'GET' ||
          request.url !== '/readyz' ||
          request.headers['transfer-encoding'] !== undefined ||
          (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')))
    ) {
      response.writeHead(403, { connection: 'close', 'content-type': 'application/json' });
      response.end('{"error":{"code":"PRIVATE_GATEWAY_CAPABILITY_REQUIRED"}}');
      request.pause();
      return false;
    }
    clearTimeout(owned.timer);
    owned.active = true;
    bindTrustedRequestPeer(request, owned.peer);
    this.requests.set(request, ticket);
    return true;
  }
  finish(request: IncomingMessage): void {
    const ticket = this.requests.get(request);
    if (!ticket) return;
    this.requests.delete(request);
    const owned = this.tickets.get(ticket);
    if (owned) this.release(ticket, owned.probe);
  }
  cancel(ticket: string): void {
    const owned = this.tickets.get(ticket);
    if (!owned || owned.active) return;
    clearTimeout(owned.timer);
    this.release(ticket, owned.probe);
  }
  private release(ticket: string, probe: boolean): void {
    this.tickets.delete(ticket);
    if (probe) this.probeTicket = undefined;
    else {
      this.businessCount--;
      this.completed(ticket);
    }
  }
  stop(): void {
    this.stopping = true;
    for (const [ticket, owned] of this.tickets) if (!owned.active) this.cancel(ticket);
  }
  get size(): number {
    return this.tickets.size;
  }
}
