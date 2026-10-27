"""Generate a separate local fixture launcher; never edit the GEN17 baseline.

The pinned input is the already-qualified external local benchmark assembly,
not production source. Generated runtime files may include local paths and must
be sanitized independently before publication. This command launches nothing.
"""
import argparse
import hashlib
import json
from pathlib import Path

BASE_SHA256 = "69aa094f600abcb8a79a7394073d35845598b0a86a3d675d2e1ec4776a605d46"


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("ASYNC_RECEIPT_LAUNCHER_ANCHOR_MISMATCH")
    return source.replace(old, new, 1)


def adapt(source, *, base_directory, observer_directory):
    if hashlib.sha256(source.encode()).hexdigest() != BASE_SHA256:
        raise ValueError("ASYNC_RECEIPT_BASELINE_HASH_MISMATCH")
    observers = Path(observer_directory).resolve()
    source = replace_once(source, "import('./byok-fixture.mjs')", f"import({json.dumps((Path(base_directory).resolve() / 'byok-fixture.mjs').as_uri())})")
    hook = r'''
  // Dedicated async fixture env allowlist. No money/price/cap/pool changes.
  const receiptKeys = ['MODE','MAX_ENTRIES','MAX_BYTES','WORKERS','MAX_PER_TENANT','MAX_AGE_MS','DRAIN_TIMEOUT_MS'].map(suffix => 'MODEL_ROUTER_FAST_RECEIPT_' + suffix);
  const receiptOverrides = {};
  for (const key of receiptKeys) if (process.env[key] !== undefined) {
    const value = process.env[key];
    assert.ok(key.endsWith('_MODE') ? ['durable','memory-queue'].includes(value) : /^[1-9][0-9]*$/.test(value), 'Invalid async fixture setting');
    env[key] = value; receiptOverrides[key] = value;
  }
  const faultEnabled = process.env.PAIR_ASYNC_FAULTS === '1';
  const metricsEnabled = process.env.PAIR_ASYNC_METRICS === '1';
  const cpuProfileEnabled = process.env.PAIR_ASYNC_CPU_PROFILE === '1';
  // CLI flags belong to the gateway child, not the fixture launcher. The
  // profiler starts at process startup and writes only during graceful exit.
  assert.ok(!cpuProfileEnabled || (!faultEnabled && !metricsEnabled && Number(process.env.PAIR_INSTANCES ?? '1') === 1), 'CPU profile requires observer/fault OFF and exactly one gateway');
  const gatewayNodeArgs = cpuProfileEnabled ? ['--cpu-prof', '--cpu-prof-dir=' + out, '--cpu-prof-name=gateway.cpuprofile', '--cpu-prof-interval=1000'] : [];
  // Do not combine with the old request observer or profiler.
  assert.ok(!env.NODE_OPTIONS, 'Async fixture owns its explicitly selected preloads');
  const preloads = [];
  if (faultEnabled) {
    preloads.push(FAULT_OBSERVER);
    env.ASYNC_RECEIPT_FAULT_ENABLE = '1';
    env.ASYNC_RECEIPT_FAULT_DIRECTORY = out;
    env.ASYNC_RECEIPT_FAULT_OUTPUT = join(out, 'async-receipt-fault-events.json');
  }
  if (metricsEnabled) {
    preloads.push(METRICS_OBSERVER);
    env.ASYNC_RECEIPT_METRICS_ENABLE = '1';
    env.ASYNC_RECEIPT_METRICS_OUTPUT = join(out, 'async-receipt-queue-metrics.json');
    env.ASYNC_RECEIPT_METRICS_EVENT_LIMIT = faultEnabled ? '10000' : '0';
  }
  if (preloads.length) env.NODE_OPTIONS = preloads.map(file => '--require ' + JSON.stringify(file)).join(' ');
  await writeFile(join(out, 'async-receipt-profile.json'), JSON.stringify({
    mode: env.MODEL_ROUTER_FAST_RECEIPT_MODE ?? 'durable',
    modeSettingOmitted: env.MODEL_ROUTER_FAST_RECEIPT_MODE === undefined,
    receiptOverrides, faultEnabled, metricsEnabled, cpuProfileEnabled,
    cpuProfileArguments: gatewayNodeArgs,
    baselineLauncherSha256: 'BASELINE_HASH',
    note: 'Declared env settings; actual behavior must be verified by native boundary tests.'
  }, null, 2) + '\n', { mode: 0o600 });
'''.replace("FAULT_OBSERVER", json.dumps(str(observers / "async-receipt-fault-observer.cjs")))
    hook = hook.replace("METRICS_OBSERVER", json.dumps(str(observers / "async-receipt-metrics-observer.cjs"))).replace("BASELINE_HASH", BASE_SHA256)
    source = replace_once(source, "  const log = createWriteStream(join(out, 'gateway.log'),", hook + "  const log = createWriteStream(join(out, 'gateway.log'),")
    source = replace_once(source,
        "gateway = spawn(process.execPath, [join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway']",
        "gateway = spawn(process.execPath, [...gatewayNodeArgs, join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway']")
    source = replace_once(source,
        "for(const child of gateways)assert.equal(child.exitCode,null,'Gateway exited during paired benchmark');",
        "for(const child of gateways)assert.ok(child.exitCode===null && child.signalCode===null,'Gateway exited during async functional fixture');")
    old_cleanup = "  for(const child of gateways)if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(10000)]);if(child.exitCode===null)child.kill('SIGKILL');}"
    new_cleanup = r'''  const { waitForExit } = await import(EXIT_HELPER);
  const gatewayCleanup = [];
  const active = child => child.exitCode === null && child.signalCode === null;
  for (const child of gateways) {
    let forcedKill = false;
    if (active(child)) {
      child.kill('SIGTERM');
      await waitForExit(child, 45000);
      if (active(child)) {
        forcedKill = true; child.kill('SIGKILL');
        await waitForExit(child, 5000);
      }
    }
    gatewayCleanup.push({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, forcedKill, exited: !active(child) });
  }
  await writeFile(join(out, 'async-gateway-cleanup.json'), JSON.stringify({
    allExited: gatewayCleanup.every(item => item.exited),
    allGraceful: gatewayCleanup.every(item => item.exited && item.exitCode === 0 && item.signal === null && !item.forcedKill),
    children: gatewayCleanup,
  }, null, 2) + '\n', { mode: 0o600 });'''.replace("EXIT_HELPER", json.dumps((observers / "async-receipt-child-exit.cjs").as_uri()))
    source = replace_once(source, old_cleanup, new_cleanup)
    return "// GENERATED functional async adapter; original GEN17 launcher remains untouched.\n" + source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--observers", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    if args.base.resolve() == args.out.resolve():
        raise ValueError("ASYNC_RECEIPT_REFUSE_BASELINE_OVERWRITE")
    generated = adapt(args.base.read_text(), base_directory=args.base.parent, observer_directory=args.observers)
    args.out.write_text(generated)
    args.out.with_suffix(args.out.suffix + ".derivation.json").write_text(json.dumps({
        "baseline_sha256": BASE_SHA256,
        "generated_sha256": hashlib.sha256(generated.encode()).hexdigest(),
        "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "production_changes": False, "launched": False,
        "delta": ["receipt env allowlist", "explicit isolated preloads", "safe profile", "signal-aware lifecycle", "45s external TERM bound and actual exit evidence"],
    }, indent=2) + "\n")


if __name__ == "__main__": main()
