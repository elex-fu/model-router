import type { PreparedEvidenceClientStream } from '../prepared-evidence-dispatch-service.js';

/**
 * Holds the terminal SSE event (including fragmented DONE) or the last JSON
 * byte. Content-Length cannot announce completion before evidence ownership:
 * durable receipt ACK by default, bounded queue acceptance in explicit memory mode. Earlier complete SSE events flow without a whole-body buffer.
 */
export class FastTerminalGate {
  private pending = Buffer.alloc(0);
  private terminal = false;
  constructor(
    private readonly client: PreparedEvidenceClientStream,
    private readonly sse: boolean,
    private readonly maximumPendingBytes = 128 * 1024,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.sse) {
      if (this.pending.length > 1) {
        await this.client.write(this.pending.subarray(0, -1));
        this.pending = Buffer.from(this.pending.subarray(-1));
      }
      return;
    }
    if (!this.terminal) {
      for (;;) {
        const lf = this.pending.indexOf('\n\n');
        const crlf = this.pending.indexOf('\r\n\r\n');
        if (lf < 0 && crlf < 0) break;
        const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf + 2;
        const event = this.pending.subarray(0, end);
        if (/^data:\s*\[DONE\]\s*$/m.test(event.toString('utf8'))) {
          this.terminal = true;
          break;
        }
        await this.client.write(event);
        this.pending = Buffer.from(this.pending.subarray(end));
      }
    }
    if (this.pending.byteLength > this.maximumPendingBytes) throw new Error('Fast response terminal buffer exceeded');
  }
  /** Called only after durable ACK or explicit memory-queue ownership; never before handoff. */
  async finish(): Promise<void> {
    if (this.pending.byteLength) await this.client.write(this.pending);
    this.pending = Buffer.alloc(0);
    await this.client.end();
  }
}
