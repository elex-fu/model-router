/** Half-open calendar-day period in a configured IANA timezone. */
export interface QuotaPeriod {
  id: string;
  startMs: number;
  endMs: number;
}

function wallParts(ms: number, timeZone: string): [number, number, number, number, number, number] {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((part) => [part.type, Number(part.value)]),
  );
  return [values.year, values.month, values.day, values.hour, values.minute, values.second] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const [y, m, d, h, minute, second] = wallParts(guess, timeZone);
    const displayedAsUtc = Date.UTC(y, m - 1, d, h, minute, second);
    const next = target - (displayedAsUtc - guess);
    if (Math.abs(next - guess) < 1000) return next;
    guess = next;
  }
  return guess;
}

export function quotaPeriod(atMs: number, timeZone: string, versionId?: string | number): QuotaPeriod {
  const [year, month, day] = wallParts(atMs, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const startMs = localMidnightUtc(year, month, day, timeZone);
  const endMs = localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  return {
    id: `${versionId === undefined ? '' : `v${versionId}:`}${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    startMs,
    endMs,
  };
}
