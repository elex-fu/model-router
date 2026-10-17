import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  type CustomerMfaChanged,
  CustomerMfaDeploymentUnavailableError,
  type CustomerMfaEnrollment,
  SaasApiError,
} from '../../web/src/api/saas-client.ts';
import {
  type CustomerMfaClient,
  type CustomerMfaClock,
  type CustomerMfaState,
  createCustomerMfaLifecycle,
} from '../../web/src/features/saas-customer-mfa-lifecycle.ts';

const password = 'synthetic-password-not-a-real-key';
const token = 'synthetic-confirmation-token-001';
const secret = 'JBSWY3DPEHPK3PXP';
const uri = `otpauth://totp/model-router:customer?secret=${secret}&issuer=model-router`;
class Clock implements CustomerMfaClock {
  time = Date.parse('2030-01-01T00:00:00.000Z');
  jobs = new Set<() => void>();
  now() {
    return this.time;
  }
  schedule(callback: () => void) {
    this.jobs.add(callback);
    return () => {
      this.jobs.delete(callback);
    };
  }
  expire() {
    this.time += 300_000;
    for (const callback of [...this.jobs]) {
      this.jobs.delete(callback);
      callback();
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(): CustomerMfaEnrollment {
  return { secret, otpauthUri: uri, confirmationToken: token, expiresAt: '2030-01-01T00:05:00.000Z' };
}
function fixture(enabled = false, overrides: Partial<CustomerMfaClient> = {}) {
  const clock = new Clock();
  let signIns = 0;
  let scope = true;
  const states: CustomerMfaState[] = [];
  const client: CustomerMfaClient = {
    getCustomerMfaStatus: async () => ({ enabled }),
    startCustomerMfaEnrollment: async () => setup(),
    confirmCustomerMfaEnrollment: async () => ({ enabled: true, sessionsRevoked: 1, signInRequired: true }),
    revokeCustomerMfa: async () => ({ enabled: false, sessionsRevoked: 1, signInRequired: true }),
    ...overrides,
  };
  const lifecycle = createCustomerMfaLifecycle({
    client,
    clock,
    isCurrent: () => scope,
    onSignInRequired: () => {
      ++signIns;
    },
  });
  const unmount = lifecycle.mount((state) => states.push(state));
  return {
    clock,
    lifecycle,
    states,
    unmount,
    get signIns() {
      return signIns;
    },
    replaceScope() {
      scope = false;
    },
  };
}
function cleared(state: CustomerMfaState) {
  const serialized = JSON.stringify(state);
  for (const value of [password, token, secret, uri, '111111', '222222', '333333'])
    assert.equal(serialized.includes(value), false);
  assert.equal(Object.hasOwn(state, 'configuration'), false);
}

test('authoritative status precedes start; setup is memory-only and token never enters published view', async () => {
  let starts = 0;
  const f = fixture(false, {
    startCustomerMfaEnrollment: async (input) => {
      ++starts;
      assert.deepEqual(input, { password });
      return setup();
    },
  });
  try {
    assert.equal(await f.lifecycle.start({ password }), false);
    assert.equal(starts, 0);
    await f.lifecycle.refresh();
    assert.equal(f.lifecycle.getState().enabled, false);
    await f.lifecycle.start({ password });
    const state = f.lifecycle.getState();
    assert.equal(state.kind, 'enrollment');
    assert.equal(state.enabled, false); // Not optimistically enabled.
    assert.equal(JSON.stringify(state).includes(token), false);
    if (state.kind !== 'enrollment') assert.fail('Expected memory-only configuration');
    assert.equal(state.configuration.secret, secret);
    assert.ok(Object.isFrozen(state.configuration));
  } finally {
    f.unmount();
  }
});

test('successful confirm clears setup before dispatch and requires actual auth invalidation once, never a fake enabled view', async () => {
  const response = deferred<CustomerMfaChanged>();
  let inputSeen = false;
  const f = fixture(false, {
    confirmCustomerMfaEnrollment: async (input) => {
      inputSeen = true;
      assert.deepEqual(input, { password, code: '333333', confirmationToken: token });
      cleared(f.lifecycle.getState());
      return response.promise;
    },
  });
  try {
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password });
    const work = f.lifecycle.confirm({ password, code: '333333' });
    assert.equal(inputSeen, true);
    cleared(f.lifecycle.getState());
    assert.equal(await f.lifecycle.confirm({ password, code: '333333' }), false);
    response.resolve({ enabled: true, sessionsRevoked: 3, signInRequired: true });
    await work;
    assert.equal(f.signIns, 1);
    assert.equal(f.lifecycle.getState().kind, 'sign-in-required');
    assert.equal(f.lifecycle.getState().enabled, null);
    assert.equal(await f.lifecycle.refresh(), false);
    assert.equal(await f.lifecycle.start({ password }), false);
    cleared(f.lifecycle.getState());
    assert.equal(f.clock.jobs.size, 0);
  } finally {
    f.unmount();
  }
});

test('replacement retains original enabled status until confirmation and requests fresh password/current TOTP twice', async () => {
  const seen: unknown[] = [];
  const f = fixture(true, {
    startCustomerMfaEnrollment: async (input) => {
      seen.push(input);
      return setup();
    },
    confirmCustomerMfaEnrollment: async (input) => {
      seen.push(input);
      return { enabled: true, sessionsRevoked: 1, signInRequired: true };
    },
  });
  try {
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password, currentTotpCode: '111111' });
    assert.equal(f.lifecycle.getState().enabled, true);
    await f.lifecycle.confirm({ password, currentTotpCode: '222222', code: '333333' });
    assert.deepEqual(seen, [
      { password, currentTotpCode: '111111' },
      { password, currentTotpCode: '222222', code: '333333', confirmationToken: token },
    ]);
    assert.equal(f.signIns, 1);
  } finally {
    f.unmount();
  }
});

test('enabled replacement without current TOTP is rejected locally and missing fresh confirm code clears setup', async () => {
  let starts = 0;
  let confirms = 0;
  const f = fixture(true, {
    startCustomerMfaEnrollment: async () => {
      ++starts;
      return setup();
    },
    confirmCustomerMfaEnrollment: async () => {
      ++confirms;
      return { enabled: true, sessionsRevoked: 1, signInRequired: true };
    },
  });
  try {
    await f.lifecycle.refresh();
    assert.equal(await f.lifecycle.start({ password }), false);
    assert.equal(starts, 0);
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password, currentTotpCode: '111111' });
    assert.equal(await f.lifecycle.confirm({ password, code: '333333' }), false);
    assert.equal(confirms, 0);
    cleared(f.lifecycle.getState());
  } finally {
    f.unmount();
  }
});

test('revoke uses real password and current code, clears once and requires sign-in', async () => {
  let revokes = 0;
  const f = fixture(true, {
    revokeCustomerMfa: async (input) => {
      ++revokes;
      assert.deepEqual(input, { password, code: '111111' });
      return { enabled: false, sessionsRevoked: 2, signInRequired: true };
    },
  });
  try {
    await f.lifecycle.refresh();
    assert.equal(f.lifecycle.choose('revoke'), true);
    await f.lifecycle.revoke({ password, code: '111111' });
    assert.equal(revokes, 1);
    assert.equal(f.signIns, 1);
    cleared(f.lifecycle.getState());
    assert.equal(await f.lifecycle.revoke({ password, code: '111111' }), false);
  } finally {
    f.unmount();
  }
});

test('denial clears all configuration and keeps only safe selected action; raw poison never rendered or automatically retried', async () => {
  const poison = `${password} ${token} ${uri}`;
  let revokes = 0;
  const f = fixture(true, {
    revokeCustomerMfa: async () => {
      ++revokes;
      throw new SaasApiError(403, 'MFA_CODE_REJECTED', poison, { poison });
    },
  });
  try {
    await f.lifecycle.refresh();
    f.lifecycle.choose('revoke');
    await f.lifecycle.revoke({ password, code: '111111' });
    assert.equal(f.lifecycle.getState().kind, 'blocked');
    assert.equal(f.lifecycle.getState().action, 'revoke');
    cleared(f.lifecycle.getState());
    assert.equal(f.signIns, 0);
    assert.equal(await f.lifecycle.revoke({ password, code: '111111' }), false);
    await f.lifecycle.refresh();
    assert.equal(f.lifecycle.getState().action, 'revoke');
    assert.equal(revokes, 1);
  } finally {
    f.unmount();
  }
});

test('confirm rejection and network unknown clear setup, block repeated POST and never fake success', async () => {
  for (const error of [
    new SaasApiError(403, 'MFA_CODE_REJECTED', uri),
    new SaasApiError(0, 'NETWORK', password),
    new Error(token),
  ]) {
    let confirms = 0;
    const f = fixture(false, {
      confirmCustomerMfaEnrollment: async () => {
        ++confirms;
        throw error;
      },
    });
    try {
      await f.lifecycle.refresh();
      await f.lifecycle.start({ password });
      await f.lifecycle.confirm({ password, code: '333333' });
      cleared(f.lifecycle.getState());
      assert.equal(f.lifecycle.getState().kind, 'blocked');
      assert.equal(await f.lifecycle.confirm({ password, code: '333333' }), false);
      assert.equal(confirms, 1);
      assert.equal(f.signIns, 0);
      assert.equal(f.clock.jobs.size, 0);
    } finally {
      f.unmount();
    }
  }
});

test('cancel after start clears secret/token without server revoke and read refresh never restores them', async () => {
  let revokes = 0;
  const f = fixture(false, {
    revokeCustomerMfa: async () => {
      ++revokes;
      return { enabled: false, sessionsRevoked: 1, signInRequired: true };
    },
  });
  try {
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password });
    f.lifecycle.cancel();
    cleared(f.lifecycle.getState());
    assert.equal(f.clock.jobs.size, 0);
    assert.match(f.lifecycle.getState().notice ?? '', /不会撤销服务端/);
    await f.lifecycle.refresh();
    cleared(f.lifecycle.getState());
    assert.equal(revokes, 0);
  } finally {
    f.unmount();
  }
});

test('cancel in flight aborts local transport, retains single-flight and fences late secret-bearing response', async () => {
  const response = deferred<CustomerMfaEnrollment>();
  let signal: AbortSignal | undefined;
  const f = fixture(false, {
    startCustomerMfaEnrollment: async (_input, options) => {
      signal = options?.signal;
      return response.promise;
    },
  });
  try {
    await f.lifecycle.refresh();
    const work = f.lifecycle.start({ password });
    f.lifecycle.cancel();
    assert.ok(signal?.aborted);
    assert.equal(await f.lifecycle.refresh(), false);
    response.resolve(setup());
    await work;
    cleared(f.lifecycle.getState());
    assert.equal(f.lifecycle.getState().kind, 'blocked');
    assert.equal(f.states.filter((state) => state.kind === 'enrollment').length, 0);
  } finally {
    f.unmount();
  }
});

test('page exit, refresh lifecycle and remount cannot restore password/TOTP/configuration, including BFCache policy', async () => {
  const f = fixture();
  await f.lifecycle.refresh();
  await f.lifecycle.start({ password });
  f.lifecycle.pageExit();
  cleared(f.lifecycle.getState());
  f.unmount();
  const states: CustomerMfaState[] = [];
  const unmountAgain = f.lifecycle.mount((state) => states.push(state));
  try {
    f.unmount(); // Stale cleanup must not detach replacement mount.
    await f.lifecycle.refresh();
    assert.equal(states.at(-1)?.kind, 'ready');
    cleared(f.lifecycle.getState());
    const fresh = fixture();
    try {
      cleared(fresh.lifecycle.getState());
    } finally {
      fresh.unmount();
    }
  } finally {
    unmountAgain();
  }
});

test('expiry removes secret and confirmation token before an expired submission can dispatch', async () => {
  let confirms = 0;
  const f = fixture(false, {
    confirmCustomerMfaEnrollment: async () => {
      ++confirms;
      return { enabled: true, sessionsRevoked: 1, signInRequired: true };
    },
  });
  try {
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password });
    f.clock.expire();
    cleared(f.lifecycle.getState());
    assert.equal(await f.lifecycle.confirm({ password, code: '333333' }), false);
    assert.equal(confirms, 0);
    assert.equal(f.clock.jobs.size, 0);
  } finally {
    f.unmount();
  }
});

test('late confirmation for a replacement login cannot invalidate its authentication', async () => {
  const response = deferred<CustomerMfaChanged>();
  const f = fixture(false, { confirmCustomerMfaEnrollment: async () => response.promise });
  try {
    await f.lifecycle.refresh();
    await f.lifecycle.start({ password });
    const work = f.lifecycle.confirm({ password, code: '333333' });
    f.replaceScope();
    f.unmount();
    response.resolve({ enabled: true, sessionsRevoked: 1, signInRequired: true });
    await work;
    assert.equal(f.signIns, 0);
    cleared(f.lifecycle.getState());
  } finally {
    f.unmount();
  }
});

test('successful server mutation with local cleanup failure stays sign-in-required and never resends', async () => {
  let confirms = 0;
  const clock = new Clock();
  const lifecycle = createCustomerMfaLifecycle({
    clock,
    isCurrent: () => true,
    onSignInRequired: () => {
      throw new Error(password);
    },
    client: {
      getCustomerMfaStatus: async () => ({ enabled: false }),
      startCustomerMfaEnrollment: async () => setup(),
      confirmCustomerMfaEnrollment: async () => {
        ++confirms;
        return { enabled: true, sessionsRevoked: 1, signInRequired: true };
      },
      revokeCustomerMfa: async () => ({ enabled: false, sessionsRevoked: 1, signInRequired: true }),
    },
  });
  const unmount = lifecycle.mount(() => {});
  try {
    await lifecycle.refresh();
    await lifecycle.start({ password });
    await lifecycle.confirm({ password, code: '333333' });
    assert.equal(lifecycle.getState().kind, 'sign-in-required');
    cleared(lifecycle.getState());
    assert.equal(await lifecycle.confirm({ password, code: '333333' }), false);
    assert.equal(confirms, 1);
  } finally {
    unmount();
  }
});

test('current security page binds existing auth invalidation and component explicitly clears DOM on failure/cancel/refresh/unload', () => {
  const page = readFileSync(resolve(process.cwd(), 'web/src/features/saas-console.tsx'), 'utf8');
  const panel = readFileSync(resolve(process.cwd(), 'web/src/features/saas-customer-mfa.tsx'), 'utf8');
  const lifecycle = readFileSync(resolve(process.cwd(), 'web/src/features/saas-customer-mfa-lifecycle.ts'), 'utf8');
  assert.match(page, /<CustomerMfaSettings[\s\S]*?onSignInRequired=\{onCurrentSessionRevoked\}/);
  assert.match(page, /if \(sessionScope\.current !== session\) return;/);
  assert.match(page, /navigate\('\/console\/login', \{ replace: true \}\)/);
  assert.match(panel, /lifecycle\.mount\(next => \{[\s\S]*?clearDomSecrets\(\);[\s\S]*?setState\(next\)/);
  for (const event of ['pagehide', 'beforeunload', 'pageshow', 'visibilitychange'])
    assert.ok(panel.includes(`'${event}'`));
  assert.match(panel, /clearDomSecrets\(\); lifecycle\.pageExit\(\)/);
  assert.match(panel, /fields\.delete\('password'\)/);
  assert.match(panel, /再次输入当前密码/);
  assert.match(panel, /原设备的新验证码/);
  assert.doesNotMatch(
    panel + lifecycle,
    /localStorage|sessionStorage|console\.(log|warn|error)|clipboard|dangerouslySetInnerHTML|href=|URLSearchParams|useMutation/,
  );
  assert.doesNotMatch(panel, /value=\{password\}|value=\{.*[Tt]otp/);
  assert.match(panel, /不表示本次邮箱密码登录已经通过 MFA/);
});

test('authoritative absent capability blocks every mutation with null enabled, while transport and generic 503 are not deployment claims', async () => {
  for (const error of [
    new CustomerMfaDeploymentUnavailableError(),
    new SaasApiError(503, 'UNAVAILABLE', 'deployment-unavailable-v1'),
    new SaasApiError(0, 'NETWORK', password),
  ]) {
    let mutations = 0;
    const f = fixture(false, {
      getCustomerMfaStatus: async () => {
        throw error;
      },
      startCustomerMfaEnrollment: async () => {
        ++mutations;
        return setup();
      },
    });
    try {
      await f.lifecycle.refresh();
      const state = f.lifecycle.getState();
      assert.equal(state.kind, 'blocked');
      assert.equal(state.enabled, null);
      cleared(state);
      assert.equal(
        state.availability,
        error instanceof CustomerMfaDeploymentUnavailableError ? 'deployment-unavailable' : undefined,
      );
      assert.equal(await f.lifecycle.start({ password }), false);
      assert.equal(await f.lifecycle.confirm({ password, code: '333333' }), false);
      assert.equal(await f.lifecycle.revoke({ password, code: '111111' }), false);
      assert.equal(mutations, 0);
      assert.equal(f.signIns, 0);
    } finally {
      f.unmount();
    }
  }
});

test('late unavailable status after cancel or replacement scope cannot publish deployment state or release singleflight', async () => {
  let rejectStatus: (error: unknown) => void = () => {};
  const pending = new Promise<{ enabled: boolean }>((_resolve, reject) => {
    rejectStatus = reject;
  });
  const f = fixture(false, { getCustomerMfaStatus: async () => pending });
  try {
    const work = f.lifecycle.refresh();
    f.lifecycle.cancel();
    assert.equal(await f.lifecycle.refresh(), false);
    f.replaceScope();
    rejectStatus(new CustomerMfaDeploymentUnavailableError());
    await work;
    assert.equal(f.lifecycle.getState().availability, undefined);
    cleared(f.lifecycle.getState());
    assert.equal(
      f.states.some((state) => state.availability === 'deployment-unavailable'),
      false,
    );
  } finally {
    f.unmount();
  }
});

test('deployment-unavailable component has explicit safe wording and cannot render a credential submission form', () => {
  const panel = readFileSync(resolve(process.cwd(), 'web/src/features/saas-customer-mfa.tsx'), 'utf8');
  assert.match(
    panel,
    /state\.availability !== 'deployment-unavailable' && \(state\.kind === 'ready' \|\| state\.kind === 'enrollment'\)/,
  );
  assert.match(panel, /此部署当前不可使用客户 MFA；账号 MFA 状态未确认/);
  assert.match(panel, /\{canSubmit && <form/);
});
