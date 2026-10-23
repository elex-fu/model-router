import { createConnection, createServer, type Socket } from 'node:net';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const COMMIT = Buffer.from('COMMIT\0');
export interface CommitAckLossEvidence {
  readonly frontendCommitForwarded: boolean;
  readonly serverCommitObserved: boolean;
  readonly backendCommitForwarded: boolean;
  readonly connectionCut: boolean;
}

/** Test-only PostgreSQL v3 framing. No SQL, parameters or startup data are retained in evidence. */
export class CommitAckLossFrames {
  private frontend: Buffer = Buffer.alloc(0);
  private backend: Buffer = Buffer.alloc(0);
  private startup = true;
  private armed = false;
  private commitForwarded = false;
  private observed = false;
  private commitAckForwarded = false;
  private cut = false;

  private append(previous: Buffer, chunk: Buffer): Buffer {
    if (previous.length + chunk.length > MAX_FRAME_BYTES * 2) throw new Error('PG proxy buffer limit');
    return Buffer.concat([previous, chunk]);
  }
  frontendBytes(chunk: Buffer): Buffer[] {
    if (this.cut) return [];
    this.frontend = this.append(this.frontend, chunk);
    const forward: Buffer[] = [];
    for (;;) {
      const header = this.startup ? 4 : 5;
      if (this.frontend.length < header) break;
      const length = this.frontend.readUInt32BE(this.startup ? 0 : 1);
      if (length < (this.startup ? 8 : 4) || length > MAX_FRAME_BYTES) throw new Error('PG proxy invalid frontend frame');
      const total = length + (this.startup ? 0 : 1);
      if (this.frontend.length < total) break;
      const frame = this.frontend.subarray(0, total);
      if (this.startup) {
        if (frame.readUInt32BE(4) !== 196608) throw new Error('PG proxy requires plaintext v3 startup');
        this.startup = false;
      } else if (frame[0] === 81 && frame.subarray(5).equals(COMMIT)) {
        this.armed = true;
        this.commitForwarded = true;
      }
      forward.push(frame);
      this.frontend = this.frontend.subarray(total);
    }
    return forward;
  }
  backendBytes(chunk: Buffer): { readonly forward: readonly Buffer[]; readonly disconnect: boolean } {
    if (this.cut) return { forward: [], disconnect: true };
    this.backend = this.append(this.backend, chunk);
    const forward: Buffer[] = [];
    for (;;) {
      if (this.backend.length < 5) break;
      const length = this.backend.readUInt32BE(1);
      if (length < 4 || length > MAX_FRAME_BYTES) throw new Error('PG proxy invalid backend frame');
      const total = length + 1;
      if (this.backend.length < total) break;
      const frame = this.backend.subarray(0, total);
      if (this.armed && frame[0] === 67 && frame.subarray(5).equals(COMMIT)) {
        // PostgreSQL emitted a real COMMIT completion. Withhold the entire
        // frame and everything after it (including a coalesced ReadyForQuery).
        this.observed = true;
        this.cut = true;
        this.backend = Buffer.alloc(0);
        this.frontend = Buffer.alloc(0);
        return { forward, disconnect: true };
      }
      if (this.armed && (frame[0] === 69 || frame[0] === 67 || frame[0] === 90)) this.armed = false;
      if (frame[0] === 67 && frame.subarray(5).equals(COMMIT)) this.commitAckForwarded = true;
      forward.push(frame);
      this.backend = this.backend.subarray(total);
    }
    return { forward, disconnect: false };
  }
  evidence(): CommitAckLossEvidence {
    return { frontendCommitForwarded: this.commitForwarded, serverCommitObserved: this.observed, backendCommitForwarded: this.commitAckForwarded, connectionCut: this.cut };
  }
}

export interface CommitAckLossTarget { readonly host: string; readonly port: number; readonly database: string }
/** Same disposable local/CI endpoint boundary as the root's roleUrls check. */
export function validateCommitAckLossTarget(upstream: CommitAckLossTarget): void {
  const validPort = Number.isInteger(upstream.port) && upstream.port > 0 && upstream.port <= 65535;
  const local = ['127.0.0.1', '::1', '[::1]'].includes(upstream.host) &&
    ![5432, 6432, 53782].includes(upstream.port) &&
    (upstream.database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/u.test(upstream.database));
  const ci = upstream.host === 'postgres' && upstream.port === 5432 && upstream.database === 'model_router_saas_ci';
  if (!validPort || !local && !ci) throw new Error('PG proxy requires an owned disposable local or CI target');
}

/** Owns exactly one plaintext client connection; its listener is always loopback. */
export async function startPgCommitAckLossProxy(upstream: CommitAckLossTarget) {
  validateCommitAckLossTarget(upstream);
  const frames = new CommitAckLossFrames();
  const sockets = new Set<Socket>();
  let accepted = false;
  let connectionCut = false;
  const server = createServer(client => {
    if (accepted) { client.destroy(); return; }
    accepted = true;
    const remote = createConnection({ host: upstream.host.replace(/^\[|\]$/gu, ''), port: upstream.port });
    sockets.add(client); sockets.add(remote);
    const destroy = () => { client.destroy(); remote.destroy(); };
    for (const socket of [client, remote]) {
      socket.setTimeout(30000, destroy);
      socket.on('error', destroy);
      socket.once('close', () => { sockets.delete(socket); destroy(); });
    }
    client.on('data', chunk => {
      try { for (const frame of frames.frontendBytes(chunk)) if (!remote.write(frame)) { client.pause(); remote.once('drain', () => client.resume()); } }
      catch { destroy(); }
    });
    remote.on('data', chunk => {
      try {
        const result = frames.backendBytes(chunk);
        for (const frame of result.forward) if (!client.write(frame)) { remote.pause(); client.once('drain', () => remote.resume()); }
        if (result.disconnect) { connectionCut = true; destroy(); }
      } catch { destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error('PG proxy listen failed'))); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PG proxy address unavailable');
  return {
    host: '127.0.0.1' as const, port: address.port,
    evidence: (): CommitAckLossEvidence => ({ ...frames.evidence(), connectionCut }),
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PG proxy close deadline')), 5000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
