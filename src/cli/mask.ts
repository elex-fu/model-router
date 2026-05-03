export function maskSecret(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length <= 10) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
