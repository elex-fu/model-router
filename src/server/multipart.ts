/**
 * Minimal multipart/form-data field extraction for media endpoints.
 *
 * The classic proxy never needs to fully parse a multipart body: transcriptions,
 * translations and image edits are forwarded to the upstream byte-for-byte.
 * Routing only needs one string field ("model"), so this scanner walks the
 * body's boundary-separated parts far enough to find it. Anything unexpected
 * (malformed boundary, oversized field value, part headers with a filename)
 * yields null and the request keeps flowing as an opaque passthrough.
 */

const FIELD_VALUE_LIMIT = 256;
const SCAN_LIMIT = 2 * 1024 * 1024;

/** Extract the multipart boundary token from a Content-Type header value. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length === 0 || boundary.length > 200) return null;
  return boundary;
}

/**
 * Extract one string field from a collected multipart body. Only
 * content-disposition form-data parts without a filename are considered;
 * file parts are skipped without reading their content.
 */
export function extractMultipartStringField(body: Buffer, boundary: string, field: string): string | null {
  const delimiter = Buffer.from(`--${boundary}`, 'utf-8');
  const scanEnd = Math.min(body.length, SCAN_LIMIT);
  let cursor = 0;
  while (cursor < scanEnd) {
    const partStart = body.indexOf(delimiter, cursor);
    if (partStart < 0) return null;
    // Skip past the delimiter and the trailing CRLF that follows it.
    let headerStart = partStart + delimiter.length;
    if (body[headerStart] === 0x2d && body[headerStart + 1] === 0x2d) return null; // closing "--"
    if (body[headerStart] === 0x0d && body[headerStart + 1] === 0x0a) headerStart += 2;
    else if (body[headerStart] === 0x0a) headerStart += 1;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf-8'), headerStart);
    if (headerEnd < 0) return null;
    const headerBlock = body.toString('utf-8', headerStart, Math.min(headerEnd, headerStart + 8192));
    const disposition = /^content-disposition:\s*form-data;/i.test(headerBlock);
    const nameMatch = /name="([^"]*)"/.exec(headerBlock);
    const isFilePart = /filename=/i.test(headerBlock);
    if (disposition && nameMatch && nameMatch[1] === field && !isFilePart) {
      const valueStart = headerEnd + 4;
      let valueEnd = body.indexOf(delimiter, valueStart);
      if (valueEnd < 0) valueEnd = body.length;
      // Values are terminated by the delimiter's preceding CRLF.
      if (valueEnd >= 2 && body[valueEnd - 2] === 0x0d && body[valueEnd - 1] === 0x0a) valueEnd -= 2;
      if (valueEnd - valueStart <= 0 || valueEnd - valueStart > FIELD_VALUE_LIMIT) return null;
      const value = body.toString('utf-8', valueStart, valueEnd);
      return /^[\x20-\x7e]*$/.test(value) ? value : null; // printable ASCII model names only
    }
    // Not the target field: jump to the next delimiter occurrence.
    const nextDelimiter = body.indexOf(delimiter, headerEnd + 4);
    if (nextDelimiter < 0) return null;
    cursor = nextDelimiter;
  }
  return null;
}
