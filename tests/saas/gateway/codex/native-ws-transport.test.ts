import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CodexNativeWsPreparedEvidenceTransport } from '../../../../src/saas/gateway/codex/native-ws-transport.js';
import { createCodexNativeWsSessionHandle, codexNativeWsSession, isCodexNativeWsSessionHandle, type CodexNativeWsSocket } from '../../../../src/saas/gateway/codex/native-ws-session.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
class Socket implements CodexNativeWsSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  messages = new Set<(data: string) => void>();
  closes = new Set<() => void>();
  closed = 0;
  send(data: string) { this.sent.push(data); }
  close() { this.closed++; for (const listener of this.closes) listener(); }
  onMessage(listener: (data: string) => void) { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: () => void) { this.closes.add(listener); return () => this.closes.delete(listener); }
  emit(event: unknown) { for (const listener of this.messages) listener(JSON.stringify(event)); }
}
function fixture(maxQueueBytes = 10000) {
  const socket = new Socket();
  const handle = createCodexNativeWsSessionHandle();
  const controller = new AbortController();
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'model', input: 'hello', stream: true }));
  const request = { tenantId: 'tenant', projectId: 'project', requestId: 'request', attemptId: 'attempt', signal: controller.signal, codexNativeWsSession: handle, payloadBytes, evidence: { status: 'claimed', claimedAttemptId: 'attempt', payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'), publicModel: 'model', resolvedModel: 'model', providerOperation: 'responses', providerId: 'openai-codex', productId: 'codex-chatgpt', accountId: 'account', credentialId: 'credential', credentialVersion: '1' } } as unknown as PreparedEvidenceTransportRequest;
  let contexts = 0, opens = 0;
  const identity = { tenantId: 'tenant', projectId: 'project', proxyKeyId: 'key', providerId: 'openai-codex', productId: 'codex-chatgpt', accountId: 'account', credentialId: 'credential', credentialVersion: '1', credentialAuthzVersion: '1', publicModel: 'model', model: 'model', endpoint: 'wss://chatgpt.com/backend-api/codex/responses', egressIdentity: 'egress' };
  const transport = new CodexNativeWsPreparedEvidenceTransport({ maxFrameBytes: Math.min(2000, maxQueueBytes), maxQueueBytes, timeoutMs: 1000, async withAuthorizedContext(_input, use) { contexts++; return use({ identity, headers: {}, connector: { egressIdentity: 'egress', async open() { opens++; return { socket, async close() { socket.close(); } }; } } }); } });
  return { socket, handle, controller, request, transport, identity, get contexts() { return contexts; }, get opens() { return opens; } };
}
async function drain(body: ReadableStream<Uint8Array>) { const reader = body.getReader(); let text = ''; while (true) { const item = await reader.read(); if (item.done) return text; text += new TextDecoder().decode(item.value); } }
function terminal(socket: Socket, id = 'response', status = 'completed') { socket.emit({ type: 'response.created', response: { id } }); socket.emit({ type: `response.${status}`, response: { id, status, usage: { input_tokens: 3, output_tokens: 2 } } }); }

test('native WS sends top-level create and reuses socket with fresh authorization, cleanup keeps idle generation alive', async () => {
  const f = fixture();
  const first = await f.transport.send(f.request);
  assert.deepEqual(JSON.parse(f.socket.sent[0]!), { type: 'response.create', model: 'model', input: 'hello', stream: true });
  terminal(f.socket);
  assert.match(await drain(first.body!), /response.completed/);
  assert.equal(first.usageEvidence?.completeness, 'complete');
  assert.notEqual(first.providerUsage, null);
  f.controller.abort();
  assert.equal(f.socket.closed, 0, 'finished-round abort listener must not close idle socket');
  const second = await f.transport.send({ ...f.request, signal: new AbortController().signal });
  terminal(f.socket, 'response-2', 'incomplete');
  await drain(second.body!);
  assert.equal(f.opens, 1);
  assert.equal(f.contexts, 2, 'each round reauthorizes despite connection reuse');
  await codexNativeWsSession(f.handle).close();
});
test('native WS unknown close after write is not replayed and cancel only names observed response', async () => {
  const f = fixture();
  const response = await f.transport.send(f.request);
  f.socket.emit({ type: 'response.created', response: { id: 'known-response' } });
  f.controller.abort();
  await assert.rejects(drain(response.body!));
  assert.equal(f.socket.sent.filter((frame) => JSON.parse(frame).type === 'response.create').length, 1);
  assert.deepEqual(JSON.parse(f.socket.sent[1]!), { type: 'response.cancel', response_id: 'known-response' });
});
test('native WS bounds application queue and frame sizes; overflow is unknown', async () => {
  const f = fixture(300);
  const response = await f.transport.send(f.request);
  f.socket.emit({ type: 'response.created', response: { id: 'response' } });
  f.socket.emit({ type: 'response.output_text.delta', delta: 'x'.repeat(400) });
  await assert.rejects(drain(response.body!), /limit exceeded/);
  assert.equal(response.usageEvidence?.completeness, 'incomplete-oversized');
});
test('native WS rejects forged handle and account changes; old generation reference cannot create a new session', async () => {
  assert.equal(isCodexNativeWsSessionHandle({}), false);
  const f = fixture();
  const response = await f.transport.send(f.request); terminal(f.socket); await drain(response.body!);
  f.identity.egressIdentity = 'changed-egress';
  await assert.rejects(f.transport.send({ ...f.request, signal: new AbortController().signal }), /binding mismatch/);
  const fresh = createCodexNativeWsSessionHandle();
  await assert.rejects(codexNativeWsSession(fresh).begin(f.identity, 'response', async () => { throw new Error('must not dial'); }), /resend full context/);
  await codexNativeWsSession(f.handle).close();
});

test('native WS only accepts a previous response from the same live generation', async () => {
  const f = fixture();
  const first = await f.transport.send(f.request); terminal(f.socket); await drain(first.body!);
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'model', input: 'next', previous_response_id: 'response' }));
  const second = await f.transport.send({ ...f.request, signal: new AbortController().signal, payloadBytes, evidence: { ...f.request.evidence, payloadSha256: createHash('sha256').update(payloadBytes).digest('hex') } });
  assert.equal(JSON.parse(f.socket.sent[1]!).previous_response_id, 'response');
  terminal(f.socket, 'second-response', 'failed'); await drain(second.body!);
  assert.equal(second.usageEvidence?.completeness, 'complete');
  assert.notEqual(second.providerUsage, null);
  await f.transport.close();
});
test('native WS missing usage stays incomplete and no response id means no cancel frame', async () => {
  const f = fixture();
  const first = await f.transport.send(f.request);
  f.socket.emit({ type: 'response.created', response: { id: 'response' } });
  f.socket.emit({ type: 'response.completed', response: { id: 'response', status: 'completed' } });
  await drain(first.body!);
  assert.equal(first.providerUsage, null);
  assert.equal(first.usageEvidence?.completeness, 'incomplete-missing');
  await f.transport.close();
  const unknown = fixture();
  const response = await unknown.transport.send(unknown.request);
  unknown.controller.abort();
  await assert.rejects(drain(response.body!));
  assert.equal(unknown.socket.sent.length, 1, 'never cancel an unobserved response id');
});
test('native WS rejects concurrent rounds without resending and closes all live sessions on shutdown', async () => {
  const f = fixture();
  const first = await f.transport.send(f.request);
  await assert.rejects(f.transport.send(f.request), /connection is unavailable/);
  assert.equal(f.socket.sent.length, 1);
  await f.transport.close();
  await assert.rejects(drain(first.body!));
  assert.equal(f.socket.closed, 1);
});
