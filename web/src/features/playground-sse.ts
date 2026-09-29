export interface PlaygroundFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Read SSE lines across arbitrary byte boundaries. A completed run must send [DONE]. */
export async function readPlaygroundSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: PlaygroundFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLf = false;
  let event = 'message';
  let data: string[] = [];
  let finished = false;

  function dispatch() {
    if (!data.length) { event = 'message'; return; }
    const payload = data.join('\n');
    const name = event;
    data = [];
    event = 'message';
    if (payload === '[DONE]') { finished = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); }
    catch { throw new Error('流事件包含无效 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('流事件不是有效对象');
    onFrame({ event: name, data: parsed as Record<string, unknown> });
  }

  function acceptLine(value: string) {
    if (value === '') { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    else if (field === 'event') event = content || 'message';
  }

  function acceptText(value: string) {
    for (const character of value) {
      if (skipLf) { skipLf = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        acceptLine(line);
        line = '';
        skipLf = character === '\r';
      } else line += character;
      if (finished) return;
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      acceptText(decoder.decode(value, { stream: true }));
    }
    if (!finished) {
      acceptText(decoder.decode());
      if (line) acceptLine(line);
      dispatch(); // Also accepts a final frame without a blank line.
      if (!finished) throw new Error('流在完成标记 [DONE] 前结束');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
