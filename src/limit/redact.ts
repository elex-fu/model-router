const SECRET_RE = /sk-[A-Za-z0-9_-]{8,}/g;

export function redactSecrets<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_RE, 'sk-***') as T;
}
