export interface SinceRange {
  fromDate: string;
  toDate: string;
}

const DAYS_RE = /^(\d+)d$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveSinceRange(since: string | undefined, today: string): SinceRange {
  if (since === undefined || since === '') {
    return { fromDate: today, toDate: today };
  }
  const daysMatch = DAYS_RE.exec(since);
  if (daysMatch) {
    const n = Number(daysMatch[1]);
    const todayDate = parseISODate(today);
    if (!todayDate) throw new Error(`invalid today date: ${today}`);
    const from = new Date(todayDate);
    from.setUTCDate(from.getUTCDate() - n);
    return { fromDate: formatISODate(from), toDate: today };
  }
  if (ISO_DATE_RE.test(since)) {
    const parsed = parseISODate(since);
    if (!parsed) throw new Error(`invalid --since date: ${since}`);
    return { fromDate: since, toDate: today };
  }
  throw new Error(`invalid --since: ${since} (expected Nd or YYYY-MM-DD)`);
}

function parseISODate(s: string): Date | null {
  if (!ISO_DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

function formatISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
