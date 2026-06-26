const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-***' },
  { re: /Bearer\s+[A-Za-z0-9_\-\.~+\/]+={0,2}/g, replacement: 'Bearer ***' },
  { re: /(x-api-key\s*[:=]\s*)[^\s]+/gi, replacement: '$1***' },
  { re: /(api-key\s*[:=]\s*)[^\s]+/gi, replacement: '$1***' },
  { re: /\b(gh[ousr]_[A-Za-z0-9]{20,})/g, replacement: '***' },
];

export function redactSecrets<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string') return value;
  let result: string = value;
  for (const { re, replacement } of SECRET_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result as T;
}
