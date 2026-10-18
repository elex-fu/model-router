import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';

import busboy from 'busboy';

/**
 * Gap-remediation plan G-B2 (§3): the controlled multipart body envelope —
 * the streamed parse that turns a multipart/form-data request into the
 * plan's GatewayBodyEnvelope shape.
 *
 * Hard bounds (the plan's eight resources — new-api's whole-body buffering
 * replaced by streaming, because this gateway never buffers a file in
 * memory): one file ≤ 25 MiB; ≤ 4 files; ≤ 32 non-file fields; single
 * field value ≤ 64 KiB; total multipart bytes ≤ 32 MiB; the caller bounds
 * read duration and per-key concurrent uploads at the boundary layer.
 *
 * Every file streams through a Transform (incremental SHA-256 + bounds)
 * into a mode-0600 file with a RANDOM on-disk name inside the caller's
 * private staging directory — no client filename ever reaches path
 * construction (structurally unused, the new-api canonicalization lesson).
 *
 * The manifest digest commits to normalized fields (repeated-field order
 * preserved), each file's digest + size, and the part inventory.
 */

export interface GatewayMultipartFilePart {
  /** The caller-visible field name (e.g. "file", "image"). */
  readonly field: string;
  /** The client-declared content type; NEVER trusted for billing or parsing. */
  readonly contentType: string;
  /** The client-declared filename; recorded for the manifest only. */
  readonly filename: string;
  /** The staged file's absolute path inside the caller's staging directory. */
  readonly path: string;
  /** The exact byte size staged. */
  readonly bytes: number;
  /** The SHA-256 of the staged bytes (computed incrementally while streaming). */
  readonly sha256: string;
}

export interface GatewayMultipartEnvelope {
  readonly kind: 'multipart';
  /** Non-file fields in ARRIVAL order (repeated fields preserved). */
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly files: readonly GatewayMultipartFilePart[];
  /** SHA-256 over the canonical manifest (see multipartManifestDigest). */
  readonly manifestDigest: string;
}

export type MultipartParseFailureCode =
  | 'NOT_MULTIPART'
  | 'BAD_CONTENT_TYPE'
  | 'TOO_MANY_FILES'
  | 'TOO_MANY_FIELDS'
  | 'FILE_TOO_LARGE'
  | 'FIELD_TOO_LARGE'
  | 'TOTAL_TOO_LARGE'
  | 'READ_FAILED';

export class GatewayMultipartParseError extends Error {
  constructor(
    readonly code: MultipartParseFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayMultipartParseError';
  }
}

/** The plan's eight-resource bounds (the composition's defaults). */
export interface GatewayMultipartLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxFields: number;
  readonly maxFieldBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_MULTIPART_LIMITS: GatewayMultipartLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 4,
  maxFields: 32,
  maxFieldBytes: 64 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

const RANDOM_SUFFIX_BYTES = 16;

function randomToken(): string {
  const bytes = new Uint8Array(RANDOM_SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The canonical manifest a multipart envelope's digest commits to. */
export function multipartManifestDigest(input: {
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly files: ReadonlyArray<{ readonly field: string; readonly sha256: string; readonly bytes: number }>;
}): string {
  const hash = createHash('sha256');
  hash.update('model-router-multipart-manifest-v1\n');
  for (const field of input.fields) {
    hash.update(`f:${field.name.length}:${field.name}:${field.value.length}:${field.value}\n`);
  }
  hash.update(`files:${input.files.length}\n`);
  for (const file of input.files) {
    hash.update(`p:${file.field}:${file.sha256}:${file.bytes}\n`);
  }
  return hash.digest('hex');
}

export interface ParseMultipartOptions {
  /** A PRIVATE staging directory the caller owns (mode 0700); created when absent. */
  readonly stagingDirectory: string;
  readonly limits?: Partial<GatewayMultipartLimits>;
  /** Invoked once when the parse FAILS (the staging directory is already removed). */
  readonly cleanup?: () => void | Promise<void>;
}

/**
 * Streams one multipart/form-data request into the envelope. Resolves after
 * every file's staged write finished (close-gated); rejects with
 * GatewayMultipartParseError on any bound violation, removing the staging
 * directory first. The caller owns post-success cleanup: the staged files
 * are the request's artifacts (clean after the task lifetime).
 */
export function parseMultipartBody(
  request: {
    readonly headers: Record<string, string | string[] | undefined>;
  },
  source: NodeJS.ReadableStream,
  options: ParseMultipartOptions,
): Promise<GatewayMultipartEnvelope> {
  const limits: GatewayMultipartLimits = { ...DEFAULT_MULTIPART_LIMITS, ...options.limits };
  let contentType = request.headers['content-type'];
  if (Array.isArray(contentType)) contentType = contentType[0];
  if (typeof contentType !== 'string' || !/^multipart\/form-data/i.test(contentType)) {
    return Promise.reject(new GatewayMultipartParseError('NOT_MULTIPART', 'the request is not multipart/form-data'));
  }
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({ headers: { 'content-type': contentType }, files: limits.maxFiles + 1 });
  } catch {
    return Promise.reject(
      new GatewayMultipartParseError('BAD_CONTENT_TYPE', 'the multipart content type is malformed'),
    );
  }

  // The wire source must be a pipe-able stream; an async-iterable body
  // (test harnesses, adapters) is pumped through a PassThrough so busboy
  // sees a real Readable either way.
  let stream: NodeJS.ReadableStream = source;
  if (typeof (source as { pipe?: unknown }).pipe !== 'function') {
    const pump = new PassThrough();
    stream = pump;
    void (async () => {
      try {
        const iterable = source as AsyncIterable<unknown>;
        for await (const chunk of iterable) {
          const view = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
          if (!pump.write(view)) await once(pump, 'drain');
        }
        pump.end();
      } catch {
        pump.destroy();
      }
    })();
  }

  const fields: Array<{ name: string; value: string }> = [];
  const files: GatewayMultipartFilePart[] = [];
  /** Accepted file PARTS (counted at part-open, not at write-finish). */
  let acceptedFileParts = 0;
  /** One settle promise per accepted file part; the close gate awaits all. */
  const pendingFileWrites: Array<Promise<void>> = [];
  let totalBytes = 0;
  let settled = false;

  return new Promise<GatewayMultipartEnvelope>((resolve, reject) => {
    const fail = (code: MultipartParseFailureCode, message: string): void => {
      if (settled) return;
      settled = true;
      try {
        stream.unpipe?.(parser);
      } catch {
        // the parser may already be detached
      }
      void (async () => {
        try {
          await rm(options.stagingDirectory, { recursive: true, force: true });
        } catch {
          // best-effort: the janitor sweep owns leftovers
        }
        await options.cleanup?.();
        reject(new GatewayMultipartParseError(code, message));
      })();
    };

    parser.on('field', (name: string, value: string) => {
      if (settled) return;
      if (fields.length >= limits.maxFields) {
        fail('TOO_MANY_FIELDS', `more than ${limits.maxFields} non-file fields`);
        return;
      }
      if (Buffer.byteLength(value, 'utf8') > limits.maxFieldBytes) {
        fail('FIELD_TOO_LARGE', `field ${name} exceeds ${limits.maxFieldBytes} bytes`);
        return;
      }
      fields.push({ name, value });
    });

    parser.on('file', (name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (acceptedFileParts >= limits.maxFiles) {
        fail('TOO_MANY_FILES', `more than ${limits.maxFiles} files`);
        stream.resume();
        return;
      }
      acceptedFileParts += 1;
      const stagedPath = join(options.stagingDirectory, `${randomToken()}.part`);
      const hash = createHash('sha256');
      let bytes = 0;
      let fileFailed = false;
      let releaseFile: () => void = () => {};
      const fileWrite = new Promise<void>((release) => {
        releaseFile = release;
      });
      pendingFileWrites.push(fileWrite);
      // A Transform (not a Writable pipe-chain): source → [hash+bounds] → disk.
      const sink = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          totalBytes += chunk.length;
          if (bytes > limits.maxFileBytes) {
            fileFailed = true;
            callback(new GatewayMultipartParseError('FILE_TOO_LARGE', `a file exceeds ${limits.maxFileBytes} bytes`));
            return;
          }
          if (totalBytes > limits.maxTotalBytes) {
            fileFailed = true;
            callback(
              new GatewayMultipartParseError(
                'TOTAL_TOO_LARGE',
                `the multipart body exceeds ${limits.maxTotalBytes} bytes`,
              ),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const output = createWriteStream(stagedPath, { mode: 0o600 });
      output.on('finish', () => {
        if (settled || fileFailed) {
          releaseFile();
          return;
        }
        files.push({
          field: name,
          contentType: info.mimeType,
          filename: info.filename,
          path: stagedPath,
          bytes,
          sha256: hash.digest('hex'),
        });
        releaseFile();
      });
      output.on('close', () => {
        releaseFile();
      });
      sink.on('error', (error: unknown) => {
        const code = error instanceof GatewayMultipartParseError ? error.code : 'READ_FAILED';
        const message =
          error instanceof GatewayMultipartParseError ? error.message : 'streaming the uploaded file failed';
        releaseFile();
        fail(code, message);
      });
      output.on('error', () => {
        releaseFile();
        if (!fileFailed && !settled) fail('READ_FAILED', 'staging the uploaded file failed');
      });
      stream.pipe(sink).pipe(output);
    });

    parser.on('error', () => {
      fail('BAD_CONTENT_TYPE', 'the multipart stream was malformed');
    });
    parser.on('close', () => {
      if (settled) return;
      void (async () => {
        // Wait for every staged file write to settle (finish or error)
        // before resolving; the fail() path already rejected on error.
        await Promise.all(pendingFileWrites);
        if (settled) return;
        settled = true;
        resolve({
          kind: 'multipart',
          fields,
          files,
          manifestDigest: multipartManifestDigest({ fields, files }),
        });
      })();
    });

    stream.on('error', () => {
      fail('READ_FAILED', 'reading the request body failed');
    });
    stream.pipe(parser);
  });
}
