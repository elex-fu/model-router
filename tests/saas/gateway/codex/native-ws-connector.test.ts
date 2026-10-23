import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_NATIVE_WS_ENDPOINT, prepareCodexNativeWsConnector } from '../../../../src/saas/gateway/codex/native-ws-connector.js';

test('native WS connector pins fixed backend and proxy with existing HTTP address policy', async () => {
  const calls: string[] = [];
  const prepared = await prepareCodexNativeWsConnector({ signal: new AbortController().signal, timeoutMs: 1000, profile: { egressProxy: { url: 'http://user:synthetic@proxy.example:8080' } }, async resolveAddresses(host) { calls.push(host); return [{ address: '93.184.216.34', family: 4 }]; } });
  assert.equal(CODEX_NATIVE_WS_ENDPOINT, 'wss://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(calls, ['chatgpt.com', 'proxy.example']);
  assert.match(prepared.egressIdentity, /^[0-9a-f]{64}$/);
  assert.equal(prepared.egressIdentity.includes('synthetic'), false);
  const changed = await prepareCodexNativeWsConnector({ signal: new AbortController().signal, timeoutMs: 1000, profile: { egressProxy: { url: 'http://user:rotated@proxy.example:8080' } }, async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; } });
  assert.notEqual(changed.egressIdentity, prepared.egressIdentity, 'proxy credential generation is part of connection pin');
});
test('native WS connector rejects private targets and unassembled TLS fingerprint faces', async () => {
  await assert.rejects(prepareCodexNativeWsConnector({ signal: new AbortController().signal, timeoutMs: 1000, profile: {}, async resolveAddresses() { return [{ address: '127.0.0.1', family: 4 }]; } }));
  await assert.rejects(prepareCodexNativeWsConnector({ signal: new AbortController().signal, timeoutMs: 1000, profile: { tlsFingerprint: { selector: 'default' } }, async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; } }), /TLS profile connector unavailable/);
});
