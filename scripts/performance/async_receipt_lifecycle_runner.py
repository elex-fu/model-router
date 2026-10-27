"""Bounded actual native SIGKILL/restart and SIGTERM handoff probes.

Fixture-only. Private child environment is read only from the verified owned
gateway PID and retained in memory to restart the SAME database/namespace.
It is never serialized or logged. All published facts are aggregate/scalar.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

from async_receipt_fixture_checks import assert_completed_http, assert_receipt_not_written, assert_conservation, wait_until
from async_receipt_launcher_adapter import adapt


def owned_environment(pid, source):
    process = Path(f"/proc/{pid}")
    command = process.joinpath("cmdline").read_bytes().split(b"\0")
    assert str(Path(source) / "dist/cli/index.js").encode() in command, "only the owned frozen gateway may be inspected"
    return {os.fsdecode(key): os.fsdecode(value) for key, value in (
        part.split(b"=", 1) for part in process.joinpath("environ").read_bytes().split(b"\0") if b"=" in part
    )}


def readiness_closed(url):
    try:
        with urllib.request.urlopen(url + "/readyz", timeout=.25) as response:
            return response.status != 200
    except (urllib.error.URLError, OSError):
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--window", type=Path, required=True)
    parser.add_argument("--case", choices=["kill-after-eof", "term-inflight"], required=True)
    args = parser.parse_args()
    if not args.execute:
        parser.error("--execute requires an explicitly authorized local functional scope")
    assert args.label.startswith("async-receipt-")
    assert json.loads(args.window.read_text())["state"] == "open"
    assert subprocess.check_output(["git", "-C", args.source, "rev-parse", "HEAD"], text=True).strip() == args.expected_source
    here = Path(__file__).resolve().parent
    generated = args.harness / "router-launch-async-receipt.mjs"
    generated.write_text(adapt((args.harness / "router-launch.mjs").read_text(), base_directory=args.harness, observer_directory=here))
    subprocess.run(["node", "--check", str(generated)], check=True)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation
    from redis_counter_capture import capture
    os.environ.update(PAIR_CONCURRENCY_CAP="64", PAIR_PREPARED="off", PAIR_CONNECTION_REUSE="auto",
        PAIR_BUILTIN_ESTIMATOR="1", PAIR_TRANCHE_MINOR_UNITS="auto", PAIR_EXPECT_COLD_SUCCESS="1", PAIR_SEED_HEALTH="0",
        PAIR_MOCK_DELAY_MS="1000" if args.case == "term-inflight" else "5")
    args.mode = "smoke"; args.replicates = 1

    class OwnedFixture(Evaluation):
        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = dict(env, PAIR_ASYNC_FAULTS="1", PAIR_ASYNC_METRICS="1")
                for key in list(env):
                    if key.startswith("MODEL_ROUTER_FAST_RECEIPT_"):
                        del env[key]
                env["MODEL_ROUTER_FAST_RECEIPT_MODE"] = "memory-queue"
            return super().spawn(name, command, env)

        def stop(self, process):
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=55)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

        def save_observers(self, name, pid=None, prefix="async-receipt"):
            output = self.out / f"{prefix}-queue-metrics.json"
            old = output.stat().st_mtime_ns if output.exists() else -1
            os.kill(pid or self.info["gatewayPid"], signal.SIGUSR2)
            wait_until(lambda: output.exists() and output.stat().st_mtime_ns > old)
            metrics = json.loads(output.read_text())
            self.save(name + "-queue-metrics", metrics)
            self.save(name + "-fault-events", json.loads((self.out / f"{prefix}-fault-events.json").read_text()))
            assert metrics["invalidObservations"] == 0
            return metrics

    fixture = OwnedFixture(args)
    hold = None
    expected_killed_pid = None
    try:
        fixture.save("manifest", {"source_commit": args.expected_source, "publication_status": "LOCAL_UNPUBLISHED",
            "case": args.case, "not_performance_acceptance": True, "receipt_mode": "memory-queue",
            "fault_preload": True, "queue_telemetry_factory_wrapper": True,
            "mock_delay_ms": int(os.environ["PAIR_MOCK_DELAY_MS"]), "M": 524480, "auto_credit_formula": "2*M*64",
            "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "generated_launcher_sha256": hashlib.sha256(generated.read_bytes()).hexdigest(),
            "restart_contract": "same database/namespace/owner, new process epoch, DRAINED=0, no reseed; private env stays in memory"})
        fixture.start_services(); fixture.start_router(observer=False); fixture.warm(1)
        before = fixture.census(); before_mock = fixture.metrics(); before_redis = capture(fixture)
        assert_conservation(before)
        hold = fixture.out / "receipt-before-sql.hold"
        waiting = fixture.out / "receipt-before-sql.waiting"
        waiting.unlink(missing_ok=True); hold.write_text("hold\n")

        if args.case == "kill-after-eof":
            result = fixture.request()
            assert_completed_http(result, False)
            wait_until(waiting.exists)
            held = fixture.census(); assert_receipt_not_written(before, held)
            queued = fixture.save_observers("before-kill")
            assert queued["latest"]["pending"] == queued["latest"]["undurable"] == 1
            assert queued["latest"]["undurableLiabilityByCurrency"] == {"USD": "524480"}
            child_pid = fixture.info["gatewayPid"]
            environment = owned_environment(child_pid, args.source)
            assert environment["MODEL_ROUTER_FAST_NAMESPACE"] == fixture.db
            expected_killed_pid = child_pid
            os.kill(child_pid, signal.SIGKILL)
            assert fixture.gateway.wait(timeout=10) != 0, "wrapper must expose unexpected gateway death"
            killed_cleanup = json.loads((fixture.out / "async-gateway-cleanup.json").read_text())
            assert killed_cleanup["allExited"] and not killed_cleanup["allGraceful"]
            assert killed_cleanup["children"] == [{"pid": child_pid, "exitCode": None, "signal": "SIGKILL", "forcedKill": False, "exited": True}]
            fixture.save("expected-sigkill-cleanup", killed_cleanup)
            hold.unlink()
            # The same Redis remains alive; a new gateway must NOT claim it is drained.
            environment["MODEL_ROUTER_FAST_REDIS_DRAINED"] = "0"
            environment["ASYNC_RECEIPT_METRICS_OUTPUT"] = str(fixture.out / "restart-queue-metrics.json")
            environment["ASYNC_RECEIPT_FAULT_OUTPUT"] = str(fixture.out / "restart-fault-events.json")
            restart = fixture.spawn("gateway-restart", ["node", Path(args.source) / "dist/cli/index.js", "start", "--role", "gateway"], env=environment)
            fixture.wait_http(fixture.info["gatewayUrl"] + "/readyz", restart)
            # Bounded no-automatic-replay observation, not a claim about infinity.
            time.sleep(2)
            after = fixture.census(); after_redis = capture(fixture)
            assert_receipt_not_written(before, after)
            assert fixture.metrics()["received"] - before_mock["received"] == 1
            for scope in ("tenant", "project", "key"):
                assert after_redis[scope]["live_slots"] == 0
                assert after_redis[scope]["reserved_token_units"] - before_redis[scope]["reserved_token_units"] == 262208
            fixture.save("same-db-restart-proof", {"external_eof_before_kill": True, "before": before, "held": held,
                "after_restart": after, "redis_after_restart": after_redis,
                "same_database": True, "same_namespace": True, "reseeded": False, "redis_drained": False,
                "observed_replay_window_seconds": 2, "raw_mock_send_delta": 1,
                "lost_usage_receipt_reconstructed": False, "full_M_retained": True})
            fixture.stop(restart)
            assert restart.returncode == 0
            after_stop = fixture.census(); assert_conservation(after_stop)
            # A clean restart may retire unused backing. That is allowed; the
            # unresolved intent's FULL M must remain and no receipt is invented.
            assert after_stop["intent_count"] == before["intent_count"] + 1
            assert after_stop["allocation_unresolved_liability_minor_units"] == 524480
            assert after_stop["allocation_unresolved_max_minor_units"] == 524480
            for key in ("receipt_count", "receipt_release_count", "settlement_ledger_count", "settlement_ledger_minor_units", "wallet_posted_minor_units"):
                assert after_stop[key] == before[key], key
            fixture.save("restart-clean-shutdown-retained-M", after_stop)
            restart_metrics = json.loads((fixture.out / "restart-queue-metrics.json").read_text())
            fixture.save("restart-final-queue-metrics", restart_metrics)
            assert restart_metrics["latest"]["accepted"] == restart_metrics["latest"]["durable"] == restart_metrics["latest"]["completed"] == 0
            fixture.drain("known-unknown-after-restart", fixture.total, allow_unknown=1)
        else:
            pool = ThreadPoolExecutor(max_workers=1)
            try:
                pending = pool.submit(fixture.request)
                wait_until(lambda: fixture.metrics()["received"] == before_mock["received"] + 1)
                at_term = fixture.metrics()
                assert at_term["completed"] == before_mock["completed"], "TERM target must be actually in upstream flight"
                fixture.gateway.terminate()
                wait_until(lambda: readiness_closed(fixture.info["gatewayUrl"]), timeout=5)
                admission_outcome = None
                try:
                    denied = fixture.request()
                    assert denied["status"] == 503
                    admission_outcome = "http-503"
                except (urllib.error.URLError, OSError):
                    admission_outcome = "transport-closed"
                result = pending.result(timeout=5)
                assert_completed_http(result, False)
                wait_until(waiting.exists)
                held = fixture.census(); assert_receipt_not_written(before, held)
                assert fixture.gateway.poll() is None, "TERM cannot finish while receipt remains held"
                fixture.save("term-inflight-handoff-proof", {"upstream_at_term": at_term,
                    "client_eof_completed_after_term": True, "new_admission": admission_outcome,
                    "before": before, "held": held, "receipt_SQL_still_held": True})
            finally:
                hold.unlink(missing_ok=True)
                pool.shutdown(wait=True)
            assert fixture.gateway.wait(timeout=55) == 0
            cleanup = json.loads((fixture.out / "async-gateway-cleanup.json").read_text())
            assert cleanup["allExited"] and cleanup["allGraceful"]
            fixture.save("term-graceful-cleanup", cleanup)
            fixture.total += 1
            final = fixture.drain("term-final", fixture.total)
            assert final["allocation_unresolved_liability_minor_units"] == 0
            assert final["allocation_backing_minor_units"] == 0, "free backing retired only after full queue/journal drain"
            assert fixture.metrics()["received"] - before_mock["received"] == 1
            metrics = json.loads((fixture.out / "async-receipt-queue-metrics.json").read_text())
            fixture.save("term-final-queue-metrics", metrics)
            assert metrics["latest"]["pending"] == metrics["latest"]["undurable"] == 0
            assert metrics["latest"]["accepted"] == metrics["latest"]["durable"] == metrics["latest"]["completed"] == 2
        fixture.save("result", {"passed": True, "not_performance_acceptance": True,
            "case": args.case, "publication_status": "LOCAL_UNPUBLISHED", "expected_sigkill_pid": expected_killed_pid})
        print("ASYNC_RECEIPT_LIFECYCLE_PASS", args.case, flush=True)
    finally:
        if hold is not None: hold.unlink(missing_ok=True)
        fixture.cleanup()


if __name__ == "__main__": main()
