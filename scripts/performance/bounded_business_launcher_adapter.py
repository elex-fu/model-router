"""Derive a diagnostic-only, fixed-budget cluster fixture from pinned GEN17.

This module generates a new launcher. It neither edits the original launcher
nor starts services; generated launchers are private runtime artifacts.
"""
import argparse
import hashlib
import json
from pathlib import Path

from async_receipt_launcher_adapter import BASE_SHA256, adapt as adapt_async, replace_once
from bounded_business_profiles import PROFILE_NAMES, aggregate_budgets, get_profile


def adapt(source, *, base_directory, observer_directory, profile="c32", capacity_diagnostic=False):
    get_profile(profile)
    if capacity_diagnostic and profile != "c200":
        raise ValueError("Capacity diagnostic requires c200")
    totals = aggregate_budgets(profile)
    here = Path(observer_directory).resolve()
    source = adapt_async(source, base_directory=base_directory, observer_directory=here)
    # The original fixture installs these only after readiness. An early TERM
    # could otherwise kill the outer launcher after spawning a primary but
    # before that primary has published its PID/state. Own stop before startup,
    # and let the unchanged finally block await its actual child handle.
    source = replace_once(source,
        "  let stopping = false;\n  process.once('SIGTERM', () => { stopping = true; });\n  process.once('SIGINT', () => { stopping = true; });\n", "")
    source = replace_once(source, "let seedClosed = false;\ntry {",
        "let seedClosed = false;\nlet stopping = false;\n"
        "process.on('SIGTERM', () => { stopping = true; });\n"
        "process.on('SIGINT', () => { stopping = true; });\ntry {")
    source = replace_once(source, "async function run(name, executable, args, env = baseEnv) {",
        "async function run(name, executable, args, env = baseEnv) {\n"
        "  assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');")
    source = replace_once(source, "  while (Date.now() < deadline) {",
        "  while (Date.now() < deadline) {\n    assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');")
    hook = r'''
  // DIAGNOSTIC ONLY. The primary splits these aggregate budgets, never copies them.
  assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');
  assert.equal(Number(process.env.PAIR_INSTANCES ?? '1'), 1, 'BOUNDED_CLUSTER_NESTED_REPLICAS_FORBIDDEN');
  const boundedClusterProfile = process.env.BOUNDED_CLUSTER_PROFILE ?? 'c32';
  assert.equal(boundedClusterProfile, __BOUNDED_PROFILE__, 'BOUNDED_CLUSTER_PROFILE_MISMATCH');
  const boundedClusterTotals = __BOUNDED_TOTALS__;
  const boundedCapacityDiagnostic = __CAPACITY_DIAGNOSTIC__;
  assert.equal(process.env.BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC === '1', boundedCapacityDiagnostic, 'BOUNDED_CAPACITY_EXPLICIT_OPTIN_REQUIRED');
  const boundedClusterWorkers = Number(process.env.BOUNDED_CLUSTER_WORKERS);
  if (boundedCapacityDiagnostic) assert.equal(boundedClusterWorkers, 2);
  assert.ok([1, 2].includes(boundedClusterWorkers), 'BOUNDED_CLUSTER_WORKER_COUNT_REQUIRED');
  assert.ok(!faultEnabled && !metricsEnabled && !cpuProfileEnabled && !env.NODE_OPTIONS && gatewayNodeArgs.length === 0,
    'BOUNDED_CLUSTER_TIMED_OBSERVERS_FORBIDDEN');
  assert.ok(fastMode && fixtureCap === boundedClusterTotals.httpInFlight && builtinEstimator && process.env.PAIR_TRANCHE_MINOR_UNITS === 'auto',
    'BOUNDED_CLUSTER_FIXED_FINANCIAL_PROFILE_REQUIRED');
  assert.equal(env.MODEL_ROUTER_FAST_RECEIPT_MODE, 'memory-queue', 'BOUNDED_CLUSTER_MEMORY_QUEUE_REQUIRED');
  const boundedClusterStateFile = join(out, 'bounded-business-cluster-state.json');
  const boundedClusterChildDirectory = join(out, 'bounded-business-children');
  await mkdir(boundedClusterChildDirectory, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    BOUNDED_CLUSTER_DIAGNOSTIC: '1', BOUNDED_CLUSTER_WORKERS: String(boundedClusterWorkers),
    BOUNDED_CLUSTER_PROFILE: boundedClusterProfile,
    ...(boundedCapacityDiagnostic ? { BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC: '1' } : {}),
    BOUNDED_CLUSTER_STATE_FILE: boundedClusterStateFile,
    BOUNDED_CLUSTER_CHILD_DIRECTORY: boundedClusterChildDirectory,
    BOUNDED_CLUSTER_SHUTDOWN_MS: '45000',
    MODEL_ROUTER_SAAS_DB_POOL_MAX: String(boundedClusterTotals.databasePoolMax),
    MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: String(boundedClusterTotals.httpInFlight),
    MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: String(boundedClusterTotals.receiptEntries),
    MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: String(boundedClusterTotals.receiptBytes),
    MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: String(boundedClusterTotals.receiptPerTenant),
    MODEL_ROUTER_FAST_RECEIPT_WORKERS: String(boundedClusterTotals.receiptWorkers),
    MODEL_ROUTER_FAST_CREDIT_STRIPES: String(boundedClusterTotals.creditStripes),
  });
'''
    hook = hook.replace('__BOUNDED_PROFILE__', json.dumps(profile)).replace('__BOUNDED_TOTALS__', json.dumps(totals)).replace('__CAPACITY_DIAGNOSTIC__', json.dumps(capacity_diagnostic))
    source = replace_once(source, "  const log = createWriteStream(join(out, 'gateway.log'),",
                          hook + "  const log = createWriteStream(join(out, 'gateway.log'),")
    source = replace_once(source,
        "gateway = spawn(process.execPath, [...gatewayNodeArgs, join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway']",
        "gateway = spawn(process.execPath, [" + json.dumps(str(here / "bounded-business-cluster.cjs")) +
        ", join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway']")
    readiness = r'''
  // The common port can repeatedly answer from one worker; it is insufficient proof.
  let boundedClusterState;
  const boundedReadyDeadline = Date.now() + 90000;
  while (Date.now() < boundedReadyDeadline) {
    assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');
    assert.ok(gateway.exitCode === null && gateway.signalCode === null, 'BOUNDED_CLUSTER_EXITED_BEFORE_ALL_READY');
    try { boundedClusterState = JSON.parse(await readFile(boundedClusterStateFile, 'utf8')); } catch {}
    if (boundedClusterState?.workers?.length === boundedClusterWorkers &&
        boundedClusterState.workers.every(worker => worker.ready === true)) break;
    await delay(100);
  }
  assert.equal(boundedClusterState?.profile, boundedClusterProfile, 'BOUNDED_CLUSTER_STATE_PROFILE');
  assert.equal(boundedClusterState?.primaryPid, gateway.pid, 'BOUNDED_CLUSTER_PRIMARY_IDENTITY');
  assert.equal(boundedClusterState?.businessWorkersStarted, boundedClusterWorkers, 'BOUNDED_CLUSTER_NO_RESTART');
  assert.equal(boundedClusterState?.restartEnabled, false, 'BOUNDED_CLUSTER_NO_RESTART');
  assert.equal(boundedClusterState?.workers?.length, boundedClusterWorkers, 'BOUNDED_CLUSTER_ALL_WORKERS_REQUIRED');
  assert.ok(boundedClusterState.workers.every(worker => worker.ready === true), 'BOUNDED_CLUSTER_ALL_WORKERS_READY');
  assert.equal(new Set(boundedClusterState.workers.map(worker => worker.pid)).size, boundedClusterWorkers);
  assert.equal(new Set(boundedClusterState.workers.map(worker => worker.owner)).size, boundedClusterWorkers);
  for (const worker of boundedClusterState.workers) {
    const proof = JSON.parse(await readFile(worker.bootstrapProofFile, 'utf8'));
    assert.equal(proof.profile, boundedClusterProfile, 'BOUNDED_CLUSTER_PROOF_PROFILE');
    assert.equal(proof.pid, worker.pid); assert.equal(proof.owner, worker.owner);
    assert.equal(proof.readyStatus, 200); assert.equal(proof.readinessListenerClosed, true);
    assert.equal(proof.poolObserverRemoved, true); assert.equal(proof.nativePoolPrototypes, true);
    assert.equal(proof.nativeFastPrototypes, true);
    assert.equal(proof.startupObserversRemoved, true);
    assert.equal(proof.inferenceHooksInstalled, boundedCapacityDiagnostic);
    assert.equal(Boolean(proof.capacityDiagnostic?.enabled), boundedCapacityDiagnostic);
  }
'''
    source = replace_once(source, "  await writeFile(join(out, 'paired-ready.json'),",
                          readiness + "  await writeFile(join(out, 'paired-ready.json'),")
    source = replace_once(source, "gatewayPid: gateway.pid, gatewayPids:gateways.map(child=>child.pid),gatewayUrls,",
        "gatewayPid: boundedClusterState.workers[0].pid, gatewayPids: boundedClusterState.workers.map(worker => worker.pid), "
        "clusterPrimaryPid: gateway.pid, businessWorkers: boundedClusterWorkers, profile: boundedClusterProfile, "
        "clusterStateFile: boundedClusterStateFile, clusterChildDirectory: boundedClusterChildDirectory, "
        "configuredPerProcessPoolMax: boundedClusterTotals.databasePoolMax / boundedClusterWorkers, gatewayUrls,")
    # The primary has a 45s business-drain deadline; do not race it with an equal outer timeout.
    source = replace_once(source, "await waitForExit(child, 45000);", "await waitForExit(child, 65000);")
    return "// GENERATED bounded-business diagnostic; no deployment/default change.\n" + source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--profile", choices=PROFILE_NAMES, default="c32")
    parser.add_argument("--observers", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    if args.base.resolve() == args.out.resolve() or args.out.exists():
        parser.error("Refusing to overwrite an input or existing generated launcher")
    generated = adapt(args.base.read_text(), base_directory=args.base.parent, observer_directory=args.observers, profile=args.profile)
    args.out.write_text(generated)
    args.out.with_suffix(args.out.suffix + ".derivation.json").write_text(json.dumps({
        "baseline_sha256": BASE_SHA256,
        "generated_sha256": hashlib.sha256(generated.encode()).hexdigest(),
        "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "diagnostic_only": True, "production_changes": False, "launched": False, "profile": args.profile,
        "delta": ["one RR primary with one or two real business workers", "fixed aggregate budgets",
                  "per-PID readiness proof", "no nested replicas or respawn", "65s outer exit verification"],
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
