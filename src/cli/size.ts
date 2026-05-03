const SIZE_RE = /^(\d+)\s*(b|kb?|mb?|gb?)?$/i;

export function parseByteSize(input: string): number {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`invalid size: "${input}"`);
  }
  const m = SIZE_RE.exec(input.trim());
  if (!m) throw new Error(`invalid size: "${input}"`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid size: "${input}"`);
  const unit = (m[2] ?? 'b').toLowerCase();
  switch (unit) {
    case 'b':
      return n;
    case 'k':
    case 'kb':
      return n * 1024;
    case 'm':
    case 'mb':
      return n * 1024 * 1024;
    case 'g':
    case 'gb':
      return n * 1024 * 1024 * 1024;
    default:
      throw new Error(`invalid size unit: "${unit}"`);
  }
}
