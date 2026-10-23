import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { test } from 'node:test';
import { Agent } from 'undici';
import { WebSocketServer } from 'ws';
import { prepareCodexNativeWsConnector, CODEX_NATIVE_WS_BETA, CODEX_NATIVE_WS_ENDPOINT } from '../../../../src/saas/gateway/codex/native-ws-connector.js';
import { createCodexNativeWsSessionHandle } from '../../../../src/saas/gateway/codex/native-ws-session.js';
import { CodexNativeWsPreparedEvidenceTransport } from '../../../../src/saas/gateway/codex/native-ws-transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';

/** Real local I/O through a trusted DI connector; no production DNS/proxy/backend acceptance claim. */
test('native fixed-host WS uses verified TLS and Undici dispatcher for two rounds, SSE usage and socket cleanup', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-native-ws-owned-ca-'));
  const keyPath = join(directory, 'synthetic-key.pem');
  const certPath = join(directory, 'synthetic-cert.pem');
  let transport: CodexNativeWsPreparedEvidenceTransport | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let wss: WebSocketServer | undefined;
  try {
    // Generated only inside the disposable test directory; never printed or checked into the repository.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    server = createServer({ key, cert });
    wss = new WebSocketServer({ server });
    let connections = 0, rounds = 0, connectorClosed = 0;
    wss.on('connection', (socket, request) => {
      connections++;
      assert.equal(request.url, '/backend-api/codex/responses');
      assert.equal(request.headers.host, 'chatgpt.com');
      assert.equal(request.headers['openai-beta'], CODEX_NATIVE_WS_BETA);
      assert.equal(request.headers.authorization, 'Bearer synthetic-local-only');
      socket.on('message', (bytes) => {
        const frame = JSON.parse(bytes.toString());
        assert.equal(frame.type, 'response.create');
        assert.equal(frame.model, 'synthetic-model');
        rounds++;
        const id = `local-response-${rounds}`;
        if (frame.input === 'disconnect') { socket.send(JSON.stringify({ type: 'response.created', response: { id } }), () => socket.terminate()); return; }
        socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: `round-${rounds}` }));
        socket.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2 } } }));
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const handle = createCodexNativeWsSessionHandle();
    const connector = await prepareCodexNativeWsConnector({
      signal: new AbortController().signal, timeoutMs: 5000, profile: {},
      // Policy still sees a public fixed backend address. Only this trusted test factory redirects the socket.
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      createConnector(input) {
        assert.equal(input.hostname, 'chatgpt.com'); assert.equal(input.port, 443);
        const dispatcher = new Agent({ connect(_options, callback) {
          const socket = connect({ host: '127.0.0.1', port, servername: 'chatgpt.com', ca: cert, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
          const failed = (error: Error) => callback(error, null);
          socket.once('error', failed);
          socket.once('secureConnect', () => { socket.removeListener('error', failed); assert.equal(socket.authorized, true); callback(null, socket); });
        } });
        return { dispatcher, async close() { connectorClosed++; await dispatcher.close(); }, async destroy(error) { connectorClosed++; await dispatcher.destroy(error); } };
      },
    });
    const identity = { tenantId: 'tenant', projectId: 'project', proxyKeyId: 'key', providerId: 'openai-codex', productId: 'codex-chatgpt', accountId: 'account', credentialId: 'credential', credentialVersion: '1', credentialAuthzVersion: '1', publicModel: 'synthetic-model', model: 'synthetic-model', endpoint: CODEX_NATIVE_WS_ENDPOINT, egressIdentity: connector.egressIdentity };
    transport = new CodexNativeWsPreparedEvidenceTransport({ maxFrameBytes: 10000, maxQueueBytes: 40000, timeoutMs: 5000, withAuthorizedContext: async (_input, use) => use({ identity, connector, headers: { authorization: 'Bearer synthetic-local-only', 'openai-beta': CODEX_NATIVE_WS_BETA } }) });
    for (let round = 0; round < 2; round++) {
      const payloadBytes = Buffer.from(JSON.stringify({ model: identity.model, input: `round-${round}` }));
      const input = { tenantId: identity.tenantId, projectId: identity.projectId, attemptId: `attempt-${round}`, signal: new AbortController().signal, codexNativeWsSession: handle, payloadBytes, evidence: { status: 'claimed', claimedAttemptId: `attempt-${round}`, payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'), publicModel: identity.publicModel, resolvedModel: identity.model, providerOperation: 'responses', providerId: identity.providerId, productId: identity.productId, accountId: identity.accountId, credentialId: identity.credentialId, credentialVersion: identity.credentialVersion } } as unknown as PreparedEvidenceTransportRequest;
      const response = await transport.send(input);
      const reader = response.body!.getReader(); let body = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value); }
      assert.match(body, /data: .*response.completed/);
      assert.equal(response.usageEvidence?.completeness, 'complete');
      assert.notEqual(response.providerUsage, null);
    }
    assert.equal(connections, 1); assert.equal(rounds, 2);
    const disconnectedPayload = Buffer.from(JSON.stringify({ model: identity.model, input: 'disconnect' }));
    const disconnectedInput = { tenantId: identity.tenantId, projectId: identity.projectId, attemptId: 'attempt-disconnect', signal: new AbortController().signal, codexNativeWsSession: handle, payloadBytes: disconnectedPayload, evidence: { status: 'claimed', claimedAttemptId: 'attempt-disconnect', payloadSha256: createHash('sha256').update(disconnectedPayload).digest('hex'), publicModel: identity.publicModel, resolvedModel: identity.model, providerOperation: 'responses', providerId: identity.providerId, productId: identity.productId, accountId: identity.accountId, credentialId: identity.credentialId, credentialVersion: identity.credentialVersion } } as unknown as PreparedEvidenceTransportRequest;
    const disconnected = await transport.send(disconnectedInput);
    await assert.rejects(async () => { const reader = disconnected.body!.getReader(); while (!(await reader.read()).done) {} }, /before terminal usage/);
    assert.equal(rounds, 3); assert.equal(connections, 1, 'write-time disconnect must never redial/replay');
    assert.equal(disconnected.usageEvidence?.completeness, 'incomplete-truncated');
    await transport.close();
    assert.equal(connectorClosed, 1);
  } finally {
    await transport?.close();
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => { if (wss) wss.close(() => resolve()); else resolve(); });
    await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
    await rm(directory, { recursive: true, force: true });
  }
});
