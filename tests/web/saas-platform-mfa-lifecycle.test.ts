import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformApiError, type PlatformMfaEnrollmentStart } from '../../web/src/api/saas-platform-client.ts';
import {
  createMfaEnrollmentLifecycle,
  mfaEnrollmentNotice,
  type MfaEnrollmentClient,
  type MfaEnrollmentClock,
  type MfaEnrollmentState,
} from '../../web/src/features/saas-platform-mfa-lifecycle.ts';

const TOKEN = 'synthetic-cli-enrollment-token';
const CONFIRMATION = 'synthetic-confirmation-token';
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/model-router:operator%40example.test?secret=${SECRET}&issuer=model-router`;

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {
    promise,
    resolve(value: T) { assert.ok(resolve); resolve(value); },
    reject(error: unknown) { assert.ok(reject); reject(error); },
  };
}

class Clock implements MfaEnrollmentClock {
  private time = Date.parse('2030-01-01T00:00:00.000Z');
  private sequence = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.sequence;
    this.jobs.set(id, { at: this.time + delayMs, callback });
    return () => { this.jobs.delete(id); };
  }
  advance(ms: number, runTimers = true) {
    this.time += ms;
    if (runTimers) {
      for (const [id, job] of this.jobs) {
        if (job.at <= this.time) { this.jobs.delete(id); job.callback(); }
      }
    }
  }
  get pendingTimers() { return this.jobs.size; }
}

function enrollment(clock: Clock, ttl = 1_000): PlatformMfaEnrollmentStart {
  return { otpauthUri: URI, confirmationToken: CONFIRMATION, expiresAt: new Date(clock.now() + ttl).toISOString() };
}

function client(clock: Clock, overrides: Partial<MfaEnrollmentClient> = {}): MfaEnrollmentClient {
  return {
    startMfaEnrollment: async () => enrollment(clock),
    confirmMfaEnrollment: async () => ({ confirmed: true }),
    ...overrides,
  };
}

function assertCleared(state: MfaEnrollmentState) {
  const serialized = JSON.stringify(state);
  for (const sensitive of [TOKEN, CONFIRMATION, SECRET, URI, '123456']) {
    assert.equal(serialized.includes(sensitive), false);
  }
  assert.equal(Object.hasOwn(state, 'enrollment'), false);
}

test('start and confirm are synchronously single-flight with exact client arguments and submit-time clearing', async () => {
  const clock = new Clock();
  const starting = deferred<PlatformMfaEnrollmentStart>();
  const confirming = deferred<{ confirmed: boolean }>();
  let starts = 0;
  let confirms = 0;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    startMfaEnrollment: async (issuer, token, options) => {
      ++starts;
      assert.equal(issuer, 'model-router');
      assert.equal(token, TOKEN);
      assert.equal(options.signal.aborted, false);
      return starting.promise;
    },
    confirmMfaEnrollment: async (token, code, options) => {
      ++confirms;
      assert.equal(token, CONFIRMATION);
      assert.equal(code, '123456');
      assert.equal(options.signal.aborted, false);
      return confirming.promise;
    },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    const firstStart = lifecycle.start('model-router', TOKEN);
    assert.equal(lifecycle.getState().kind, 'starting');
    assert.equal(await lifecycle.start('model-router', TOKEN), false);
    assert.equal(starts, 1);
    starting.resolve(enrollment(clock));
    assert.equal(await firstStart, true);
    const ready = lifecycle.getState();
    assert.equal(ready.kind, 'awaiting-confirmation');
    if (ready.kind !== 'awaiting-confirmation') assert.fail('Expected enrollment');
    assert.equal(ready.enrollment.otpauthUri, URI);
    assert.ok(Object.isFrozen(ready.enrollment));

    const firstConfirm = lifecycle.confirm('123456');
    assert.equal(lifecycle.getState().kind, 'confirming');
    assertCleared(lifecycle.getState());
    assert.equal(await lifecycle.confirm('123456'), false);
    assert.equal(confirms, 1);
    confirming.resolve({ confirmed: true });
    await firstConfirm;
    assert.equal(lifecycle.getState().kind, 'confirmed');
    assertCleared(lifecycle.getState());
    assert.equal(clock.pendingTimers, 0);
    assert.equal(await lifecycle.start('model-router', TOKEN), false);
    assert.equal(await lifecycle.confirm('123456'), false);
  } finally { unmount(); }
});

test('expiry clears secrets and refuses confirm even if a background timer has not run', async () => {
  const clock = new Clock();
  let confirms = 0;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async () => { ++confirms; return { confirmed: true }; },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.start('model-router', TOKEN);
    clock.advance(1_000, false);
    assert.equal(await lifecycle.confirm('123456'), false);
    assert.deepEqual(lifecycle.getState(), { kind: 'expired', confirmationSubmitted: false });
    assertCleared(lifecycle.getState());
    assert.equal(confirms, 0);
    assert.equal(clock.pendingTimers, 0);
    assert.match(mfaEnrollmentNotice(lifecycle.getState()) ?? '', /安全 CLI/);
  } finally { unmount(); }
});

test('timer expiry during confirmation aborts local waiting and fences even a late successful response', async () => {
  const clock = new Clock();
  const response = deferred<{ confirmed: boolean }>();
  let signal: AbortSignal | undefined;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async (_token, _code, options) => { signal = options.signal; return response.promise; },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.start('model-router', TOKEN);
    const operation = lifecycle.confirm('123456');
    clock.advance(1_000);
    assert.deepEqual(lifecycle.getState(), { kind: 'expired', confirmationSubmitted: true });
    assert.ok(signal?.aborted);
    assertCleared(lifecycle.getState());
    assert.match(mfaEnrollmentNotice(lifecycle.getState()) ?? '', /确认结果未知/);
    response.resolve({ confirmed: true });
    await operation;
    assert.equal(lifecycle.getState().kind, 'expired');
    assert.equal(clock.pendingTimers, 0);
  } finally { unmount(); }
});

test('cancel fences a late start and retains the flight guard until its real promise settles', async () => {
  const clock = new Clock();
  const response = deferred<PlatformMfaEnrollmentStart>();
  let starts = 0;
  let signal: AbortSignal | undefined;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    startMfaEnrollment: async (_issuer, _token, options) => {
      ++starts; signal = options.signal; return response.promise;
    },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    const operation = lifecycle.start('model-router', TOKEN);
    lifecycle.cancel();
    assert.ok(signal?.aborted);
    assert.equal(lifecycle.getState().kind, 'unknown');
    assertCleared(lifecycle.getState());
    assert.equal(await lifecycle.start('model-router', TOKEN), false);
    response.resolve(enrollment(clock)); // Port deliberately ignores abort: epoch must still protect state.
    await operation;
    assert.equal(lifecycle.getState().kind, 'unknown');
    assert.equal(starts, 1);
    assert.equal(clock.pendingTimers, 0);
    assert.equal(await lifecycle.start('model-router', TOKEN), false);
  } finally { unmount(); }
});

test('unmount/remount isolates late confirmation and stale cleanup cannot detach the newer listener', async () => {
  const clock = new Clock();
  const response = deferred<{ confirmed: boolean }>();
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async () => response.promise,
  }), clock);
  const firstStates: MfaEnrollmentState[] = [];
  const firstUnmount = lifecycle.mount(state => firstStates.push(state));
  await lifecycle.start('model-router', TOKEN);
  const operation = lifecycle.confirm('123456');
  firstUnmount();
  const firstCount = firstStates.length;
  const secondStates: MfaEnrollmentState[] = [];
  const secondUnmount = lifecycle.mount(state => secondStates.push(state));
  try {
    firstUnmount();
    response.resolve({ confirmed: true });
    await operation;
    assert.equal(firstStates.length, firstCount);
    assert.deepEqual(secondStates, [{ kind: 'unknown' }]);
    assertCleared(lifecycle.getState());
    assert.equal(clock.pendingTimers, 0);
    lifecycle.cancel();
    assert.equal(secondStates.length, 2);
    assert.equal(secondStates.at(-1)?.kind, 'unknown');
  } finally { secondUnmount(); }
});

test('leaving or cancelling an unsubmitted configuration clears it without claiming server revocation', async () => {
  for (const action of ['cancel', 'unmount'] as const) {
    const clock = new Clock();
    const lifecycle = createMfaEnrollmentLifecycle(client(clock), clock);
    const unmount = lifecycle.mount(() => {});
    await lifecycle.start('model-router', TOKEN);
    if (action === 'cancel') lifecycle.cancel();
    else unmount();
    assert.equal(lifecycle.getState().kind, 'cancelled');
    assertCleared(lifecycle.getState());
    assert.equal(clock.pendingTimers, 0);
    assert.match(mfaEnrollmentNotice(lifecycle.getState()) ?? '', /不会撤销/);
    unmount();
  }
});

test('known API rejection uses only exact code/status and clears failed confirmation secrets', async () => {
  const clock = new Clock();
  const raw = `${TOKEN} ${CONFIRMATION} ${URI} 123456`;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async () => { throw new PlatformApiError(401, 'MFA_CONFIRMATION_INVALID', raw, raw); },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.start('model-router', TOKEN);
    await lifecycle.confirm('123456');
    assert.deepEqual(lifecycle.getState(), { kind: 'rejected', reason: 'confirmation_invalid' });
    assertCleared(lifecycle.getState());
    const notice = mfaEnrollmentNotice(lifecycle.getState()) ?? '';
    assert.equal(notice.includes(raw), false);
    assert.match(notice, /先返回登录验证/);
    assert.equal(clock.pendingTimers, 0);
  } finally { unmount(); }
});

test('a denied start never retains raw error data or presents an automatic reissue/retry action', async () => {
  const clock = new Clock();
  const raw = `${TOKEN} ${CONFIRMATION} ${URI}`;
  let calls = 0;
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    startMfaEnrollment: async () => { ++calls; throw new PlatformApiError(401, 'MFA_ENROLLMENT_TOKEN_INVALID', raw, raw); },
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.start('model-router', TOKEN);
    assert.deepEqual(lifecycle.getState(), { kind: 'rejected', reason: 'token_invalid' });
    assertCleared(lifecycle.getState());
    assert.equal(await lifecycle.start('model-router', TOKEN), false);
    assert.equal(calls, 1);
    assert.equal((mfaEnrollmentNotice(lifecycle.getState()) ?? '').includes(raw), false);
    assert.match(mfaEnrollmentNotice(lifecycle.getState()) ?? '', /安全 CLI 核查状态/);
  } finally { unmount(); }
});

test('late rejection after unmount does not publish an error to another mount', async () => {
  const clock = new Clock();
  const response = deferred<PlatformMfaEnrollmentStart>();
  const lifecycle = createMfaEnrollmentLifecycle(client(clock, { startMfaEnrollment: async () => response.promise }), clock);
  const unmount = lifecycle.mount(() => {});
  const operation = lifecycle.start('model-router', TOKEN);
  unmount();
  const states: MfaEnrollmentState[] = [];
  const unmountAgain = lifecycle.mount(state => states.push(state));
  try {
    response.reject(new PlatformApiError(401, 'MFA_ENROLLMENT_TOKEN_INVALID', URI));
    await operation;
    assert.deepEqual(states, [{ kind: 'unknown' }]);
    assertCleared(lifecycle.getState());
  } finally { unmountAgain(); }
});

test('network, abort, invalid response, arbitrary code and wrong code/status remain unknown with no automatic retry', async () => {
  const raw = `${TOKEN} ${URI}`;
  const errors: unknown[] = [
    new PlatformApiError(0, 'NETWORK', raw),
    new PlatformApiError(200, 'INVALID_RESPONSE', raw),
    new PlatformApiError(500, raw, raw),
    new PlatformApiError(500, 'MFA_ENROLLMENT_TOKEN_INVALID', raw),
    new DOMException(raw, 'AbortError'),
    Object.defineProperty({}, 'message', { get() { assert.fail('Do not read raw error messages'); } }),
  ];
  for (const error of errors) {
    const clock = new Clock();
    let calls = 0;
    const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
      startMfaEnrollment: async () => { ++calls; throw error; },
    }), clock);
    const unmount = lifecycle.mount(() => {});
    try {
      await lifecycle.start('model-router', TOKEN);
      assert.equal(lifecycle.getState().kind, 'unknown');
      assertCleared(lifecycle.getState());
      assert.equal(await lifecycle.start('model-router', TOKEN), false);
      assert.equal(calls, 1);
      assert.equal((mfaEnrollmentNotice(lifecycle.getState()) ?? '').includes(raw), false);
      assert.match(mfaEnrollmentNotice(lifecycle.getState()) ?? '', /不能证明服务端未生效/);
    } finally { unmount(); }
  }
});

test('invalid or already expired start responses never publish a secret-bearing configuration', async () => {
  for (const variant of ['invalid-date', 'expired', 'invalid-uri'] as const) {
    const clock = new Clock();
    const result = enrollment(clock, variant === 'expired' ? 0 : 1_000);
    if (variant === 'invalid-date') result.expiresAt = 'not-a-date';
    if (variant === 'invalid-uri') result.otpauthUri = '<script>synthetic-response-secret</script>';
    const states: MfaEnrollmentState[] = [];
    const lifecycle = createMfaEnrollmentLifecycle(client(clock, { startMfaEnrollment: async () => result }), clock);
    const unmount = lifecycle.mount(state => states.push(state));
    try {
      await lifecycle.start('model-router', TOKEN);
      assert.equal(lifecycle.getState().kind, variant === 'expired' ? 'expired' : 'unknown');
      assert.ok(states.every(state => state.kind !== 'awaiting-confirmation'));
      assertCleared(lifecycle.getState());
      assert.equal(clock.pendingTimers, 0);
    } finally { unmount(); }
  }
});

test('local validation and a non-confirmed response cannot create success or dispatch another operation', async () => {
  const clock = new Clock();
  let calls = 0;
  const invalid = createMfaEnrollmentLifecycle(client(clock, {
    startMfaEnrollment: async () => { ++calls; return enrollment(clock); },
  }), clock);
  const unmountInvalid = invalid.mount(() => {});
  await invalid.start('', TOKEN);
  assert.deepEqual(invalid.getState(), { kind: 'rejected', reason: 'input_invalid' });
  assert.equal(calls, 0);
  unmountInvalid();

  const invalidCode = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async () => { ++calls; return { confirmed: true }; },
  }), clock);
  const unmountInvalidCode = invalidCode.mount(() => {});
  try {
    await invalidCode.start('model-router', TOKEN);
    await invalidCode.confirm('12345');
    assert.deepEqual(invalidCode.getState(), { kind: 'rejected', reason: 'input_invalid' });
    assertCleared(invalidCode.getState());
    assert.equal(calls, 0);
    assert.equal(clock.pendingTimers, 0);
  } finally { unmountInvalidCode(); }

  const lifecycle = createMfaEnrollmentLifecycle(client(clock, {
    confirmMfaEnrollment: async () => ({ confirmed: false }),
  }), clock);
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.start('model-router', TOKEN);
    await lifecycle.confirm('123456');
    assert.equal(lifecycle.getState().kind, 'unknown');
    assertCleared(lifecycle.getState());
    assert.equal(await lifecycle.confirm('123456'), false);
  } finally { unmount(); }
});
