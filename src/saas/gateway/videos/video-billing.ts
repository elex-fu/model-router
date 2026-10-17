import type { UsageSizeTier } from '../../../telemetry/usage.js';

/**
 * Roadmap batch 4 §4.3 (task #17) video billing primitives — the sub2api
 * `video_billing.go` + `video_billing_resolution.go` + the grok_media.go
 * status-observation helpers ported as pure functions.
 *
 * xAI Imagine video semantics (official docs, mirrored from sub2api):
 * - the create request carries `resolution` ("480p" | "720p" | "1080p"),
 *   `duration` (seconds) and `n` (video count); the completed status
 *   response does NOT echo the resolution, so billing resolution authority
 *   is the create-time snapshot;
 * - the completed status shape is
 *   `{"status":"done","model":"...","video":{"url":"...","duration":8}}`;
 *   `pending` / `expired` / `failed` — or `done` without a video URL — are
 *   never billable;
 * - one async video task bills exactly once across arbitrarily many
 *   status/content polls (the stable `video:<taskID>` billing key).
 */

/** Canonical video resolution tiers (the #15 per_unit tier registry subset). */
export const VIDEO_BILLING_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

export type VideoBillingResolution = (typeof VIDEO_BILLING_RESOLUTIONS)[number];

export function isVideoBillingResolution(value: unknown): value is VideoBillingResolution {
  return typeof value === 'string' && (VIDEO_BILLING_RESOLUTIONS as readonly string[]).includes(value);
}

/** Official default when the request leaves the resolution open. */
export const DEFAULT_VIDEO_RESOLUTION: VideoBillingResolution = '480p';

/**
 * sub2api `LookupVideoBillingResolution`: canonical tier or null. The
 * request-side normalizer maps anything unrecognized onto the 480p default
 * (the documented upstream default), never a silently wrong tier.
 */
export function lookupVideoBillingResolution(value: unknown): VideoBillingResolution | null {
  if (!isVideoBillingResolution(value)) return null;
  return value;
}

/** sub2api `NormalizeVideoBillingResolutionOrDefault`. */
export function normalizeVideoResolutionOrDefault(value: unknown): VideoBillingResolution {
  return (
    lookupVideoBillingResolution(typeof value === 'string' ? value.trim().toLowerCase() : value) ??
    DEFAULT_VIDEO_RESOLUTION
  );
}

/** Official xAI Imagine video duration bounds (seconds). */
export const MIN_VIDEO_DURATION_SECONDS = 1;
export const MAX_VIDEO_DURATION_SECONDS = 15;
/** Documented default duration when the request leaves it open. */
export const DEFAULT_VIDEO_DURATION_SECONDS = 8;

/**
 * sub2api `NormalizeVideoBillingDurationSecondsOrDefault`: clamp into
 * [1, 15] with the 8s default. A non-numeric or non-positive request value
 * falls back to the default (the upstream itself rejects malformed input).
 */
export function normalizeVideoDurationSecondsOrDefault(value: unknown): number {
  let seconds = DEFAULT_VIDEO_DURATION_SECONDS;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = Math.trunc(value);
  }
  if (!Number.isSafeInteger(seconds)) return DEFAULT_VIDEO_DURATION_SECONDS;
  if (seconds < MIN_VIDEO_DURATION_SECONDS) return MIN_VIDEO_DURATION_SECONDS;
  if (seconds > MAX_VIDEO_DURATION_SECONDS) return MAX_VIDEO_DURATION_SECONDS;
  return seconds;
}

/** Gateway-side guard on the per-request video count (the hold multiplier). */
export const MAX_VIDEO_COUNT = 10;
export const DEFAULT_VIDEO_COUNT = 1;

/**
 * The request's `n`: 1 by default, closed failure above the guard. The
 * conservative hold prices `MAX_VIDEO_DURATION_SECONDS × n` seconds, so an
 * unbounded count would be an unbounded wallet hold — malformed input is a
 * closed failure, never a silently wrong bound (the images estimator rule).
 */
export function videoCountFromRequest(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_VIDEO_COUNT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_VIDEO_COUNT) {
    throw new Error('the video estimator requires n to be an integer between 1 and 10');
  }
  return value;
}

/**
 * The per-unit (second) hold upper bound for one create request: the
 * documented 15s maximum per video times the requested count. The request's
 * own `duration` is deliberately NOT the bound — the upstream has not
 * confirmed the actual duration yet, so the hold is the family maximum
 * (task #17: 上游未确认前 hold 用保守上界 15s×n).
 */
export function videoHoldUnitsUpperBound(body: Readonly<Record<string, unknown>>): number {
  return MAX_VIDEO_DURATION_SECONDS * videoCountFromRequest(body.n);
}

/** The hold tier: the request's resolution, normalized (480p default). */
export function videoHoldSizeTier(body: Readonly<Record<string, unknown>>): VideoBillingResolution {
  return normalizeVideoResolutionOrDefault(body.resolution);
}

/**
 * The stable durable billing key for one async video task — shared by the
 * claim guard and the settlement idempotency key so repeated status/content
 * polls can never double-bill (sub2api StableGrokVideoBillingRequestID).
 */
export function stableVideoBillingRequestId(taskId: string): string {
  const id = taskId.trim();
  if (id === '') return '';
  return id.startsWith('video:') ? id : `video:${id}`;
}

/** The path-parameter task id shape the query routes accept (opaque ASCII). */
export const VIDEO_TASK_ID_PATTERN = /^[\x21-\x7e]{1,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Official xAI async status success: `status == "done"` AND a non-empty
 * `video.url` (sub2api IsGrokVideoStatusBillable). `pending`/`expired`/
 * `failed`, or `done` without a video URL, are not billable.
 */
export function isVideoStatusBillable(statusBody: unknown): boolean {
  if (!isRecord(statusBody)) return false;
  if (
    String(statusBody.status ?? '')
      .trim()
      .toLowerCase() !== 'done'
  )
    return false;
  const video = statusBody.video;
  if (!isRecord(video)) return false;
  return typeof video.url === 'string' && video.url.trim() !== '';
}

/** The video URL from an official done status body (null when absent). */
export function videoStatusContentUrl(statusBody: unknown): string | null {
  if (!isRecord(statusBody) || !isRecord(statusBody.video)) return null;
  const url = statusBody.video.url;
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null;
}

/** sub2api extractGrokMediaVideoRequestID: the async task id from a create response. */
export function extractVideoRequestIdFromBody(body: unknown): string {
  if (!isRecord(body)) return '';
  const paths: readonly (readonly string[])[] = [
    ['request_id'],
    ['id'],
    ['data', 'request_id'],
    ['data', 'id'],
    ['video', 'request_id'],
    ['video', 'id'],
    ['task_id'],
    ['data', 'task_id'],
    ['video', 'task_id'],
  ];
  for (const path of paths) {
    let node: unknown = body;
    let ok = true;
    for (const segment of path) {
      if (!isRecord(node) || !(segment in node)) {
        ok = false;
        break;
      }
      node = node[segment];
    }
    if (ok && typeof node === 'string' && node.trim() !== '') return node.trim();
  }
  return '';
}

/**
 * The billable observation assembled from one completed status poll,
 * merging the create-time snapshot exactly like sub2api
 * ExtractGrokVideoBillingFromStatusBody:
 *
 * - model: the status body's top-level `model`, else the snapshot's;
 * - duration: the status body's `video.duration` (seconds), else the
 *   snapshot's create-time duration;
 * - resolution: ALWAYS the snapshot — the official status response does
 *   not document a resolution field;
 * - count: always the snapshot's create-time `n` (a done status describes
 *   one video URL; the create requested the count).
 *
 * Returns null when the status is not billable.
 */
export interface VideoBillingSnapshot {
  readonly model: string;
  readonly resolution: VideoBillingResolution;
  readonly durationSeconds: number;
  readonly videoCount: number;
}

export interface VideoBillingObservation extends VideoBillingSnapshot {
  /** Total billed seconds: duration × count (per_unit units). */
  readonly units: number;
  /** The per_unit tier key for the pricing ladder. */
  readonly sizeTier: UsageSizeTier;
}

export function extractVideoBillingObservation(
  statusBody: unknown,
  snapshot: VideoBillingSnapshot | null,
): VideoBillingObservation | null {
  if (!isVideoStatusBillable(statusBody)) return null;
  const body = statusBody as Record<string, unknown>;
  const video = body.video as Record<string, unknown>;

  let model = '';
  if (typeof body.model === 'string') model = body.model.trim();
  let durationSeconds = 0;
  if (typeof video.duration === 'number' && Number.isFinite(video.duration) && video.duration > 0) {
    durationSeconds = Math.trunc(video.duration);
  }

  if (snapshot !== null) {
    if (model === '') model = snapshot.model.trim();
    if (durationSeconds <= 0) durationSeconds = snapshot.durationSeconds;
  }
  // Fail-closed pricing identity: without a model the per-second rate card
  // cannot be resolved — the caller skips billing rather than guessing.
  if (model === '') return null;

  const resolution = snapshot === null ? DEFAULT_VIDEO_RESOLUTION : snapshot.resolution;
  const videoCount = snapshot === null ? DEFAULT_VIDEO_COUNT : Math.max(1, snapshot.videoCount);
  durationSeconds = normalizeVideoDurationSecondsOrDefault(durationSeconds);

  return {
    model,
    resolution,
    durationSeconds,
    videoCount,
    units: durationSeconds * videoCount,
    sizeTier: resolution,
  };
}

/**
 * Parses the create request body into the create-time billing snapshot.
 * Every field is normalized to its canonical billing value here — the
 * status response cannot re-supply resolution, so the snapshot is the
 * authority (task #17: 分辨率必须 create 时存).
 */
export function parseVideoCreateSnapshot(body: Readonly<Record<string, unknown>>): VideoBillingSnapshot {
  const model = body.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('the video create snapshot requires a model');
  }
  return Object.freeze({
    model: model.trim(),
    resolution: normalizeVideoResolutionOrDefault(body.resolution),
    durationSeconds: normalizeVideoDurationSecondsOrDefault(body.duration),
    videoCount: videoCountFromRequest(body.n),
  });
}
