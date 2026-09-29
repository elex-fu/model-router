import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { configV2Schema } from '../../src/config/v2-schema.js';
import { ConfigServiceV2 } from '../../src/config/v2-service.js';

test('published V2 example parses and passes service validation with explicit local HTTP opt-in', async () => {
  const example = JSON.parse(
    readFileSync(new URL('../../docs/examples/model-router-console-v2.example.json', import.meta.url), 'utf8'),
  );
  const parsed = configV2Schema.safeParse(example);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  if (!parsed.success) return;
  assert.ok(parsed.data.upstreams.some((upstream) => upstream.provider === 'kimi'));
  assert.ok(parsed.data.upstreams.some((upstream) => upstream.provider === 'deepseek'));
  const ollama = parsed.data.upstreams.find((upstream) => upstream.id === 'up_ollama_local');
  assert.ok(ollama);
  assert.equal(ollama.auth.mode, 'none');
  assert.equal(ollama.policy.allowInsecureHttp, true);

  const envNames = new Set(
    parsed.data.upstreams.flatMap((upstream) =>
      upstream.credentials
        .filter((credential) => credential.secret.type === 'env')
        .map((credential) => (credential.secret.type === 'env' ? credential.secret.name : '')),
    ),
  );
  const previous = new Map([...envNames].map((name) => [name, process.env[name]]));
  try {
    for (const name of envNames) process.env[name] = 'example-test-secret';
    const service = new ConfigServiceV2('/unused/model-router-example.json');
    const result = await service.validate(parsed.data);
    assert.equal(result.valid, true, JSON.stringify(result.errors));

    const withoutOptIn = structuredClone(parsed.data);
    delete withoutOptIn.upstreams.find((upstream) => upstream.id === 'up_ollama_local')!.policy.allowInsecureHttp;
    const rejected = await service.validate(withoutOptIn);
    assert.equal(rejected.valid, false);
    assert.ok(rejected.errors.some((issue) => issue.code === 'insecure_http_requires_opt_in'));

    const remoteHttp = structuredClone(parsed.data);
    remoteHttp.upstreams.find((upstream) => upstream.id === 'up_ollama_local')!.baseUrl = 'http://example.com/v1';
    const remoteRejected = await service.validate(remoteHttp);
    assert.equal(remoteRejected.valid, false);
    assert.ok(remoteRejected.errors.some((issue) => issue.code === 'insecure_http_public_host'));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
