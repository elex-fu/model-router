import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiStateEvent,
  get,
  getRevision,
  request,
  setCsrfToken,
  setRevision,
  writeHeaders,
} from '../../web/src/api/client.ts';

test('expired session clears in-memory auth state and emits one redirect signal', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  const states: string[] = [];
  events.addEventListener(apiStateEvent, (event) => states.push((event as CustomEvent<string>).detail));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  setCsrfToken('csrf-secret');
  setRevision(7);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Login required' } }), {
      status: 401,
    });
  };
  try {
    await assert.rejects(get('/system'), { status: 401 });
    assert.equal(calls, 1);
    assert.deepEqual(states, ['unauthorized']);
    assert.equal(getRevision(), undefined);
    assert.equal(writeHeaders()['X-CSRF-Token'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('invalid login credentials do not emit session-expired event', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  const states: string[] = [];
  events.addEventListener(apiStateEvent, (event) => states.push((event as CustomEvent<string>).detail));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS' } }), { status: 401 });
  try {
    await assert.rejects(request('/session', { method: 'POST', body: { name: 'admin', password: 'wrong' } }), {
      status: 401,
    });
    assert.deepEqual(states, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('configuration revision conflict emits a global notice signal', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  const states: string[] = [];
  events.addEventListener(apiStateEvent, (event) => states.push((event as CustomEvent<string>).detail));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'CONFIG_REVISION_CONFLICT' } }), { status: 412 });
  setRevision(7);
  try {
    await assert.rejects(request('/routes', { method: 'PATCH', body: { name: 'test' } }), { status: 412 });
    assert.deepEqual(states, ['config-conflict']);
    assert.equal(getRevision(), 7);
  } finally {
    setRevision(undefined);
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
