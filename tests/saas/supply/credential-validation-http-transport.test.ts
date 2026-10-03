import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPinnedProviderLookup,
  createProviderHttpTestAddressCapability,
} from '../../../src/saas/gateway/provider-http-address.js';
import {
  CredentialValidationHttpTransport,
  CredentialValidationTransportError,
} from '../../../src/saas/supply/credential-validation-http-transport.js';
import {
  compileApprovedCredentialValidationTargets,
  resolveApprovedCredentialValidationTarget,
} from '../../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';
import { approvedTarget, customJob, probeEnvelope, validationHttpsFixture, waitForValidationFixtureSignal } from './credential-validation-test-fixture.js';

function binding(target: ApprovedCredentialValidationTarget) {
  const resolved = resolveApprovedCredentialValidationTarget(compileApprovedCredentialValidationTargets([target]), customJob(target));
  assert.ok(resolved);
  return resolved;
}

test('custom Chat and Messages use real pinned HTTPS, exact auth/profile, truthful identity and body-only slash models', async (t) => {
  const requests: Array<{ url?: string; method?: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const local = await validationHttpsFixture(t, (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, method: request.method, headers: request.headers, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(probeEnvelope(request.url?.endsWith('/messages') ? 'messages' : 'chat')));
    });
  });
  const transport = new CredentialValidationHttpTransport(local.testOptions);
  t.after(() => transport.close());
  for (const kind of ['chat', 'messages'] as const) {
    const target = approvedTarget({ baseUrl: local.baseUrl, ...(kind === 'messages' ? {
      productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible',
      authProfile: 'anthropic-api-key-2023-06-01',
    } as const : {}) });
    let rechecks = 0;
    const result = await transport.probe(await transport.prepare(binding(target)), Buffer.from('fixture-api-key?body-not-query'), async () => { rechecks += 1; });
    assert.equal(result.state, 'verified');
    assert.equal(rechecks, 1);
    const request = requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, kind === 'chat' ? '/v1/chat/completions' : '/v1/messages');
    assert.equal(request.headers['user-agent'], 'model-router');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-api-key'], kind === 'messages' ? 'fixture-api-key?body-not-query' : undefined);
    assert.equal(request.headers.authorization, kind === 'chat' ? 'Bearer fixture-api-key?body-not-query' : undefined);
    assert.equal(request.headers['anthropic-version'], kind === 'messages' ? '2023-06-01' : undefined);
    assert.deepEqual(request.body, { model: 'organisation/model-v1', max_tokens: 8, stream: false,
      messages: [{ role: 'user', content: 'Reply with OK.' }] });
    assert.equal(JSON.stringify(result).includes('fixture-api-key'), false);
    assert.equal(JSON.stringify(result).includes('organisation/model-v1'), false);
    assert.equal(JSON.stringify(result).includes('OK'), false);
  }
  assert.equal(requests.length, 2);
});

test('custom response validation rejects HTTP/error/malformed/unsafe/overlarge/truncated bodies without disclosing them', async (t) => {
  let status = 200;
  let contentType = 'application/json';
  let wire: string | Buffer = '';
  let declared: string | undefined;
  let truncate = false;
  let requestCount = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume();
    requestCount += 1;
    response.writeHead(status, { 'content-type': contentType, ...(declared ? { 'content-length': declared } : {}),
      location: 'http://169.254.169.254/latest/meta-data/?secret=fixture-api-key' });
    if (truncate) {
      response.write(wire.slice(0, 20));
      setImmediate(() => response.destroy());
    } else response.end(wire);
  });
  const transport = new CredentialValidationHttpTransport({ ...local.testOptions, timeoutMs: 500 });
  t.after(() => transport.close());
  const target = binding(approvedTarget({ baseUrl: local.baseUrl }));
  const chat = probeEnvelope('chat');
  const cases = [
    { body: '<html>fixture-api-key provider-secret-body</html>', code: 'provider_response_invalid' },
    { body: '{}', code: 'provider_response_invalid' },
    { body: JSON.stringify({ ...chat, usage: undefined }), code: 'provider_response_invalid' },
    { body: Buffer.from([0xff]), code: 'provider_response_invalid' },
    { body: '', status: 204, code: 'provider_response_invalid' },
    { body: JSON.stringify({ error: { message: 'fixture-api-key provider-secret-body' } }), code: 'provider_response_invalid' },
    { body: JSON.stringify(chat).slice(0, -1), code: 'provider_response_invalid' },
    { body: `${JSON.stringify(chat)} trailing`, code: 'provider_response_invalid' },
    { body: JSON.stringify({ ...chat, usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }), code: 'provider_response_invalid' },
    { body: JSON.stringify({ ...chat, usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 7 } }), code: 'provider_response_invalid' },
    { body: JSON.stringify({ ...chat, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: ['stop'] }] }), code: 'provider_response_invalid' },
    { body: JSON.stringify({ ...chat, usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: 0 } }), code: 'provider_response_invalid' },
    { body: JSON.stringify(chat), mime: 'text/html', code: 'provider_response_invalid' },
    { body: 'x'.repeat(4_097), code: 'provider_response_too_large' },
    { body: JSON.stringify(chat), length: '4097', code: 'provider_response_too_large' },
    { body: JSON.stringify(chat), status: 307, code: 'provider_redirect_rejected' },
    { body: 'fixture-api-key provider-secret-body', status: 401, code: 'credential_rejected' },
    { body: 'fixture-api-key provider-secret-body', status: 429, code: 'provider_rate_limited' },
    { body: 'fixture-api-key provider-secret-body', status: 503, code: 'provider_unavailable' },
    { body: JSON.stringify(chat), truncate: true, code: 'provider_network_error' },
  ];
  for (const item of cases) {
    wire = item.body; status = item.status ?? 200; contentType = item.mime ?? 'application/json';
    declared = item.length; truncate = item.truncate ?? false;
    const result = await transport.probe(await transport.prepare(target), Buffer.from('fixture-api-key'), async () => {});
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('expected bounded validation failure');
    assert.equal(result.errorCode, item.code);
    assert.equal(JSON.stringify(result).includes('fixture-api-key'), false);
    assert.equal(JSON.stringify(result).includes('provider-secret-body'), false);
    assert.equal(JSON.stringify(result).includes('169.254.169.254'), false);
  }
  assert.equal(requestCount, cases.length, 'redirects must not redispatch');
  const anthropic = binding(approvedTarget({ baseUrl: local.baseUrl, productId: 'custom-anthropic', endpoint: 'messages',
    protocol: 'anthropic-compatible', authProfile: 'anthropic-api-key-2023-06-01' }));
  for (const malformed of [JSON.stringify(probeEnvelope('messages')).slice(0, -1),
    JSON.stringify({ ...probeEnvelope('messages'), usage: undefined }),
    JSON.stringify({ ...probeEnvelope('messages'), usage: { input_tokens: 5, output_tokens: -1 } })]) {
    wire = malformed; status = 200; truncate = false; declared = undefined;
    assert.equal((await transport.probe(await transport.prepare(anthropic), Buffer.from('fixture-api-key'), async () => {})).state, 'failed');
  }
});

test('custom verification waits for real body EOF; deadline and close cannot turn a complete prefix into success', async (t) => {
  let activeResponse: ServerResponse | undefined;
  let announce!: () => void;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume(); activeResponse = response;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify(probeEnvelope('chat')));
    announce();
  });
  const target = binding(approvedTarget({ baseUrl: local.baseUrl }));
  const transport = new CredentialValidationHttpTransport({ ...local.testOptions, timeoutMs: 500 });
  t.after(async () => { activeResponse?.destroy(); await transport.close(); });
  let waiting = new Promise<void>((resolve) => { announce = resolve; });
  let completed = false;
  const pending = transport.probe(await transport.prepare(target), Buffer.from('fixture-api-key'), async () => {})
    .then((result) => { completed = true; return result; });
  await waitForValidationFixtureSignal(waiting, pending); await delay(20);
  assert.equal(completed, false);
  activeResponse?.end();
  assert.equal((await pending).state, 'verified');
  waiting = new Promise<void>((resolve) => { announce = resolve; });
  const timeout = transport.probe(await transport.prepare(target), Buffer.from('fixture-api-key'), async () => {});
  await waitForValidationFixtureSignal(waiting, timeout);
  const timedOut = await timeout;
  assert.equal(timedOut.state, 'failed');
  if (timedOut.state !== 'failed') throw new Error('expected deadline failure');
  assert.equal(timedOut.errorCode, 'provider_timeout');
  waiting = new Promise<void>((resolve) => { announce = resolve; });
  const cancelled = transport.probe(await transport.prepare(target), Buffer.from('fixture-api-key'), async () => {});
  const rejected = assert.rejects(cancelled, (error: unknown) => error instanceof CredentialValidationTransportError &&
    error.code === 'validation_transport_closed');
  await waitForValidationFixtureSignal(waiting, rejected);
  assert.equal(transport.close(), transport.close(), 'close is idempotent');
  await rejected;
  await assert.rejects(transport.prepare(target), CredentialValidationTransportError);
});

test('public DNS policy rejects every private/reserved/mixed answer and pins without a second lookup', async (t) => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  const capability = createProviderHttpTestAddressCapability('-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----');
  const target = binding(approvedTarget());
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '168.63.129.16', '100.64.0.1',
    '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    const transport = new CredentialValidationHttpTransport({ addressCapability: capability,
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
    await assert.rejects(transport.prepare(target), (error: unknown) => error instanceof CredentialValidationTransportError &&
      error.code === 'provider_address_rejected');
    await transport.close();
  }
  let lookups = 0;
  const transport = new CredentialValidationHttpTransport({ addressCapability: capability,
    resolveAddresses: async () => { lookups += 1; return [{ address: '8.8.8.8', family: 4 }]; } });
  const plan = await transport.prepare(target);
  assert.equal(lookups, 1);
  const lookup = createPinnedProviderLookup('validation.example', { address: '8.8.8.8', family: 4 });
  lookup('validation.example', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  lookup('other.example', {}, (error) => assert.ok(error));
  await transport.release(plan);
  await transport.close();
  const production = new CredentialValidationHttpTransport();
  await assert.rejects(production.prepare(binding(approvedTarget({ baseUrl: 'https://127.0.0.1/v1/' }))), CredentialValidationTransportError);
  await production.close();
});

test('DNS deadline/close reject late resolution, and test DNS/CA overrides cannot be installed in production', async (t) => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  const capability = createProviderHttpTestAddressCapability('-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----');
  const target = binding(approvedTarget());
  const timed = new CredentialValidationHttpTransport({ addressCapability: capability, timeoutMs: 20,
    resolveAddresses: async () => new Promise(() => {}) });
  await assert.rejects(timed.prepare(target), (error: unknown) => error instanceof CredentialValidationTransportError && error.code === 'provider_timeout');
  await timed.close();
  let finish!: (answers: Array<{ address: string; family: 4 }>) => void;
  const resolver = new Promise<Array<{ address: string; family: 4 }>>((resolve) => { finish = resolve; });
  const closing = new CredentialValidationHttpTransport({ addressCapability: capability, resolveAddresses: async () => resolver });
  const pending = closing.prepare(target);
  const rejected = assert.rejects(pending, CredentialValidationTransportError);
  await closing.close();
  await rejected;
  finish([{ address: '8.8.8.8', family: 4 }]);
  process.env.NODE_ENV = 'production';
  assert.throws(() => new CredentialValidationHttpTransport({ addressCapability: capability }), TypeError);
});

test('authority rejection blocks dispatch and wrong TLS trust cannot verify credentials', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume(); requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(probeEnvelope('chat')));
  });
  const target = binding(approvedTarget({ baseUrl: local.baseUrl }));
  const transport = new CredentialValidationHttpTransport(local.testOptions);
  t.after(() => transport.close());
  const denied = new Error('authority-rejected');
  await assert.rejects(transport.probe(await transport.prepare(target), Buffer.from('fixture-api-key'), async () => { throw denied; }),
    (error: unknown) => error === denied);
  assert.equal(requests, 0);
  const other = await validationHttpsFixture(t, (_request, response) => response.end());
  const wrongTrust = new CredentialValidationHttpTransport(other.testOptions);
  t.after(() => wrongTrust.close());
  const result = await wrongTrust.probe(await wrongTrust.prepare(target), Buffer.from('fixture-api-key'), async () => {});
  assert.equal(result.state, 'failed');
  assert.equal(requests, 0, 'untrusted TLS must fail before HTTP/auth headers reach the server');
});
