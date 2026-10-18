/**
 * Local type declarations for busboy@1.6.0 (the gap-remediation G-B2
 * dependency exception — exact-pinned, one transitive dependency, zero
 * native compilation). Hand-written against the 1.x API actually used by
 * src/saas/gateway/multipart-envelope.ts; the DefinitelyTyped package is
 * stale and does not match the 1.x constructor/options surface.
 */

declare module 'busboy' {
  import type { Readable, Writable } from 'node:stream';

  export interface BusboyOptions {
    /** The incoming request's headers (multipart/form-data with boundary). Required. */
    headers: Record<string, string | undefined>;
    /** Max number of non-file fields. */
    fields?: number | undefined;
    /** Max number of file parts. */
    files?: number | undefined;
    /** Max field name length (bytes). */
    fieldNameSize?: number | undefined;
    /** Max field value length (bytes). */
    fieldSize?: number | undefined;
    /** Max file size (bytes), per file part. */
    fileSize?: number | undefined;
    /** Max number of parts (files + fields). */
    parts?: number | undefined;
    /** Header count limit. */
    headerPairs?: number | undefined;
    defCharset?: string | undefined;
    preservePath?: boolean | undefined;
    highWaterMark?: number | undefined;
  }

  export interface BusboyFileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  export interface BusboyFieldInfo {
    nameTruncated: boolean;
    valueTruncated: boolean;
    encoding: string;
    mimeType: string;
  }

  export class Busboy extends Writable {
    constructor(options: BusboyOptions);
    on(event: 'field', listener: (name: string, value: string, info: BusboyFieldInfo) => void): this;
    on(event: 'file', listener: (name: string, stream: Readable, info: BusboyFileInfo) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'partsLimit' | 'filesLimit' | 'fieldsLimit', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  const busboy: {
    new (options: BusboyOptions): Busboy;
    (options: BusboyOptions): Busboy;
  };

  export default busboy;
}
