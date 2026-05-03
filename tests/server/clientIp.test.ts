import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { getClientIp } from '../../src/server/clientIp.js';

function mockReq(opts: {
  remoteAddress?: string;
  xForwardedFor?: string | string[];
}): IncomingMessage {
  return {
    headers: {
      ...(opts.xForwardedFor ? { 'x-forwarded-for': opts.xForwardedFor } : {}),
    },
    socket: { remoteAddress: opts.remoteAddress } as any,
  } as any;
}

test('getClientIp: trustProxy=false ignores X-Forwarded-For header', () => {
  const req = mockReq({
    remoteAddress: '10.0.0.1',
    xForwardedFor: '8.8.8.8',
  });
  assert.equal(getClientIp(req, false), '10.0.0.1');
});

test('getClientIp: trustProxy=false uses socket address only', () => {
  const req = mockReq({ remoteAddress: '10.0.0.1' });
  assert.equal(getClientIp(req, false), '10.0.0.1');
});

test('getClientIp: trustProxy=true uses first XFF entry', () => {
  const req = mockReq({
    remoteAddress: '10.0.0.1',
    xForwardedFor: '203.0.113.4, 198.51.100.5, 10.0.0.1',
  });
  assert.equal(getClientIp(req, true), '203.0.113.4');
});

test('getClientIp: trustProxy=true falls back to socket when XFF missing', () => {
  const req = mockReq({ remoteAddress: '10.0.0.1' });
  assert.equal(getClientIp(req, true), '10.0.0.1');
});

test('getClientIp: trustProxy=true ignores empty XFF', () => {
  const req = mockReq({ remoteAddress: '10.0.0.1', xForwardedFor: '' });
  assert.equal(getClientIp(req, true), '10.0.0.1');
});

test('getClientIp: trustProxy=true trims whitespace', () => {
  const req = mockReq({
    remoteAddress: '10.0.0.1',
    xForwardedFor: '   1.2.3.4   , 5.6.7.8',
  });
  assert.equal(getClientIp(req, true), '1.2.3.4');
});

test('getClientIp: trustProxy=true handles array header (only first array entry)', () => {
  const req = mockReq({
    remoteAddress: '10.0.0.1',
    xForwardedFor: ['1.2.3.4, 9.9.9.9', '8.8.8.8'],
  });
  assert.equal(getClientIp(req, true), '1.2.3.4');
});

test('getClientIp: returns empty string when no socket and no XFF', () => {
  const req = mockReq({});
  assert.equal(getClientIp(req, false), '');
  assert.equal(getClientIp(req, true), '');
});
