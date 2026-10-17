import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasGatewayAsyncImageMediaPort } from '../../../../src/saas/gateway/images/async-image-media-port.js';
import { ImageResultOffloader } from '../../../../src/saas/gateway/images/image-result-offloader.js';
import {
  imageTaskErrorEnvelope,
  SaasImageTaskService,
} from '../../../../src/saas/gateway/images/image-task-service.js';
import { IMAGE_TASK_ID_PATTERN, InMemoryImageTaskStore } from '../../../../src/saas/gateway/images/image-task-store.js';
import { SaasGatewayImagesQueryPort } from '../../../../src/saas/gateway/images/images-query-port.js';
import {
  createImagesMediaUsageExtractor,
  createImagesMediaUsagePlan,
  requestImageSizeTier,
  requestServiceTier,
} from '../../../../src/saas/gateway/images/media-usage-plan.js';
import { RecordingClientStream } from '../../../../src/saas/gateway/images/recording-client-stream.js';
import { observeProviderJsonUsage } from '../../../../src/saas/gateway/provider-json-usage-observer.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

/**
 * Batch 4 §4.2 (task #16): the images media usage plan (output-first tier
 * normalization + service-tier extraction), the recording client stream's
 * explicit ceiling, the offloader's rewrite contract, the task lifecycle and
 * the ownership-scoped query port.
 */

function pngB64(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

function responseWith(items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { object: 'list', data: items, ...extra };
}

test('4.2: the extractor reports units and the output-first size tier', () => {
  const extractor = createImagesMediaUsageExtractor({ requestSizeTier: null });
  // Two 1024×768 images: units 2, tier 1k from the decoded dimensions.
  const usage = extractor.extract(responseWith([{ b64_json: pngB64(1024, 768) }, { b64_json: pngB64(512, 512) }]));
  assert.ok(usage);
  assert.equal(usage.units, 2);
  assert.equal(usage.sizeTier, '1k');
  assert.equal(usage.billingMode, 'image');
  assert.equal(usage.inputTotal, null);
  assert.equal(usage.status, 'reported');

  // A 2048-wide image upgrades the observed tier past the request's default.
  const upgraded = extractor.extract(responseWith([{ b64_json: pngB64(2048, 1152) }]));
  assert.equal(upgraded?.sizeTier, '4k');
});

test('4.2: tier precedence is output dimensions, response declaration, request size, then 2k', () => {
  // No decodable images: the request's declared size wins.
  const fromRequest = createImagesMediaUsageExtractor({ requestSizeTier: '1k' });
  assert.equal(fromRequest.extract(responseWith([{ url: 'https://provider.example/i.png' }]))?.sizeTier, '1k');

  // A provider-declared tier on the response beats the request size.
  const fromResponse = createImagesMediaUsageExtractor({ requestSizeTier: '1k' });
  assert.equal(
    fromResponse.extract(responseWith([{ url: 'https://provider.example/i.png' }], { size_tier: '4k' }))?.sizeTier,
    '4k',
  );

  // Nothing declared anywhere: the documented 2k default.
  const fallback = createImagesMediaUsageExtractor({ requestSizeTier: null });
  assert.equal(fallback.extract(responseWith([{ url: 'https://provider.example/i.png' }]))?.sizeTier, '2k');

  // Dimensions beat both declarations.
  const dimsWin = createImagesMediaUsageExtractor({ requestSizeTier: '4k' });
  assert.equal(dimsWin.extract(responseWith([{ b64_json: pngB64(1024, 1024) }], { size_tier: '4k' }))?.sizeTier, '1k');
});

test('4.2: the extractor rejects untrusted shapes instead of guessing', () => {
  const extractor = createImagesMediaUsageExtractor({ requestSizeTier: null });
  assert.equal(extractor.extract({ error: { message: 'boom' } }), null);
  assert.equal(extractor.extract({ data: [] }), null);
  assert.equal(extractor.extract({ data: 'nope' }), null);
  assert.equal(extractor.extract({ data: [{ b64_json: '!!!not-base64!!!' }] }), null);
  const tooMany = { data: Array.from({ length: 101 }, () => ({ url: 'https://x/i.png' })) };
  assert.equal(extractor.extract(tooMany), null);
});

test('4.2: the plan factory binds request tier and service tier from the payload', () => {
  const payload = new TextEncoder().encode(
    JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat', n: 3, size: '1536x1024', service_tier: 'priority' }),
  );
  const plan = createImagesMediaUsagePlan({ providerOperation: 'images.generations', payloadBytes: payload });
  assert.ok(plan);
  assert.equal(plan.extractor?.operations.has('images.generations'), true);
  assert.deepEqual(plan.serviceTier, { requested: 'priority', observed: null });

  // Other operations and unparseable payloads get no plan.
  assert.equal(createImagesMediaUsagePlan({ providerOperation: 'chat.completions', payloadBytes: payload }), null);
  assert.equal(
    createImagesMediaUsagePlan({ providerOperation: 'images.generations', payloadBytes: new Uint8Array([0xff]) }),
    null,
  );
  // The plan's extractor settles at the request's tier for URL-only responses.
  const usage = plan.extractor?.extract(responseWith([{ url: 'https://p.example/i.png' }]));
  assert.equal(usage?.units, 1);
  assert.equal(usage?.sizeTier, '2k'); // 1536x1024 → longest edge 1536 → 2k
});

test('4.2: request-side tier and service tier parse helpers', () => {
  assert.equal(requestImageSizeTier({ size: '1024x1024' }), '1k');
  assert.equal(requestImageSizeTier({ size_tier: '4k' }), '4k');
  assert.equal(requestImageSizeTier({}), null);
  assert.equal(requestImageSizeTier({ size: 'weird' }), null);
  assert.equal(requestServiceTier({ service_tier: 'Flex ' }), 'flex');
  assert.equal(requestServiceTier({}), null);
  assert.equal(requestServiceTier({ service_tier: 42 }), null);
});

test('4.2: the JSON observer reports the media usage through the extractor seam', async () => {
  const plan = createImagesMediaUsagePlan({
    providerOperation: 'images.generations',
    payloadBytes: new TextEncoder().encode(JSON.stringify({ model: 'm', prompt: 'p', size: '1024x1024' })),
  });
  assert.ok(plan?.extractor);
  const bodyText = JSON.stringify(responseWith([{ b64_json: pngB64(1024, 1024) }]));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  const observed = observeProviderJsonUsage(
    stream,
    { providerProtocol: 'openai', providerOperation: 'images.generations' },
    plan.extractor,
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of observed.body) chunks.push(chunk);
  const observation = await observed.observation;
  assert.equal(observation.state, 'reported');
  assert.equal(observation.usage?.units, 1);
  assert.equal(observation.usage?.sizeTier, '1k');
  assert.equal(Buffer.concat(chunks).toString('utf8'), bodyText);
});

test('4.2: the recording client stream enforces its explicit byte ceiling', () => {
  const recording = new RecordingClientStream({ maxRecordedBytes: 10 });
  recording.start(200, { 'content-type': 'application/json' });
  recording.write(new Uint8Array(6));
  assert.throws(() => recording.write(new Uint8Array(5)), /buffer ceiling/);
  assert.equal(recording.signal.aborted, true);
  assert.equal(recording.isComplete, false);
  assert.throws(() => recording.recordedBody(), /not complete/);

  const exact = new RecordingClientStream({ maxRecordedBytes: 10 });
  exact.start(null, {});
  exact.write(new Uint8Array(10));
  exact.end();
  assert.equal(exact.isComplete, true);
  assert.equal(exact.recordedStatus, 200);
  assert.equal(exact.recordedBody().byteLength, 10);
});

function fakeStorage(uploads: Array<{ key: string; data: Uint8Array }>, fail = false) {
  return {
    async putObject(input: { key: string; data: Uint8Array }) {
      if (fail) throw new Error('object storage unavailable');
      uploads.push({ key: input.key, data: input.data });
    },
    objectUrlForDownload(key: string) {
      return `https://cdn.example.com/${key}`;
    },
  };
}

test('4.2: the offloader rewrites b64_json payloads to storage links', async () => {
  const uploads: Array<{ key: string; data: Uint8Array }> = [];
  const offloader = new ImageResultOffloader({ storage: fakeStorage(uploads) });
  const result = await offloader.rewrite(
    `imgtask_${'a'.repeat(32)}`,
    JSON.stringify({
      created: 1,
      data: [
        { b64_json: pngB64(64, 64), revised_prompt: 'a cat' },
        { url: 'https://provider.example/already-offloaded.png' },
      ],
    }),
  );
  const parsed = JSON.parse(result);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0]?.key ?? '', /^images\/imgtask_a{32}-0\.png$/);
  assert.equal(parsed.data[0].url, `https://cdn.example.com/${uploads[0]?.key}`);
  assert.equal(parsed.data[0].b64_json, undefined);
  assert.equal(parsed.data[0].revised_prompt, 'a cat');
  // An http(s) URL item is left untouched.
  assert.equal(parsed.data[1].url, 'https://provider.example/already-offloaded.png');
});

test('4.2: offload failure fails the rewrite — the blob is never returned or stored', async () => {
  const offloader = new ImageResultOffloader({ storage: fakeStorage([], true) });
  await assert.rejects(
    offloader.rewrite(`imgtask_${'b'.repeat(32)}`, JSON.stringify(responseWith([{ b64_json: pngB64(8, 8) }]))),
    /upload to object storage failed/,
  );
});

const OWNER = { tenantId: 'tenant-1', proxyKeyId: 'key-1' };

function authenticatedCaller(tenantId = OWNER.tenantId, proxyKeyId = OWNER.proxyKeyId): AuthenticatedApiKey {
  return {
    metadata: { id: proxyKeyId, tenantId, status: 'active', modelScopes: ['public-model'] },
    authorization: { principalId: 'user-1', modelScopes: ['public-model'] },
  } as unknown as AuthenticatedApiKey;
}

test('4.2: the task service lifecycle — create, complete with offload, read, TTL', async () => {
  const uploads: Array<{ key: string; data: Uint8Array }> = [];
  let now = 1_000_000;
  const tasks = new SaasImageTaskService({
    store: new InMemoryImageTaskStore({ now: () => now }),
    offloader: new ImageResultOffloader({ storage: fakeStorage(uploads) }),
    ttlMs: 60_000,
    idFactory: () => `imgtask_${'c'.repeat(32)}`,
    now: () => now,
  });
  const submission = await tasks.createTask(OWNER);
  assert.match(submission.taskId, IMAGE_TASK_ID_PATTERN);
  assert.equal(submission.createdAt, 1000);
  assert.equal(submission.expiresAt, 1060);

  await tasks.completeTask({
    taskId: submission.taskId,
    httpStatus: 200,
    resultJsonText: JSON.stringify(responseWith([{ b64_json: pngB64(64, 64) }])),
  });
  assert.equal(uploads.length, 1);

  const view = await tasks.readTask({ taskId: submission.taskId, ...OWNER });
  assert.ok(view);
  assert.equal(view.status, 'completed');
  assert.equal(view.http_status, 200);
  assert.equal(view.object, 'image.generation.task');
  assert.match(view.image_url ?? '', /^https:\/\/cdn\.example\.com\/images\//);
  assert.equal(view.result?.data?.[0]?.b64_json, undefined);

  // Foreign ownership and bogus ids are indistinguishable from missing.
  assert.equal(await tasks.readTask({ taskId: submission.taskId, tenantId: 'other', proxyKeyId: 'key-1' }), null);
  assert.equal(await tasks.readTask({ taskId: `imgtask_${'d'.repeat(32)}`, ...OWNER }), null);
  assert.equal(await tasks.readTask({ taskId: 'not-a-task-id', ...OWNER }), null);

  // TTL expiry: a read past expires_at is absent.
  now += 61_000; // past the 60 s TTL
  assert.equal(await tasks.readTask({ taskId: submission.taskId, ...OWNER }), null);
});

test('4.2: offload failure settles the task failed, never stores the blob', async () => {
  const now = 1_000_000;
  const store = new InMemoryImageTaskStore({ now: () => now });
  const tasks = new SaasImageTaskService({
    store,
    offloader: new ImageResultOffloader({ storage: fakeStorage([], true) }),
    ttlMs: 60_000,
    idFactory: () => `imgtask_${'e'.repeat(32)}`,
    now: () => now,
  });
  // (the store shares the injected clock)
  const submission = await tasks.createTask(OWNER);
  await assert.rejects(
    tasks.completeTask({
      taskId: submission.taskId,
      httpStatus: 200,
      resultJsonText: JSON.stringify(responseWith([{ b64_json: pngB64(8, 8) }])),
    }),
  );
  const view = await tasks.readTask({ taskId: submission.taskId, ...OWNER });
  assert.equal(view?.status, 'failed');
  assert.equal(view?.result, undefined);
  assert.equal(view?.error?.message, 'failed to store the generated image to object storage');
});

test('4.2: the async media port maps dispatch outcomes onto the task lifecycle', async () => {
  const uploads: Array<{ key: string; data: Uint8Array }> = [];
  const now = 1_000_000;
  let sequence = 0;
  const nextId = () => `imgtask_${'f'.repeat(31)}${(sequence++ % 16).toString(16)}`;
  const tasks = new SaasImageTaskService({
    store: new InMemoryImageTaskStore({ now: () => now }),
    offloader: new ImageResultOffloader({ storage: fakeStorage(uploads) }),
    ttlMs: 60_000,
    idFactory: nextId,
    now: () => now,
  });
  const port = new SaasGatewayAsyncImageMediaPort(tasks);

  // 2xx → completed with offload.
  const ok = await port.createTask({ authenticatedCaller: authenticatedCaller() });
  await port.completeTask({
    taskId: ok.taskId,
    resultHttpStatus: 200,
    recordedBody: new TextEncoder().encode(JSON.stringify(responseWith([{ b64_json: pngB64(8, 8) }]))),
  });
  assert.equal((await tasks.readTask({ taskId: ok.taskId, ...OWNER }))?.status, 'completed');

  // Non-2xx → failed with the upstream error envelope carried verbatim.
  const upstreamError = await port.createTask({ authenticatedCaller: authenticatedCaller() });
  await port.completeTask({
    taskId: upstreamError.taskId,
    resultHttpStatus: 429,
    recordedBody: new TextEncoder().encode(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } })),
  });
  const failed = await tasks.readTask({ taskId: upstreamError.taskId, ...OWNER });
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.http_status, 429);
  assert.equal(failed?.error?.code, 'rate_limited');

  // Non-JSON 2xx body → failed with the generic envelope.
  const garbage = await port.createTask({ authenticatedCaller: authenticatedCaller() });
  await port.completeTask({
    taskId: garbage.taskId,
    resultHttpStatus: 200,
    recordedBody: new TextEncoder().encode('<html>not json</html>'),
  });
  const garbageView = await tasks.readTask({ taskId: garbage.taskId, ...OWNER });
  assert.equal(garbageView?.status, 'failed');
  assert.equal(garbageView?.error?.message, 'upstream returned a non-JSON image response');

  // Dispatch failures never throw.
  await port.failTask({
    taskId: (await port.createTask({ authenticatedCaller: authenticatedCaller() })).taskId,
    httpStatus: 502,
    error: { type: 'api_error', message: 'image generation failed' },
  });
});

test('4.2: the images query port scopes reads to the owning key and reports Retry-After while processing', async () => {
  const now = 1_000_000;
  const tasks = new SaasImageTaskService({
    store: new InMemoryImageTaskStore({ now: () => now }),
    ttlMs: 60_000,
    idFactory: () => `imgtask_${'9'.repeat(32)}`,
    now: () => now,
  });
  const port = new SaasGatewayImagesQueryPort(tasks);
  const submission = await tasks.createTask(OWNER);

  const processing = await port.serve({
    routeId: 'images.task_status',
    pathParameters: { taskId: submission.taskId },
    authenticatedCaller: authenticatedCaller(),
  });
  assert.equal(processing.status, 200);
  assert.equal(processing.retryAfterSeconds, 3);
  assert.equal(JSON.parse(String(processing.body)).status, 'processing');

  // Foreign key → 404, indistinguishable from missing.
  const foreign = await port.serve({
    routeId: 'images.task_status',
    pathParameters: { taskId: submission.taskId },
    authenticatedCaller: authenticatedCaller('tenant-1', 'key-other'),
  });
  assert.equal(foreign.status, 404);
  assert.equal(JSON.parse(String(foreign.body)).error.code, 'IMAGE_TASK_NOT_FOUND');

  // Other route ids are not this port's.
  const other = await port.serve({
    routeId: 'videos.task_status',
    pathParameters: { taskId: submission.taskId },
    authenticatedCaller: authenticatedCaller(),
  });
  assert.equal(other.status, 503);

  await tasks.failTask({
    taskId: submission.taskId,
    httpStatus: 502,
    error: imageTaskErrorEnvelope('api_error', 'boom'),
  });
  const failed = await port.serve({
    routeId: 'images.task_status',
    pathParameters: { taskId: submission.taskId },
    authenticatedCaller: authenticatedCaller(),
  });
  assert.equal(failed.retryAfterSeconds, undefined);
  assert.equal(JSON.parse(String(failed.body)).status, 'failed');
});
