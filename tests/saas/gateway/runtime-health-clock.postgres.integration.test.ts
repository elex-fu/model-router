import { test } from 'node:test';
import {
  HEALTH_CLOCK_REQUIRED,
  healthClockDatabases,
  healthClockPgConfigured,
  proveRuntimeHealthFutureRejected,
  proveRuntimeHealthGuard,
  proveRuntimeHealthWaitClock,
  safeHealthClockFailure,
} from './runtime-health-clock-postgres-fixture.js';

async function proof(work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    throw safeHealthClockFailure(error);
  }
}

test('runtime health writes sample the database clock after the actual conflict row lock under restricted roles', {
  skip:
    process.env[HEALTH_CLOCK_REQUIRED] !== '1' && !healthClockPgConfigured
      ? `set ${HEALTH_CLOCK_REQUIRED}=1 and all three disposable gateway E2E role URLs to require this gate`
      : false,
  timeout: 120_000,
}, async (t) => {
  const { databases, migrator, gateway } = await healthClockDatabases();
  try {
    await t.test(
      'success F2 waits for H/F1 then applies using a fresh microsecond DB clock; F1 replay is unchanged',
      () => proof(() => proveRuntimeHealthWaitClock(migrator, gateway, 'success')),
    );
    await t.test('failure F2 waits then applies exactly one EMA vote and an exact shared-clock cooldown', () =>
      proof(() => proveRuntimeHealthWaitClock(migrator, gateway, 'network-failure')),
    );
    for (const isolation of ['read committed', 'repeatable read', 'serializable'] as const) {
      for (const outcome of ['success', 'network-failure'] as const) {
        await t.test(`atomic adapter under ${isolation}: concurrent ${outcome} keeps post-lock clock and fences`, () =>
          proof(() => proveRuntimeHealthWaitClock(migrator, gateway, outcome, isolation)),
        );
      }
    }
    await t.test('a genuinely future stored observation still rejects a legitimate newer lease with 55000', () =>
      proof(() => proveRuntimeHealthFutureRejected(migrator, gateway)),
    );
    await t.test('040 still rejects a real one-microsecond backward write and rolls it back', () =>
      proof(() => proveRuntimeHealthGuard(migrator, gateway, 'backward-time')),
    );
    await t.test('040 still rejects equal and older source fencing tokens without changing any field', () =>
      proof(() => proveRuntimeHealthGuard(migrator, gateway, 'non-increasing-token')),
    );
    await t.test('040 still rejects a revision jump without changing any field', () =>
      proof(() => proveRuntimeHealthGuard(migrator, gateway, 'revision-jump')),
    );
  } catch (error) {
    throw safeHealthClockFailure(error);
  } finally {
    await Promise.allSettled(databases.map((database) => database.close()));
  }
});
