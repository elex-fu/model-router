/** Join an API prefix and a fixed relative endpoint without discarding the prefix. */
export function joinApiUrl(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash)
    throw new Error('Invalid upstream base URL');
  if (
    !endpoint ||
    endpoint.startsWith('/') ||
    endpoint.includes('?') ||
    endpoint.includes('#') ||
    endpoint.includes('\\') ||
    /(^|\/)\.{1,2}(\/|$)/.test(endpoint) ||
    /%2f|%5c|%2e/i.test(endpoint) ||
    !/^[a-zA-Z0-9/_-]+$/.test(endpoint)
  )
    throw new Error('Invalid upstream endpoint');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${endpoint}`;
  return base;
}
