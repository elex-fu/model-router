import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  extractVideoBillingObservation,
  extractVideoRequestIdFromBody,
  isVideoStatusBillable,
  normalizeVideoDurationSecondsOrDefault,
  normalizeVideoResolutionOrDefault,
  parseVideoCreateSnapshot,
  stableVideoBillingRequestId,
  videoCountFromRequest,
  videoHoldSizeTier,
  videoHoldUnitsUpperBound,
} from '../../../../src/saas/gateway/videos/video-billing.js';

/**
 * Batch 4 §4.3 (task #17) — the sub2api video billing primitives: tier and
 * duration normalization, the official done-status billability shape, the
 * snapshot merge priority, the stable billing key, and the conservative
 * per-unit hold envelope.
 */

test('4.3: resolution normalization maps canonical tiers and defaults to 480p', () => {
  assert.equal(normalizeVideoResolutionOrDefault('480p'), '480p');
  assert.equal(normalizeVideoResolutionOrDefault('720P'), '720p');
  assert.equal(normalizeVideoResolutionOrDefault(' 1080p '), '1080p');
  assert.equal(normalizeVideoResolutionOrDefault('4k'), '480p');
  assert.equal(normalizeVideoResolutionOrDefault(undefined), '480p');
  assert.equal(normalizeVideoResolutionOrDefault(7), '480p');
});

test('4.3: duration normalization clamps into [1, 15] with the 8s default', () => {
  assert.equal(normalizeVideoDurationSecondsOrDefault(undefined), DEFAULT_VIDEO_DURATION_SECONDS);
  assert.equal(DEFAULT_VIDEO_DURATION_SECONDS, 8);
  assert.equal(normalizeVideoDurationSecondsOrDefault(0), 1);
  assert.equal(normalizeVideoDurationSecondsOrDefault(-3), 1);
  assert.equal(normalizeVideoDurationSecondsOrDefault(8), 8);
  assert.equal(normalizeVideoDurationSecondsOrDefault(15), 15);
  assert.equal(normalizeVideoDurationSecondsOrDefault(20), 15);
  assert.equal(normalizeVideoDurationSecondsOrDefault(8.9), 8);
  assert.equal(normalizeVideoDurationSecondsOrDefault('8'), 8);
});

test('4.3: the request count is 1 by default and fails closed outside [1, 10]', () => {
  assert.equal(videoCountFromRequest(undefined), 1);
  assert.equal(videoCountFromRequest(1), 1);
  assert.equal(videoCountFromRequest(10), 10);
  assert.throws(() => videoCountFromRequest(0));
  assert.throws(() => videoCountFromRequest(11));
  assert.throws(() => videoCountFromRequest(2.5));
  assert.throws(() => videoCountFromRequest('2'));
});

test('4.3: the hold envelope is the conservative 15s × n at the requested tier', () => {
  assert.equal(videoHoldUnitsUpperBound({ n: 1 }), 15);
  assert.equal(videoHoldUnitsUpperBound({ n: 3, duration: 6 }), 45);
  // The request's own duration never lowers the bound (upstream unconfirmed).
  assert.equal(videoHoldUnitsUpperBound({ n: 2, duration: 1 }), 30);
  assert.equal(videoHoldSizeTier({ resolution: '1080p' }), '1080p');
  assert.equal(videoHoldSizeTier({}), '480p');
  assert.throws(() => videoHoldUnitsUpperBound({ n: 99 }));
});

test('4.3: billability requires status done AND a non-empty video.url', () => {
  assert.equal(isVideoStatusBillable({ status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } }), true);
  assert.equal(isVideoStatusBillable({ status: 'Done', video: { url: 'https://vidgen.x.ai/a.mp4' } }), true);
  assert.equal(isVideoStatusBillable({ status: 'pending', video: {} }), false);
  assert.equal(isVideoStatusBillable({ status: 'failed' }), false);
  assert.equal(isVideoStatusBillable({ status: 'expired', video: { url: 'https://x' } }), false);
  assert.equal(isVideoStatusBillable({ status: 'done', video: { url: '   ' } }), false);
  assert.equal(isVideoStatusBillable({ status: 'done' }), false);
  assert.equal(isVideoStatusBillable('nope'), false);
});

test('4.3: the observation merges the snapshot with the status priority (duration: status first; resolution: snapshot only)', () => {
  const snapshot = {
    model: 'grok-imagine-video-1.5',
    resolution: '720p',
    durationSeconds: 6,
    videoCount: 2,
  };
  const observation = extractVideoBillingObservation(
    { status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://vidgen.x.ai/a.mp4', duration: 4 } },
    snapshot,
  );
  assert.ok(observation !== null);
  // duration from the status body; resolution and count from the snapshot.
  assert.equal(observation.durationSeconds, 4);
  assert.equal(observation.resolution, '720p');
  assert.equal(observation.sizeTier, '720p');
  assert.equal(observation.videoCount, 2);
  assert.equal(observation.units, 8);
  assert.equal(observation.model, 'grok-imagine-video-1.5');
});

test('4.3: the snapshot duration and model backfill a terse status body', () => {
  const observation = extractVideoBillingObservation(
    { status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } },
    { model: 'grok-imagine-video', resolution: '1080p', durationSeconds: 12, videoCount: 1 },
  );
  assert.ok(observation !== null);
  assert.equal(observation.durationSeconds, 12);
  assert.equal(observation.model, 'grok-imagine-video');
  assert.equal(observation.units, 12);
  assert.equal(observation.sizeTier, '1080p');
});

test('4.3: a status duration outside the documented range is clamped', () => {
  const observation = extractVideoBillingObservation(
    { status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4', duration: 60 } },
    { model: 'm', resolution: '480p', durationSeconds: 8, videoCount: 1 },
  );
  assert.ok(observation !== null);
  assert.equal(observation.durationSeconds, 15);
});

test('4.3: a non-billable status yields no observation', () => {
  assert.equal(extractVideoBillingObservation({ status: 'pending' }, null), null);
  assert.equal(extractVideoBillingObservation({ status: 'done', video: {} }, null), null);
});

test('4.3: a billable status without any model identity is unpriceable (null)', () => {
  // No status model and no snapshot — the rate card cannot be resolved.
  assert.equal(extractVideoBillingObservation({ status: 'done', video: { url: 'u' } }, null), null);
});

test('4.3: the stable billing request id prefixes once and only once', () => {
  assert.equal(stableVideoBillingRequestId('abc-123'), 'video:abc-123');
  assert.equal(stableVideoBillingRequestId('video:abc-123'), 'video:abc-123');
  assert.equal(stableVideoBillingRequestId('  abc  '), 'video:abc');
  assert.equal(stableVideoBillingRequestId(''), '');
});

test('4.3: the create request id is extracted from the documented response paths', () => {
  assert.equal(extractVideoRequestIdFromBody({ request_id: 'req-1' }), 'req-1');
  assert.equal(extractVideoRequestIdFromBody({ id: 'req-2' }), 'req-2');
  assert.equal(extractVideoRequestIdFromBody({ data: { request_id: 'req-3' } }), 'req-3');
  assert.equal(extractVideoRequestIdFromBody({ video: { id: 'req-4' } }), 'req-4');
  assert.equal(extractVideoRequestIdFromBody({ task_id: ' req-5 ' }), 'req-5');
  assert.equal(extractVideoRequestIdFromBody({ status: 'queued' }), '');
  assert.equal(extractVideoRequestIdFromBody('junk'), '');
});

test('4.3: the create snapshot stores normalized billing identity', () => {
  const snapshot = parseVideoCreateSnapshot({
    model: 'grok-imagine-video-1.5',
    resolution: '1080p',
    duration: 4,
    n: 2,
  });
  assert.deepEqual(snapshot, {
    model: 'grok-imagine-video-1.5',
    resolution: '1080p',
    durationSeconds: 4,
    videoCount: 2,
  });
  // Defaults: 480p / 8s / 1 video.
  assert.deepEqual(parseVideoCreateSnapshot({ model: 'm' }), {
    model: 'm',
    resolution: '480p',
    durationSeconds: 8,
    videoCount: 1,
  });
  assert.throws(() => parseVideoCreateSnapshot({ resolution: '720p' }));
});
