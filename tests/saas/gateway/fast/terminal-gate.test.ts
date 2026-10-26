import assert from 'node:assert/strict';
import test from 'node:test';
import { FastTerminalGate } from '../../../../src/saas/gateway/fast/terminal-gate.js';
import type { PreparedEvidenceClientStream } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
function sink() {
  const chunks: Buffer[] = []; let ended = false;
  const client: PreparedEvidenceClientStream = {
    signal: new AbortController().signal, start() {}, write(v) { chunks.push(Buffer.from(v)); },
    end() { ended = true; }, abort() {},
  };
  return { client, text: () => Buffer.concat(chunks).toString(), ended: () => ended };
}
test('JSON terminal byte is unavailable until durable completion barrier', async () => {
  const s = sink(); const gate = new FastTerminalGate(s.client, false);
  await gate.write(Buffer.from('{"a":1}'));
  assert.equal(s.text(), '{"a":1'); assert.equal(s.ended(), false);
  await gate.finish(); assert.equal(s.text(), '{"a":1}'); assert.equal(s.ended(), true);
});
test('SSE forwards complete token events but retains fragmented terminal DONE and trailing bytes', async () => {
  const s = sink(); const gate = new FastTerminalGate(s.client, true);
  const first = 'data: {"delta":"你好"}\n\n';
  const b = Buffer.from(first); await gate.write(b.subarray(0, 19)); await gate.write(b.subarray(19));
  assert.equal(s.text(), first);
  await gate.write(Buffer.from('data: [DO')); await gate.write(Buffer.from('NE]\n\n'));
  await gate.write(Buffer.from('\n'));
  assert.equal(s.text(), first); assert.equal(s.ended(), false);
  await gate.finish(); assert.equal(s.text(), `${first}data: [DONE]\n\n\n`);
});
test('CRLF framing and unterminated trailing event stay bounded', async () => {
  const s = sink(); const gate = new FastTerminalGate(s.client, true, 64);
  await gate.write(Buffer.from('data: x\r\n\r\ndata: [DONE]\r\n\r\n'));
  assert.equal(s.text(), 'data: x\r\n\r\n');
  await gate.finish(); assert.equal(s.text(), 'data: x\r\n\r\ndata: [DONE]\r\n\r\n');
  const bad = new FastTerminalGate(sink().client, true, 8);
  await assert.rejects(() => bad.write(Buffer.from('data: an unterminated long event')), /exceeded/);
});
