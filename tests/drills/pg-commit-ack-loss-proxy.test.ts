import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommitAckLossFrames, validateCommitAckLossTarget } from './helpers/pg-commit-ack-loss-proxy.js';

function startup(): Buffer { const value = Buffer.alloc(8); value.writeUInt32BE(8); value.writeUInt32BE(196608, 4); return value; }
function frame(type: string, payload: string): Buffer { const body = Buffer.from(payload); const value = Buffer.alloc(body.length + 5); value.write(type, 0, 'ascii'); value.writeUInt32BE(body.length + 4, 1); body.copy(value, 5); return value; }
function armed(): CommitAckLossFrames { const filter = new CommitAckLossFrames(); filter.frontendBytes(Buffer.concat([startup(), frame('Q', 'COMMIT\0')])); return filter; }

test('PG ACK target validation accepts only designated disposable local or exact CI endpoints', () => {
  for (const target of [
    { host: 'postgres', port: 5432, database: 'model_router_saas_ci' },
    { host: '127.0.0.1', port: 15432, database: 'model_router_test_ack_loss' },
    { host: '::1', port: 15432, database: 'model_router_saas_ci' },
  ]) assert.doesNotThrow(() => validateCommitAckLossTarget(target));
  for (const target of [
    { host: 'postgres', port: 15432, database: 'model_router_saas_ci' },
    { host: 'postgres', port: 5432, database: 'other' },
    { host: 'postgres', port: 5432, database: 'model_router_test_ack_loss' },
    { host: 'example.invalid', port: 5432, database: 'model_router_saas_ci' },
    { host: '127.0.0.1', port: 5432, database: 'model_router_saas_ci' },
    { host: '127.0.0.1', port: 15432, database: 'production' },
    { host: '127.0.0.1', port: 0, database: 'model_router_test_ack_loss' },
  ]) assert.throws(() => validateCommitAckLossTarget(target), /owned disposable/u);
});

test('PG ACK proxy forwards partial/coalesced startup and Query frames byte for byte', () => {
  const filter = new CommitAckLossFrames();
  const original = Buffer.concat([startup(), frame('Q', 'BEGIN\0'), frame('Q', 'COMMIT\0')]);
  const forwarded: Buffer[] = [];
  for (const byte of original) forwarded.push(...filter.frontendBytes(Buffer.from([byte])));
  assert.deepEqual(Buffer.concat(forwarded), original);
  assert.equal(filter.evidence().frontendCommitForwarded, true);
  assert.equal(filter.evidence().serverCommitObserved, false);
});

test('PG ACK proxy never forwards a partial COMMIT completion or a coalesced ReadyForQuery', () => {
  const filter = armed();
  const bytes = Buffer.concat([frame('C', 'COMMIT\0'), frame('Z', 'I')]);
  assert.deepEqual(filter.backendBytes(bytes.subarray(0, 2)), { forward: [], disconnect: false });
  assert.deepEqual(filter.backendBytes(bytes.subarray(2, 6)), { forward: [], disconnect: false });
  assert.deepEqual(filter.backendBytes(bytes.subarray(6)), { forward: [], disconnect: true });
  assert.deepEqual(filter.evidence(), { frontendCommitForwarded: true, serverCommitObserved: true, backendCommitForwarded: false, connectionCut: true });
  assert.deepEqual(filter.backendBytes(frame('Z', 'I')), { forward: [], disconnect: true });
});

test('PG ACK proxy forwards unrelated completion/error frames and never calls them a commit', () => {
  const idle = new CommitAckLossFrames();
  const commit = frame('C', 'COMMIT\0');
  assert.deepEqual(Buffer.concat(idle.backendBytes(commit).forward), commit);
  assert.equal(idle.evidence().serverCommitObserved, false);
  assert.equal(idle.evidence().backendCommitForwarded, true);
  for (const response of [frame('C', 'SELECT 1\0'), frame('E', 'SERROR\0\0')]) {
    const filter = armed();
    const result = filter.backendBytes(response);
    assert.deepEqual(Buffer.concat(result.forward), response);
    assert.equal(result.disconnect, false);
    assert.equal(filter.backendBytes(commit).disconnect, false);
    assert.equal(filter.evidence().serverCommitObserved, false);
  }
});

test('PG ACK proxy only arms on the exact native COMMIT Query and rejects malformed/oversized frames', () => {
  for (const query of ['COMMIT;\0', 'commit\0', 'SELECT COMMIT\0']) {
    const filter = new CommitAckLossFrames(); filter.frontendBytes(Buffer.concat([startup(), frame('Q', query)]));
    assert.equal(filter.evidence().frontendCommitForwarded, false);
  }
  const short = Buffer.alloc(8); short.writeUInt32BE(7);
  assert.throws(() => new CommitAckLossFrames().frontendBytes(short), /invalid frontend frame/u);
  const ssl = startup(); ssl.writeUInt32BE(80877103, 4);
  assert.throws(() => new CommitAckLossFrames().frontendBytes(ssl), /plaintext v3/u);
  for (const length of [3, 16 * 1024 * 1024 + 1]) {
    const invalid = Buffer.alloc(5); invalid[0] = 67; invalid.writeUInt32BE(length, 1);
    assert.throws(() => armed().backendBytes(invalid), /invalid backend frame/u);
    const frontend = new CommitAckLossFrames(); frontend.frontendBytes(startup());
    assert.throws(() => frontend.frontendBytes(invalid), /invalid frontend frame/u);
  }
});
