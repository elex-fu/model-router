"""Execute only generated argument-selection code; never launch a gateway."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from async_receipt_launcher_adapter import adapt


BASE = """import('./byok-fixture.mjs')
  const log = createWriteStream(join(out, 'gateway.log'), {});
  gateway = spawn(process.execPath, [join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway'], {});
  for(const child of gateways)assert.equal(child.exitCode,null,'Gateway exited during paired benchmark');
  for(const child of gateways)if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(10000)]);if(child.exitCode===null)child.kill('SIGKILL');}
"""


def generated():
    with patch("async_receipt_launcher_adapter.BASE_SHA256", hashlib.sha256(BASE.encode()).hexdigest()):
        return adapt(BASE, base_directory=Path.cwd(), observer_directory=Path.cwd())


def select(env):
    script = generated()
    hook = script[script.index("  // Dedicated async fixture env allowlist."):script.index("  const log = createWriteStream")]
    prelude = """import assert from 'node:assert/strict'; import {join} from 'node:path';
const env={}; const out='/workspace/profile-fixture'; let profile;
async function writeFile(path,data){profile=JSON.parse(data);}
"""
    return subprocess.run(["node", "--input-type=module", "-e", prelude + hook +
                           "console.log(JSON.stringify({env,profile,args:gatewayNodeArgs}));"],
                          env={"PATH": os.environ["PATH"], **env}, text=True, capture_output=True)


class LauncherCpuTests(unittest.TestCase):
    def test_cpu_flags_only_on_gateway_child_and_no_preload(self):
        value = select({"PAIR_ASYNC_CPU_PROFILE": "1"})
        self.assertEqual(value.returncode, 0, value.stderr)
        result = json.loads(value.stdout)
        self.assertEqual(result["args"], ["--cpu-prof", "--cpu-prof-dir=/workspace/profile-fixture",
                                          "--cpu-prof-name=gateway.cpuprofile", "--cpu-prof-interval=1000"])
        self.assertNotIn("NODE_OPTIONS", result["env"])
        self.assertNotIn("ASYNC_RECEIPT_METRICS_ENABLE", result["env"])
        self.assertNotIn("ASYNC_RECEIPT_FAULT_ENABLE", result["env"])
        self.assertTrue(result["profile"]["cpuProfileEnabled"])
        self.assertIn("gateway = spawn(process.execPath, [...gatewayNodeArgs,", generated())
        self.assertEqual(generated().count("...gatewayNodeArgs"), 1)

    def test_cpu_profile_rejects_observers_faults_and_multiple_gateways(self):
        for extra in ({"PAIR_ASYNC_METRICS": "1"}, {"PAIR_ASYNC_FAULTS": "1"}, {"PAIR_INSTANCES": "2"}):
            self.assertNotEqual(select({"PAIR_ASYNC_CPU_PROFILE": "1", **extra}).returncode, 0)

    def test_normal_controls_have_no_cpu_flags_and_preserve_observer_choice(self):
        off = json.loads(select({}).stdout)
        self.assertEqual(off["args"], [])
        self.assertFalse(off["profile"]["cpuProfileEnabled"])
        self.assertNotIn("NODE_OPTIONS", off["env"])
        on = json.loads(select({"PAIR_ASYNC_METRICS": "1"}).stdout)
        self.assertEqual(on["args"], [])
        self.assertIn("async-receipt-metrics-observer.cjs", on["env"]["NODE_OPTIONS"])


if __name__ == "__main__": unittest.main()
