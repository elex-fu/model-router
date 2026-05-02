export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse an SSE byte stream into a sequence of events.
 *
 * - Splits the byte stream on blank lines (event boundary).
 * - Recognises `event:` and `data:` fields.
 * - Strips a single optional leading space after the colon.
 * - Concatenates multiple `data:` lines with `\n` (per SSE spec).
 * - Ignores comment lines (lines starting with `:`).
 * - Tolerates `\r\n` and trailing whitespace.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalise CRLF to LF for splitting.
      let idx: number;
      while ((idx = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        // Skip past the boundary (one or more blank lines).
        buffer = buffer.slice(idx + boundaryLength(buffer, idx));
        const ev = parseEventBlock(rawEvent);
        if (ev) yield ev;
      }
    }
    // Flush remaining buffer.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const ev = parseEventBlock(buffer);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

// Find an event boundary: a sequence of "\n\n", "\r\n\r\n", or mix.
// Returns index of first character of the terminator, or -1.
function findEventBoundary(buf: string): number {
  // Try in order of length to prefer the canonical CRLF terminator when present.
  const candidates = ['\r\n\r\n', '\n\n', '\r\r'];
  let best = -1;
  for (const c of candidates) {
    const i = buf.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

function boundaryLength(buf: string, idx: number): number {
  if (buf.startsWith('\r\n\r\n', idx)) return 4;
  if (buf.startsWith('\n\n', idx)) return 2;
  if (buf.startsWith('\r\r', idx)) return 2;
  return 2;
}

function parseEventBlock(block: string): SseEvent | null {
  const lines = block.split(/\r\n|\n|\r/);
  let event: string | undefined;
  const dataParts: string[] = [];
  let sawAnyField = false;

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    if (field === 'event') {
      event = value;
      sawAnyField = true;
    } else if (field === 'data') {
      dataParts.push(value);
      sawAnyField = true;
    }
    // Other fields (id, retry) intentionally ignored.
  }

  if (!sawAnyField) return null;
  return { event, data: dataParts.join('\n') };
}

/** Serialise a single event to SSE wire format. */
export function writeSseEvent(event: SseEvent): string {
  let out = '';
  if (event.event !== undefined) {
    out += `event: ${event.event}\n`;
  }
  // For multi-line data, emit one `data:` line per segment.
  const dataLines = event.data.split('\n');
  for (const line of dataLines) {
    out += `data: ${line}\n`;
  }
  out += '\n';
  return out;
}

/** Helper for tests: serialise events to a Uint8Array. */
export function finalizeStream(events: SseEvent[]): Uint8Array {
  const text = events.map(writeSseEvent).join('');
  return new TextEncoder().encode(text);
}
