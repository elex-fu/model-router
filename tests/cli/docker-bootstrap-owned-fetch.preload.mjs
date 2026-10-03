import { fileURLToPath } from 'node:url';

// Test-owned child preload ONLY. No env/config/key reads, server creation or fallback.
// Parent starts the real admin fixture on port 0 BEFORE supplying this exact endpoint.
const denied = () => { throw new Error('DOCKER_FIXTURE_ISOLATION_DENIED'); };
const helper = fileURLToPath(new URL('../../deploy/docker/bootstrap.mjs', import.meta.url));
const targetPrefix = '--owned-bootstrap-url=';
const modePrefix = '--owned-bootstrap-mode=';
if (process.argv.length !== 4 || process.argv[1] !== helper ||
    !process.argv[2].startsWith(targetPrefix) || !process.argv[3].startsWith(modePrefix)) denied();
const rawTarget = process.argv[2].slice(targetPrefix.length);
let target;
try { target = new URL(rawTarget); } catch { denied(); }
if (target.href !== rawTarget || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{0,4}$/.test(target.port) || Number(target.port) > 65535 || target.port === '15006' ||
    target.pathname !== '/admin/api/v1/bootstrap' || target.username || target.password || target.search || target.hash) denied();
const mode = process.argv[3].slice(modePrefix.length);
if (mode !== 'submit' && mode !== 'cancel') denied();
const nativeFetch = globalThis.fetch;
if (typeof nativeFetch !== 'function') denied();
let attempts = 0;
Object.defineProperty(globalThis, 'fetch', {
  configurable: false, writable: false,
  value: async (input, init) => {
    // Cancel cannot network. No URL object, Request, alternate host/path/method or
    // inherited/default target can reach native fetch. Bound synthetic input only.
    if (mode !== 'submit' || ++attempts !== 1 ||
        input !== 'http://127.0.0.1:15006/admin/api/v1/bootstrap' ||
        !init || Object.keys(init).sort().join(',') !== 'body,headers,method' || init.method !== 'POST' ||
        !init.headers || Object.keys(init.headers).join(',') !== 'Content-Type' ||
        init.headers['Content-Type'] !== 'application/json' || typeof init.body !== 'string' ||
        Buffer.byteLength(init.body) > 1024) denied();
    let body;
    try { body = JSON.parse(init.body); } catch { denied(); }
    if (!body || Object.keys(body).sort().join(',') !== 'name,password,token' ||
        body.token !== 'DUMMY_TOKEN' || body.name !== 'owner' || body.password !== 'DUMMY_PASSWORD_123') denied();
    process.stderr.write('DOCKER_FIXTURE_FETCH=OWNED_POST\n');
    const response = await nativeFetch.call(globalThis, target.href,
      { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (response.status !== 403) denied();
    process.stderr.write('DOCKER_FIXTURE_STATUS=403\n');
    return response; // REAL createAdminServer invalid-token response, not a mocked body.
  },
});
process.stderr.write(mode === 'submit' ? 'DOCKER_FIXTURE_READY=SUBMIT\n' : 'DOCKER_FIXTURE_READY=CANCEL\n');
