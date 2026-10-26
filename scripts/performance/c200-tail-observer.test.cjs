'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeReturn, tap, callbackTap, driverTap } = require('./c200-tail-observer.cjs');
test('passive settlement returns exact fulfilled and rejected promises', async () => {
  const value = {}; const p = Promise.resolve(value); const seen = [];
  assert.equal(observeReturn(p, (error, result) => seen.push([error, result])), p);
  await p; assert.deepEqual(seen, [[null, value]]);
  const error = new Error('original'); const rejected = Promise.reject(error);
  assert.equal(observeReturn(rejected, e => { assert.equal(e, error); throw new Error('observer'); }), rejected);
  await assert.rejects(rejected, e => e === error);
});
test('tap preserves receiver, arguments, original value, and synchronous throw', () => {
  const receiver = {}, arg = {}, value = {}; let count = 0;
  const wrapped = tap(function(a) { assert.equal(this, receiver); assert.equal(a, arg); return value; }, () => { count++; throw Error('observer'); }, () => { throw Error('observer'); });
  assert.equal(wrapped.call(receiver, arg), value); assert.equal(count, 1);
  const error = Error('original'); const fail = tap(() => { throw error; }, () => {}, () => { throw Error('observer'); });
  assert.throws(fail, e => e === error);
});
test('tap never substitutes a promise identity used as an external weak-map key', async () => {
  const promise = Promise.resolve({}); const registry = new WeakMap([[promise, 'original']]);
  const wrapped = tap(() => promise, () => ({}), () => {});
  const returned = wrapped(); assert.equal(returned, promise); assert.equal(registry.get(returned), 'original'); await returned;
});
test('callback tap forwards synchronously with original receiver, args, return, and throw', () => {
  const error = Error('original'), result = {}, receiver = {}, returned = {}, calls = [];
  const wrapped = callbackTap(function(e, r) { calls.push('callback'); assert.equal(this, receiver); assert.equal(e, error); assert.equal(r, result); return returned; }, () => { calls.push('observer'); throw Error('observer'); });
  assert.equal(wrapped.call(receiver, error, result), returned); assert.deepEqual(calls, ['observer', 'callback']);
  const fail = callbackTap(() => { throw error; }, () => {}); assert.throws(fail, e => e === error);
});

test('actual driver wrapper preserves promise/callback/config overload semantics', async () => {
  const value = {}, promise = Promise.resolve(value), config = { text: 'fixed' }, seen = [];
  const proto = { query(arg, callback) { assert.equal(this.marker, 'receiver'); assert.equal(arg, config); if (callback) { callback.call(this, null, value); return undefined; } return promise; } };
  driverTap(proto, 'query', () => ({}), (_row, receiver, error, result) => { seen.push([receiver, error, result]); });
  const client = Object.assign(Object.create(proto), { marker: 'receiver' });
  assert.equal(client.query(config), promise); await promise;
  let callbackRan = false;
  const ret = client.query(config, function(error, result) { assert.equal(this, client); assert.equal(error, null); assert.equal(result, value); callbackRan = true; });
  assert.equal(ret, undefined); assert.equal(callbackRan, true); assert.equal(seen.length, 2);
  const configWithCallback = { callback() {} }; const returned = {};
  const unknown = { query(arg) { assert.equal(arg, configWithCallback); return returned; } };
  driverTap(unknown, 'query', () => ({}), () => { throw Error('not called'); });
  assert.equal(unknown.query(configWithCallback), returned);
});

test('queued pool callback restores only diagnostic ALS, not application ALS', () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const http = new AsyncLocalStorage(), span = new AsyncLocalStorage(), application = new AsyncLocalStorage();
  const pending = []; const client = {}; const result = {}; const receiver = {};
  const pool = { connect(callback) { pending.push(callback); return undefined; } };
  driverTap(pool, 'connect', () => ({}), () => {}, callback => {
    const h = http.getStore(), s = span.getStore();
    return function(...args) { const self = this; return http.run(h, () => span.run(s, () => callback.apply(self, args))); };
  });
  const seen = [];
  application.run('application-request-A', () => http.run('http-A', () => span.run('span-A', () => {
    assert.equal(pool.connect(function(error, value) { seen.push([http.getStore(), span.getStore(), application.getStore()]); assert.equal(this, receiver); assert.equal(error, null); assert.equal(value, client); return result; }), undefined);
  })));
  application.run('application-releaser-B', () => http.run('http-B', () => span.run('span-B', () => {
    assert.equal(pending.shift().call(receiver, null, client), result);
    assert.equal(http.getStore(), 'http-B'); assert.equal(span.getStore(), 'span-B');
  })));
  assert.deepEqual(seen, [['http-A', 'span-A', 'application-releaser-B']]);
});
