import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManagedSaasFastGatewayConfiguration } from '../../../../src/server/managed-saas-gateway.js';
const environment = {
  MODEL_ROUTER_FAST_GATEWAY: 'reserved-max',
  MODEL_ROUTER_FAST_REDIS_URL: 'redis://127.0.0.1:6379',
  MODEL_ROUTER_FAST_NAMESPACE: 'fixture',
  MODEL_ROUTER_FAST_OWNER: 'gateway-a',
};
test('opt-in fast mode defaults to pooled connections and automatic wallet-backed credit', () => {
  const result = resolveManagedSaasFastGatewayConfiguration({}, environment);
  assert.ok(result);
  assert.equal(result.reuseConnections, true);
  assert.equal(result.allocationTrancheMinorUnits, undefined);
  assert.equal(result.allocationStripes, undefined);
  assert.equal(resolveManagedSaasFastGatewayConfiguration({}, {}), undefined);
});
test('explicit credit cap and pool/stripe rollback controls remain exact', () => {
  const result = resolveManagedSaasFastGatewayConfiguration(
    {},
    {
      ...environment,
      MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '1000000',
      MODEL_ROUTER_FAST_CONNECTION_REUSE: '0',
      MODEL_ROUTER_FAST_CREDIT_STRIPES: '1',
    },
  );
  assert.equal(result?.allocationTrancheMinorUnits, '1000000');
  assert.equal(result?.reuseConnections, false);
  assert.equal(result?.allocationStripes, 1);
  const explicit = resolveManagedSaasFastGatewayConfiguration(
    {
      fastGateway: {
        mode: 'reserved-max',
        redisUrl: environment.MODEL_ROUTER_FAST_REDIS_URL,
        namespace: 'fixture',
        allocationOwner: 'gateway-a',
        allocationTrancheMinorUnits: '7',
        reuseConnections: false,
      },
    },
    {},
  );
  assert.equal(explicit?.allocationTrancheMinorUnits, '7');
  assert.equal(explicit?.reuseConnections, false);
});
test('malformed fast configuration fails instead of silently selecting another policy', () => {
  for (const changed of [
    { MODEL_ROUTER_FAST_CONNECTION_REUSE: 'off' },
    { MODEL_ROUTER_FAST_CONNECTION_REUSE: '' },
    { MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '0' },
    { MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '1e9' },
    { MODEL_ROUTER_FAST_CREDIT_STRIPES: '0' },
    { MODEL_ROUTER_FAST_CREDIT_STRIPES: 'NaN' },
    { MODEL_ROUTER_FAST_CREDIT_STRIPES: '9' },
  ]) {
    assert.throws(() => resolveManagedSaasFastGatewayConfiguration({}, { ...environment, ...changed }));
  }
});

test('an untyped composition caller cannot coerce a numeric credit cap', () => {
  assert.throws(() =>
    resolveManagedSaasFastGatewayConfiguration(
      {
        fastGateway: {
          mode: 'reserved-max',
          redisUrl: environment.MODEL_ROUTER_FAST_REDIS_URL,
          namespace: 'fixture',
          allocationOwner: 'gateway-a',
          allocationTrancheMinorUnits: 1000000 as never,
        },
      },
      {},
    ),
  );
});
