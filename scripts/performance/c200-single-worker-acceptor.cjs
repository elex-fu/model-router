#!/usr/bin/env node
'use strict';
// DIAGNOSTIC ONLY: isolate accept scheduling without adding a business worker.
// The primary imports built-ins only. The original entrypoint/argv executes
// directly in exactly one cluster worker; no application, money or HTTP wrapper.
// This is not a production supervisor: no restart, no extra owner, no promises
// about bounding Node's internal pending-handoff queue under hostile traffic.
const cluster = require('node:cluster');
const fs = require('node:fs');
const path = require('node:path');
const { constants } = require('node:os');

function clockAnchor() {
  const monotonicBeforeNs = process.hrtime.bigint().toString();
  const wallUnixNs = (BigInt(Date.now()) * 1000000n).toString();
  const monotonicAfterNs = process.hrtime.bigint().toString();
  return { monotonicBeforeNs, wallUnixNs, monotonicAfterNs, wallResolutionNs: '1000000' };
}

function main() {
  const [entrypoint, ...args] = process.argv.slice(2);
  const stateFile = process.env.C200_CLUSTER_STATE_FILE;
  const shutdownMs = Number(process.env.C200_CLUSTER_SHUTDOWN_MS ?? '8000');
  if (process.env.C200_CLUSTER_DIAGNOSTIC !== '1' || !cluster.isPrimary ||
      !entrypoint || !path.isAbsolute(entrypoint) || !stateFile || !path.isAbsolute(stateFile) ||
      process.env.NODE_OPTIONS || process.execArgv.length ||
      !Number.isSafeInteger(shutdownMs) || shutdownMs < 100 || shutdownMs > 60000) {
    process.stderr.write('C200_ACCEPTOR_INVALID_DIAGNOSTIC_SETUP\n');
    process.exitCode = 1;
    return;
  }
  const state = {
    diagnosticOnly: true, topology: 'cluster_rr_one_business_worker',
    primaryPid: process.pid, workerPid: null, businessWorkersStarted: 0,
    primaryApplicationImports: false, restartEnabled: false,
    pendingHandoffQueue: 'node_cluster_internal_not_production_bounded',
    phase: 'starting', events: [], eventDrops: 0,
  };
  let worker, stopping = false, exited = false, failed = false, deadline;
  function record(kind, fields = {}) {
    state.phase = kind;
    if (state.events.length < 64) state.events.push({ kind, ...fields, clockAnchor: clockAnchor() });
    else state.eventDrops++;
    const temporary = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  }
  function safeRecord(kind, fields) {
    try { record(kind, fields); }
    catch {
      failed = true;
      process.stderr.write('C200_ACCEPTOR_STATE_WRITE_FAILED\n');
      stop('SIGTERM');
    }
  }
  function signalWorker(signal) {
    if (!exited && worker?.process.pid) {
      try { worker.process.kill(signal); } catch { failed = true; }
    }
  }
  function stop(signal) {
    if (stopping || exited) return;
    stopping = true;
    safeRecord('stopping', { signal });
    // Do not cluster.disconnect() first: the unchanged application's own
    // signal handler must own listener shutdown, request drain and DB closure.
    signalWorker(signal);
    deadline = setTimeout(() => {
      failed = true;
      safeRecord('shutdown_timeout');
      signalWorker('SIGKILL');
    }, shutdownMs);
  }
  // Fail before fork if we cannot publish process ownership to the harness.
  record('starting');
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: entrypoint, args,
    execArgv: ['--require', path.join(__dirname, 'c200-single-worker-lifecycle.cjs')], silent: false });
  const workerEnvironment = { ...process.env, NODE_OPTIONS: process.env.C200_CLUSTER_WORKER_NODE_OPTIONS ?? '' };
  delete workerEnvironment.C200_CLUSTER_WORKER_NODE_OPTIONS;
  worker = cluster.fork(workerEnvironment);
  state.workerPid = worker.process.pid;
  state.businessWorkersStarted = 1;
  safeRecord('forked');
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGWINCH', () => signalWorker('SIGWINCH'));
  worker.on('online', () => safeRecord('online'));
  worker.on('listening', address => safeRecord('listening', {
    port: Number.isInteger(address.port) ? address.port : null,
    addressType: address.addressType === 4 || address.addressType === 6 ? address.addressType : 'other',
  }));
  worker.on('error', () => {
    failed = true;
    safeRecord('worker_error');
    stop('SIGTERM');
  });
  worker.on('disconnect', () => safeRecord('worker_disconnected'));
  worker.on('exit', (code, signal) => {
    exited = true;
    clearTimeout(deadline);
    // An unexplained zero exit is not a healthy long-running gateway.
    const exitCode = failed || (!stopping && code === 0) ? 1 :
      typeof code === 'number' ? code : 128 + (constants.signals[signal] ?? 1);
    const usage = process.resourceUsage();
    // Whole primary lifetime, including startup/warm; NOT timed-only CPU.
    safeRecord('exited', { workerExitCode: code, workerSignal: signal, primaryExitCode: exitCode,
      primaryLifetimeUsage: { userCpuMicros: usage.userCPUTime, systemCpuMicros: usage.systemCPUTime,
        maxRssKiB: usage.maxRSS, voluntaryContextSwitches: usage.voluntaryContextSwitches,
        involuntaryContextSwitches: usage.involuntaryContextSwitches } });
    process.exitCode = failed ? 1 : exitCode;
  });
}

try { main(); }
catch {
  // No raw entrypoint, environment, setup error or socket information in logs.
  process.stderr.write('C200_ACCEPTOR_SETUP_FAILED\n');
  process.exitCode = 1;
}
