"""Owned actual-HTTP receipt-boundary runner; no benchmark workload.

Uses the existing external Evaluation only after an explicit --execute flag,
an exact source SHA and an open coordination window. The original harness and
GEN17 raw files are never edited. Other crash/backpressure scenes remain separate
planned gates until their actual-run adapters are added and reviewed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from async_receipt_fixture_checks import receipt_before_sql_case, wait_until
from async_receipt_launcher_adapter import adapt, BASE_SHA256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--receipt-mode", choices=["durable", "memory-queue"], required=True)
    parser.add_argument("--omit-mode-setting", action="store_true")
    parser.add_argument("--window", type=Path, required=True)
    args = parser.parse_args()
    if not args.execute:
        parser.error("--execute required after integrated checkpoint and explicit owner GO")
    assert not args.omit_mode_setting or args.receipt_mode == "durable"
    assert json.loads(args.window.read_text())["state"] == "open", "functional scene must not enter another timing window"
    actual_source = subprocess.check_output(["git", "-C", args.source, "rev-parse", "HEAD"], text=True).strip()
    assert actual_source == args.expected_source
    assert args.label.startswith("async-receipt-"), "new labels cannot overwrite GEN17 scenes"
    here = Path(__file__).resolve().parent
    base = args.harness / "router-launch.mjs"
    generated = args.harness / "router-launch-async-receipt.mjs"
    generated.write_text(adapt(base.read_text(), base_directory=args.harness, observer_directory=here))
    subprocess.run(["node", "--check", str(generated)], check=True)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation
    from redis_counter_capture import capture
    os.environ.update(PAIR_CONCURRENCY_CAP="64", PAIR_PREPARED="off", PAIR_WARM_PROTOCOL="matched-v2",
        PAIR_CONNECTION_REUSE="auto", PAIR_BUILTIN_ESTIMATOR="1", PAIR_TRANCHE_MINOR_UNITS="auto",
        PAIR_EXPECT_COLD_SUCCESS="1", PAIR_SEED_HEALTH="0", PAIR_MOCK_DELAY_MS="5")
    args.mode = "smoke"; args.replicates = 1

    class AsyncEvaluation(Evaluation):
        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = dict(env, PAIR_ASYNC_FAULTS="1", PAIR_ASYNC_METRICS="1")
                # Explicit allowlist, never inherit an accidental old queue cap.
                for key in list(env):
                    if key.startswith("MODEL_ROUTER_FAST_RECEIPT_"):
                        del env[key]
                if not args.omit_mode_setting:
                    env["MODEL_ROUTER_FAST_RECEIPT_MODE"] = args.receipt_mode
            return super().spawn(name, command, env)

        def stop(self, process):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=55)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()

        def capture_observers(self, name):
            metric_path = self.out / "async-receipt-queue-metrics.json"
            fault_path = self.out / "async-receipt-fault-events.json"
            old = metric_path.stat().st_mtime_ns if metric_path.exists() else -1
            os.kill(self.info["gatewayPid"], signal.SIGUSR2)
            wait_until(lambda: metric_path.exists() and metric_path.stat().st_mtime_ns > old)
            metrics = json.loads(metric_path.read_text())
            faults = json.loads(fault_path.read_text())
            self.save(name + "-queue-metrics", metrics)
            self.save(name + "-fault-events", faults)
            assert metrics["invalidObservations"] == 0 and faults["dropped"] == 0
            if args.receipt_mode == "memory-queue":
                assert metrics["observations"] > 0 and metrics["latest"]["pending"] == 0
                assert metrics["latest"]["undurable"] == 0
                assert metrics["latest"]["accepted"] == metrics["latest"]["durable"] == metrics["latest"]["completed"]
            else:
                assert metrics["observations"] == 0, "durable mode must not silently instantiate a queue"
            return metrics

    evaluation = AsyncEvaluation(args)
    try:
        evaluation.save("manifest", {
            "source_commit": actual_source, "not_performance_acceptance": True,
            "receipt_mode": args.receipt_mode, "mode_setting_omitted": args.omit_mode_setting,
            "fault_preload": True, "queue_telemetry_factory_wrapper": True,
            "baseline_launcher_sha256": BASE_SHA256,
            "generated_launcher_sha256": hashlib.sha256(generated.read_bytes()).hexdigest(),
            "test_helper_hashes": {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in here.glob("async*receipt*") if file.is_file()},
            "scope": "JSON and SSE external EOF versus actual receipt pre-SQL hold, exact full drain",
            "not_yet_executed_gates": ["SIGKILL/restart", "SIGTERM", "capacity/byte/per-tenant", "age/conflict", "Redis restart"],
        })
        evaluation.start_services()
        evaluation.start_router(observer=False)
        profile = json.loads((evaluation.out / "async-receipt-profile.json").read_text())
        assert profile["mode"] == args.receipt_mode
        assert profile["modeSettingOmitted"] == args.omit_mode_setting
        assert profile["faultEnabled"] and profile["metricsEnabled"]
        evaluation.save("async-profile", profile)
        evaluation.save("source-manifest", {"commit": actual_source, "tracked_clean": True,
            "diagnostic_instrumented": True, "fault_preload": True, "queue_telemetry_factory_wrapper": True,
            "scope": "Functional only; original request observer is disabled"})
        evaluation.warm(1)
        for stream in [False, True]:
            receipt_before_sql_case(evaluation, evaluation.out, mode=args.receipt_mode, stream=stream, capture_redis=capture)
        evaluation.capture_observers("final")
        evaluation.save("result", {"passed": True, "not_performance_acceptance": True,
            "mode": args.receipt_mode, "total_success_including_warm": evaluation.total,
            "expected_charge_minor_units": evaluation.total * 35})
        print("ASYNC_RECEIPT_BOUNDARIES_PASS", args.receipt_mode, flush=True)
    finally:
        evaluation.cleanup()
        if evaluation.out is not None:
            cleanup_file = evaluation.out / "async-gateway-cleanup.json"
            if cleanup_file.exists():
                cleanup = json.loads(cleanup_file.read_text())
                evaluation.save("async-gateway-cleanup", cleanup)
                assert cleanup["allExited"] and cleanup["allGraceful"], cleanup


if __name__ == "__main__": main()
