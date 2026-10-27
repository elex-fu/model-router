"""Only generated argument/environment code is executed; no services start."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from bounded_business_launcher_adapter import adapt


BASE = """import('./byok-fixture.mjs')
async function run(name, executable, args, env = baseEnv) {
}
let seedClosed = false;
try {
  const log = createWriteStream(join(out, 'gateway.log'), {});
  gateway = spawn(process.execPath, [join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway'], {});
  while (Date.now() < deadline) {
  }
  await writeFile(join(out, 'paired-ready.json'), JSON.stringify({gatewayPid: gateway.pid, gatewayPids:gateways.map(child=>child.pid),gatewayUrls,}));
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  for(const child of gateways)assert.equal(child.exitCode,null,'Gateway exited during paired benchmark');
} finally {
  for(const child of gateways)if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(10000)]);if(child.exitCode===null)child.kill('SIGKILL');}
}
"""


def generated(profile="c32", capacity_diagnostic=False):
    with patch("async_receipt_launcher_adapter.BASE_SHA256", hashlib.sha256(BASE.encode()).hexdigest()):
        return adapt(BASE, base_directory=Path.cwd(), observer_directory=Path(__file__).parent, profile=profile, capacity_diagnostic=capacity_diagnostic)


def select(env, profile="c32"):
    script = generated(profile)
    hook = script[script.index("  // DIAGNOSTIC ONLY. The primary splits"):
                  script.index("  const log = createWriteStream")]
    prelude = """import assert from 'node:assert/strict'; import {join} from 'node:path';
const env={MODEL_ROUTER_FAST_RECEIPT_MODE:'memory-queue'}; const out='/workspace/fixture';
const faultEnabled=process.env.PAIR_ASYNC_FAULTS==='1', metricsEnabled=process.env.PAIR_ASYNC_METRICS==='1',
cpuProfileEnabled=process.env.PAIR_ASYNC_CPU_PROFILE==='1', gatewayNodeArgs=[];
const fastMode=true,fixtureCap=Number(process.env.PAIR_CONCURRENCY_CAP ??64),builtinEstimator=true;
const stopping=process.env.TEST_STOPPING==='1';
async function mkdir(){}
"""
    return subprocess.run(["node", "--input-type=module", "-e", prelude + hook +
                           "console.log(JSON.stringify({env,boundedClusterWorkers}));"],
                          env={"PATH": os.environ["PATH"], "PAIR_TRANCHE_MINOR_UNITS": "auto", **env},
                          text=True, capture_output=True)


class AdapterTests(unittest.TestCase):
    def test_capacity_probe_requires_explicit_generated_optin(self):
        normal = generated("c200")
        instrumented = generated("c200", capacity_diagnostic=True)
        self.assertIn("const boundedCapacityDiagnostic = false;", normal)
        self.assertIn("const boundedCapacityDiagnostic = true;", instrumented)
        self.assertIn("BOUNDED_CAPACITY_EXPLICIT_OPTIN_REQUIRED", instrumented)
        self.assertIn("assert.equal(proof.inferenceHooksInstalled, boundedCapacityDiagnostic)", instrumented)
        with self.assertRaises(ValueError):
            generated("c32", capacity_diagnostic=True)

    def test_two_workers_use_one_primary_with_explicit_aggregate_budgets(self):
        for workers in (1, 2):
            result = select({"BOUNDED_CLUSTER_WORKERS": str(workers)})
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(value["boundedClusterWorkers"], workers)
            env = value["env"]
            self.assertEqual(env["MODEL_ROUTER_SAAS_DB_POOL_MAX"], "16")
            self.assertEqual(env["MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT"], "64")
            self.assertEqual(env["MODEL_ROUTER_FAST_CREDIT_STRIPES"], "8")
            self.assertEqual(env["MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT"], "64")
            self.assertEqual(env["BOUNDED_CLUSTER_SHUTDOWN_MS"], "45000")
        source = generated()
        self.assertIn("bounded-business-cluster.cjs", source)
        self.assertIn("gatewayPid: boundedClusterState.workers[0].pid", source)
        self.assertIn("gatewayPids: boundedClusterState.workers.map(worker => worker.pid)", source)
        self.assertIn("clusterPrimaryPid: gateway.pid", source)
        self.assertIn("await waitForExit(child, 65000)", source)
        self.assertNotIn("await waitForExit(child, 45000)", source)

    def test_c200_profile_forwards_cap256_without_growing_queue_or_pool(self):
        for workers in (1, 2):
            result = select({"BOUNDED_CLUSTER_WORKERS": str(workers), "BOUNDED_CLUSTER_PROFILE": "c200",
                             "PAIR_CONCURRENCY_CAP": "256"}, "c200")
            self.assertEqual(result.returncode, 0, result.stderr)
            env = json.loads(result.stdout)["env"]
            self.assertEqual(env["BOUNDED_CLUSTER_PROFILE"], "c200")
            self.assertEqual(env["MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT"], "256")
            self.assertEqual(env["MODEL_ROUTER_SAAS_DB_POOL_MAX"], "16")
            self.assertEqual(env["MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES"], "256")
            self.assertEqual(env["MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES"], "2097152")
            self.assertEqual(env["MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT"], "64")
        for env in ({"BOUNDED_CLUSTER_PROFILE": "unknown", "PAIR_CONCURRENCY_CAP": "256"},
                    {"BOUNDED_CLUSTER_PROFILE": "c32", "PAIR_CONCURRENCY_CAP": "256"},
                    {"BOUNDED_CLUSTER_PROFILE": "c200", "PAIR_CONCURRENCY_CAP": "64"}):
            result = select({"BOUNDED_CLUSTER_WORKERS": "2", **env}, "c200")
            self.assertNotEqual(result.returncode, 0, env)
        source = generated("c200")
        self.assertIn("boundedClusterState?.profile, boundedClusterProfile", source)
        self.assertIn("proof.profile, boundedClusterProfile", source)
        with self.assertRaises(ValueError):
            generated("unknown")

    def test_nested_replicas_wrong_count_observers_and_explicit_money_cap_rejected(self):
        for extra in ({"PAIR_INSTANCES": "2"}, {"BOUNDED_CLUSTER_WORKERS": "3"},
                      {"PAIR_ASYNC_METRICS": "1"}, {"PAIR_ASYNC_FAULTS": "1"},
                      {"PAIR_ASYNC_CPU_PROFILE": "1"}, {"PAIR_TRANCHE_MINOR_UNITS": "1000000"}):
            result = select({"BOUNDED_CLUSTER_WORKERS": "2", **extra})
            self.assertNotEqual(result.returncode, 0, extra)

    def test_early_outer_stop_is_registered_before_setup_and_cannot_fork(self):
        source = generated()
        self.assertLess(source.index("process.on('SIGTERM'"), source.index("try {\n"))
        self.assertNotIn("process.once('SIGTERM'", source)
        result = select({"BOUNDED_CLUSTER_WORKERS": "2", "TEST_STOPPING": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BOUNDED_CLUSTER_OUTER_STOP_REQUESTED", result.stderr)
        self.assertGreaterEqual(source.count("BOUNDED_CLUSTER_OUTER_STOP_REQUESTED"), 4)

    def test_outer_TERM_before_primary_state_publication_still_awaits_owned_child(self):
        # Exercise the actual generated early-handler text. Tiny process-only
        # fixture: no network/database or production workload is launched.
        source = generated()
        handlers = source[source.index("let stopping = false;"):source.index("try {\n")]
        with tempfile.TemporaryDirectory(prefix="bounded-prestate-term-") as directory:
            root = Path(directory)
            child = root / "child.cjs"
            child.write_text("const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.env.STATE,'published'),1500);setInterval(()=>{},1000);")
            outer_script = root / "outer.mjs"
            outer_script.write_text("""import assert from 'node:assert/strict';import fs from 'node:fs';
import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
""" + handlers + """
let child;
try {
  assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');
  child=spawn(process.execPath,[process.env.CHILD],{env:process.env,stdio:'ignore'});
  fs.writeFileSync(process.env.SPAWNED,String(child.pid));
  while(!fs.existsSync(process.env.STATE)) {
    assert.ok(!stopping, 'BOUNDED_CLUSTER_OUTER_STOP_REQUESTED');await delay(10);
  }
} catch { process.exitCode=1; }
finally {
  if(child && child.exitCode===null && child.signalCode===null){
    const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;
  }
  fs.writeFileSync(process.env.CLEANUP,JSON.stringify({exited:child.exitCode!==null||child.signalCode!==null}));
}
""")
            paths = {name: str(root / name.lower()) for name in ("SPAWNED", "STATE", "CLEANUP")}
            outer = subprocess.Popen(["node", str(outer_script)], env={**os.environ, **paths, "CHILD": str(child)},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while not Path(paths["SPAWNED"]).exists() and time.monotonic() < deadline:
                    self.assertIsNone(outer.poll())
                    time.sleep(.01)
                self.assertTrue(Path(paths["SPAWNED"]).exists())
                self.assertFalse(Path(paths["STATE"]).exists(), "TERM must precede primary state publication")
                outer.terminate()
                self.assertEqual(outer.wait(timeout=3), 1, "outer must execute finally, not die by default TERM")
                self.assertTrue(json.loads(Path(paths["CLEANUP"]).read_text())["exited"])
                self.assertFalse(Path(paths["STATE"]).exists())
                pid = int(Path(paths["SPAWNED"]).read_text())
                self.assertFalse(Path(f"/proc/{pid}").exists(), "owned child must be reaped before outer exit")
            finally:
                if outer.poll() is None:
                    outer.terminate()
                    try:
                        outer.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        outer.kill()
                        outer.wait()

    def test_common_port_readiness_never_substitutes_for_each_child_proof(self):
        source = generated()
        self.assertIn("worker.ready === true", source)
        self.assertIn("proof.readyStatus, 200", source)
        self.assertIn("proof.readinessListenerClosed, true", source)
        self.assertIn("boundedClusterState?.primaryPid, gateway.pid", source)
        self.assertIn("new Set(boundedClusterState.workers.map(worker => worker.owner))", source)

    def test_changed_baseline_refused(self):
        with self.assertRaises(ValueError):
            adapt(BASE + "changed", base_directory=Path.cwd(), observer_directory=Path.cwd())


if __name__ == "__main__":
    unittest.main()
