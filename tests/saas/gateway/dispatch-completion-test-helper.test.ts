import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DispatchCompletionBarrierError,
  DispatchCompletionTracker,
  type DispatchCompletionCleanupDiagnostic,
  type DispatchCompletionFailureCode,
  type DispatchCompletionOutcome,
} from './dispatch-completion-test-helper.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

function barrierCode(code: DispatchCompletionFailureCode) {
  return (error: unknown): boolean => error instanceof DispatchCompletionBarrierError && error.code === code;
}

test('completion observer correlates fresh request identities even when promises finish out of order', async () => {
  const tracker = new DispatchCompletionTracker();
  const previousCheckpoint = tracker.checkpoint();
  tracker.track('previous-http-request', Promise.resolve('sent' as const), (outcome) => outcome);
  await tracker.waitForCompletion('previous-http-request', previousCheckpoint);
  const firstCheckpoint = tracker.checkpoint();
  const first = deferred<{ outcome: DispatchCompletionOutcome; originalValue: number }>();
  tracker.track('first-http-request', first.promise, (result) => result.outcome);
  const secondCheckpoint = tracker.checkpoint();
  const second = deferred<DispatchCompletionOutcome>();
  tracker.track('second-http-request', second.promise, (outcome) => outcome);

  let firstCompleted = false;
  const firstWait = tracker.waitForCompletion('first-http-request', firstCheckpoint).then(() => { firstCompleted = true; });
  second.resolve('sent');
  await tracker.waitForCompletion('second-http-request', secondCheckpoint);
  assert.equal(firstCompleted, false, 'completion of a different request must not release the first barrier');
  const originalResult = { outcome: 'sent' as const, originalValue: 17 };
  first.resolve(originalResult);
  await firstWait;
  assert.equal(await first.promise, originalResult, 'observation must not replace the actual result');
  await assert.rejects(tracker.waitForCompletion('previous-http-request', firstCheckpoint), barrierCode('stale_dispatch'));
  await assert.rejects(tracker.waitForCompletion('unobserved-http-request', firstCheckpoint), barrierCode('missing_dispatch'));
  await assert.rejects(tracker.waitForCompletion(null, firstCheckpoint), barrierCode('missing_request_id'));
  const duplicateCheckpoint = tracker.checkpoint();
  tracker.track('duplicate-http-request', Promise.resolve('sent' as const), (outcome) => outcome);
  tracker.track('duplicate-http-request', Promise.resolve('sent' as const), (outcome) => outcome);
  await assert.rejects(tracker.waitForCompletion('duplicate-http-request', duplicateCheckpoint), barrierCode('duplicate_dispatch'));
  assert.equal(await tracker.drain(), null);
});

test('completion observer rejects actual rejection, unknown, lease-release failure and timeout without cancelling work', async () => {
  for (const outcome of ['unknown', 'lease_release_failed'] as const) {
    const tracker = new DispatchCompletionTracker();
    const checkpoint = tracker.checkpoint();
    tracker.track('failed-http-request', Promise.resolve(outcome), (result) => result);
    await assert.rejects(tracker.waitForCompletion('failed-http-request', checkpoint), barrierCode(outcome));
  }
  const rejectedTracker = new DispatchCompletionTracker();
  const rejected = deferred<DispatchCompletionOutcome>();
  const rejectedCheckpoint = rejectedTracker.checkpoint();
  rejectedTracker.track('rejected-http-request', rejected.promise, (result) => result);
  const originalError = new Error('controlled original rejection');
  rejected.reject(originalError);
  await assert.rejects(rejectedTracker.waitForCompletion('rejected-http-request', rejectedCheckpoint), barrierCode('dispatch_rejected'));
  await assert.rejects(rejected.promise, (error: unknown) => error === originalError);

  const timeoutTracker = new DispatchCompletionTracker(10);
  const late = deferred<{ outcome: DispatchCompletionOutcome; originalValue: number }>();
  const timeoutCheckpoint = timeoutTracker.checkpoint();
  let actualCompleted = false;
  void late.promise.then(() => { actualCompleted = true; });
  timeoutTracker.track('late-http-request', late.promise, (result) => result.outcome);
  await assert.rejects(timeoutTracker.waitForCompletion('late-http-request', timeoutCheckpoint), barrierCode('completion_timeout'));
  assert.equal(actualCompleted, false);
  const lateResult = { outcome: 'sent' as const, originalValue: 23 };
  late.resolve(lateResult);
  assert.equal(await late.promise, lateResult, 'observation timeout must not cancel or fabricate the actual result');
  assert.equal(await timeoutTracker.drain(), null);
});

test('completion observer permits no-dispatch replay and drains before cleanup without replacing the first failure', async () => {
  const replayTracker = new DispatchCompletionTracker();
  replayTracker.track('canonical-http-request', Promise.resolve('sent' as const), (outcome) => outcome);
  await replayTracker.waitForCompletion('canonical-http-request', 0);
  const replayCheckpoint = replayTracker.checkpoint();
  replayTracker.assertNoDispatchSince(replayCheckpoint);
  await assert.rejects(replayTracker.waitForCompletion('canonical-http-request', replayCheckpoint), barrierCode('stale_dispatch'));
  replayTracker.track('unexpected-replay-dispatch', Promise.resolve('sent' as const), (outcome) => outcome);
  assert.throws(() => replayTracker.assertNoDispatchSince(replayCheckpoint), barrierCode('unexpected_dispatch'));

  const tracker = new DispatchCompletionTracker();
  const inFlight = deferred<DispatchCompletionOutcome>();
  tracker.track('cleanup-http-request', inFlight.promise, (outcome) => outcome);
  const reports: DispatchCompletionCleanupDiagnostic[] = [];
  let closeCalled = false;
  const primary = new Error('controlled first assertion failure');
  const failedTest = (async () => {
    try { await tracker.preserveFailure(async () => { throw primary; }); }
    finally {
      await tracker.finalize(async () => {
        closeCalled = true;
        assert.equal(tracker.closeStarted, true);
        throw new Error('controlled cleanup rejection');
      }, (diagnostic) => { reports.push(diagnostic); });
    }
  })();
  assert.equal(closeCalled, false, 'resources must remain open while actual completion is pending');
  inFlight.resolve('unknown');
  await assert.rejects(failedTest, (error: unknown) => error === primary);
  assert.equal(closeCalled, true);
  assert.deepEqual(reports, [
    { phase: 'before_close_drain', code: 'unknown' },
    { phase: 'resource_close', code: 'cleanup_rejected' },
  ]);

  const noPrimary = new DispatchCompletionTracker();
  noPrimary.track('unobserved-failed-dispatch', Promise.resolve('lease_release_failed' as const), (outcome) => outcome);
  let closedAfterFailure = false;
  await assert.rejects(noPrimary.finalize(async () => { closedAfterFailure = true; }, () => {}), barrierCode('lease_release_failed'));
  assert.equal(closedAfterFailure, true, 'a drain failure must not prevent resource closing');

  const timeout = new DispatchCompletionTracker(10);
  const unfinished = deferred<DispatchCompletionOutcome>();
  timeout.track('unfinished-cleanup-request', unfinished.promise, (outcome) => outcome);
  await assert.rejects(timeout.finalize(async () => {}, () => {}), barrierCode('completion_timeout'));
  unfinished.resolve('sent');
  assert.equal(await unfinished.promise, 'sent');

  const timeoutWithPrimary = new DispatchCompletionTracker(10);
  const unfinishedAfterPrimary = deferred<DispatchCompletionOutcome>();
  timeoutWithPrimary.track('unfinished-after-first-failure', unfinishedAfterPrimary.promise, (outcome) => outcome);
  const timeoutReports: DispatchCompletionCleanupDiagnostic[] = [];
  const primaryBeforeTimeout = new Error('controlled first failure before drain timeout');
  let closedAfterTimeout = false;
  await assert.rejects((async () => {
    try { await timeoutWithPrimary.preserveFailure(async () => { throw primaryBeforeTimeout; }); }
    finally {
      await timeoutWithPrimary.finalize(async () => { closedAfterTimeout = true; }, (diagnostic) => { timeoutReports.push(diagnostic); });
    }
  })(), (error: unknown) => error === primaryBeforeTimeout);
  assert.equal(closedAfterTimeout, true);
  assert.deepEqual(timeoutReports, [{ phase: 'before_close_drain', code: 'completion_timeout' }]);
  unfinishedAfterPrimary.resolve('sent');
  assert.equal(await unfinishedAfterPrimary.promise, 'sent');

  const empty = new DispatchCompletionTracker();
  let closedWithoutDispatch = false;
  await empty.finalize(async () => { closedWithoutDispatch = true; }, () => {});
  assert.equal(closedWithoutDispatch, true, 'an early failure/no-dispatch response must not wait for a nonexistent dispatch');
});

test('expected unknown requires one fresh exact dispatch and does not accept sent, release failure or rejection', async () => {
  const tracker = new DispatchCompletionTracker();
  const checkpoint = tracker.checkpoint();
  assert.throws(() => tracker.requestIdSince(checkpoint), barrierCode('missing_dispatch'));
  const actual = deferred<DispatchCompletionOutcome>();
  tracker.track('receipt-correlated-request', actual.promise, (result) => result);
  assert.equal(tracker.requestIdSince(checkpoint), 'receipt-correlated-request');
  let completed = false;
  const barrier = tracker.waitForCompletion('receipt-correlated-request', checkpoint, 'unknown')
    .then(() => { completed = true; });
  assert.equal(completed, false);
  actual.resolve('unknown');
  await barrier;
  assert.equal(completed, true);
  assert.equal(await tracker.drain(), null, 'explicit unknown observation must not be reclassified by cleanup');
  await tracker.finalize(async () => {}, () => { assert.fail('unexpected cleanup diagnostic'); });
  const replayCheckpoint = tracker.checkpoint();
  tracker.assertNoDispatchSince(replayCheckpoint);
  assert.throws(() => tracker.requestIdSince(replayCheckpoint), barrierCode('missing_dispatch'));
  await assert.rejects(tracker.waitForCompletion('receipt-correlated-request', replayCheckpoint, 'unknown'),
    barrierCode('stale_dispatch'));
  tracker.track('second-fresh-request', Promise.resolve('unknown' as const), (value) => value);
  assert.throws(() => tracker.requestIdSince(checkpoint), barrierCode('duplicate_dispatch'));

  for (const [outcome, code] of [
    ['sent', 'unexpected_outcome'], ['lease_release_failed', 'lease_release_failed'], ['threw', 'dispatch_rejected'],
  ] as const) {
    const rejected = new DispatchCompletionTracker();
    rejected.track('bad-unknown-result', Promise.resolve(outcome), (value) => value);
    await assert.rejects(rejected.waitForCompletion('bad-unknown-result', 0, 'unknown'), barrierCode(code));
  }
  const rejected = new DispatchCompletionTracker();
  const failed = deferred<DispatchCompletionOutcome>();
  const originalError = new Error('controlled actual unknown-dispatch rejection');
  rejected.track('rejected-unknown-request', failed.promise, (value) => value);
  failed.reject(originalError);
  await assert.rejects(rejected.waitForCompletion('rejected-unknown-request', 0, 'unknown'), barrierCode('dispatch_rejected'));
  await assert.rejects(failed.promise, (error: unknown) => error === originalError);
  const timeout = new DispatchCompletionTracker(10);
  const unfinished = deferred<DispatchCompletionOutcome>();
  timeout.track('unknown-still-running', unfinished.promise, (value) => value);
  await assert.rejects(timeout.waitForCompletion('unknown-still-running', 0, 'unknown'), barrierCode('completion_timeout'));
  unfinished.resolve('unknown');
  assert.equal(await timeout.drain(), 'unknown', 'a timeout does not approve a late unknown or cancel actual work');
});
