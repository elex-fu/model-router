"""Six approved same-source durable-vs-memory pilot scenes, not full acceptance.

No fault/phase/SQL profiler. Both modes use the same supported numeric queue
observer wrapper. A metrics-only SIGHUP avoids the fixture's SQL diagnostics.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from async_receipt_launcher_adapter import adapt
from async_receipt_fixture_checks import wait_until


def distribution(values):
    values = sorted(values); count = len(values)
    return {"count": count, **{key: values[int((count - 1) * quantile)] if count else None
        for key, quantile in [("p50", .5), ("p95", .95), ("p99", .99), ("p999", .999), ("max", 1)]}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--client", type=Path, required=True)
    args = parser.parse_args()
    if not args.execute: parser.error("--execute requires root quiet-window GO")
    assert args.label.startswith("async-receipt-pilot-")
    assert subprocess.check_output(["git", "-C", args.source, "rev-parse", "HEAD"], text=True).strip() == args.expected_source
    here = Path(__file__).resolve().parent
    generated = args.harness / "router-launch-async-receipt.mjs"
    generated.write_text(adapt((args.harness / "router-launch.mjs").read_text(), base_directory=args.harness, observer_directory=here))
    subprocess.run(["node", "--check", str(generated)], check=True)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation, A, ROUTERPORT
    from evaluate_formal import process_snapshot
    from paired_scenes import app_stats
    from quiet_window import capture, wait_active
    from release_quiet import release
    os.environ.update(PAIR_CONCURRENCY_CAP="64", PAIR_PREPARED="off", PAIR_CONNECTION_REUSE="auto",
        PAIR_BUILTIN_ESTIMATOR="1", PAIR_TRANCHE_MINOR_UNITS="auto", PAIR_EXPECT_COLD_SUCCESS="1",
        PAIR_SEED_HEALTH="0", PAIR_MOCK_DELAY_MS="5", PAIR_WARM_PROTOCOL="matched-v2",
        PAIR_WINDOW_GENERATION=str(args.generation), PAIR_QUIET_WINDOW_CONFIRMED="1")
    args.mode = "smoke"; args.replicates = 1

    class Pilot(Evaluation):
        receipt_mode = "durable"

        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = dict(env, PAIR_ASYNC_FAULTS="0", PAIR_ASYNC_METRICS="1")
                for key in list(env):
                    if key.startswith("MODEL_ROUTER_FAST_RECEIPT_"): del env[key]
                env["MODEL_ROUTER_FAST_RECEIPT_MODE"] = self.receipt_mode
            return super().spawn(name, command, env)

        def stop(self, process):
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=55)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

        def queue_snapshot(self, reset=False):
            file = self.out / "async-receipt-queue-metrics.json"
            old = file.stat().st_mtime_ns if file.exists() else -1
            os.kill(self.info["gatewayPid"], signal.SIGWINCH if reset else signal.SIGHUP)
            wait_until(lambda: file.exists() and file.stat().st_mtime_ns > old, timeout=5)
            value = json.loads(file.read_text())
            assert value["eventLimit"] == 0 and value["invalidObservations"] == 0
            return value

        def queue_empty(self):
            deadline = time.monotonic() + 30
            while True:
                value = self.queue_snapshot()
                if self.receipt_mode == "durable":
                    assert value["observations"] == 0 and value["latest"] is None
                    return value
                assert value["latest"] is not None
                if value["latest"]["pending"] == 0 and value["latest"]["undurable"] == 0: return value
                if time.monotonic() >= deadline: raise TimeoutError("ASYNC_PILOT_QUEUE_NOT_DRAINED")
                time.sleep(.01)

        def client(self, name, n, c, stream=False, duration=0):
            command = [args.client, "-url", f"http://127.0.0.1:{ROUTERPORT}/v1/chat/completions",
                "-key-file", self.out / "proxy-key", "-n", str(n), "-c", str(c),
                "-out", A / "results" / f"{self.label}-{name}.json"]
            if stream: command.append("-stream")
            if duration: command += ["-duration", f"{duration}s"]
            with (A / "logs" / f"{self.label}-{name}-client.log").open("w") as log:
                self.run(command, stdout=log)
            return json.loads((A / "results" / f"{self.label}-{name}.json").read_text())

    fixture = Pilot(args)
    planned = [("serial-json", "durable", 1000, 1, False, 0),
               ("serial-json", "memory-queue", 1000, 1, False, 0),
               ("serial-sse", "memory-queue", 1000, 1, True, 0),
               ("serial-sse", "durable", 1000, 1, True, 0),
               ("sustained-c32", "durable", 1000000, 32, False, 60),
               ("sustained-c32", "memory-queue", 1000000, 32, False, 60)]
    results = []
    owned_gateway_identities = []
    try:
        wait_active(fixture)
        fixture.save("manifest", {"source_commit": args.expected_source, "generation": args.generation,
            "planned": planned, "pilot_only": True, "not_full_performance_acceptance": True,
            "queue_telemetry_factory_wrapper": True, "fault_preload": False, "phase_profiler": False,
            "extra_SQL_periodic_sampler": False, "quiet_guard_file_sampler_seconds": 1,
            "client_change": "GEN17 transport/body/workload unchanged; post-loop wall-clock endpoints added",
            "client_sha256": hashlib.sha256(args.client.read_bytes()).hexdigest(),
            "helper_hashes": {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in here.glob("async*receipt*") if file.is_file()},
            "M": 524480, "automatic_credit_target": 67133440, "concurrency_cap": 64, "database_pool_max": 16,
            "warm_protocol": "10 bootstrap + 128 c32 protocol-matched + full financial and queue drain + minimum1s gap",
            "queue_defaults": {"entries": 256, "bytes": 2097152, "workers": 2, "per_tenant": 64, "max_age_ms": 5000, "drain_timeout_ms": 10000},
            "claim_limit": "Same-source mode pilot only. Not an updated sub2api comparison or repeated acceptance."})
        fixture.start_services()
        for protocol, mode, n, concurrency, stream, duration in planned:
            name = protocol + "-" + mode
            fixture.receipt_mode = mode; fixture.total = 0
            fixture.start_router(observer=False)
            owned_gateway_identities.append(process_snapshot(fixture.info["gatewayPid"]))
            fixture.save("source-manifest", {"commit": args.expected_source, "tracked_clean": True,
                "mode": mode, "diagnostic_instrumented": True,
                "instrumentation_kind": "supported numeric queue telemetry factory wrapper only",
                "factory_wrapper_preload": True, "fault_preload": False, "phase_profiler": False,
                "SQL_observer": False, "periodic_SQL_sampler": False})
            profile = json.loads((fixture.out / "async-receipt-profile.json").read_text())
            assert profile["mode"] == mode and profile["metricsEnabled"] and not profile["faultEnabled"]
            assert profile["receiptOverrides"] == {"MODEL_ROUTER_FAST_RECEIPT_MODE": mode}
            fixture.save(name + "-profile", profile)
            fixture.warm(10)
            fixture.checkpoint(name)
            warm = fixture.client(name + "-warm", 128, 32, stream)
            assert warm["success"] == warm["requests"] == 128 and warm["status_counts"] == {"200": 128}
            fixture.total += 128; fixture.drain(name + "-warm", fixture.total); fixture.queue_empty()
            warm_drained = time.monotonic()
            before = fixture.census(); mock_before = fixture.metrics()
            time.sleep(max(0, warm_drained + 1 - time.monotonic()))
            fixture.queue_snapshot(reset=True)
            fixture.sql(fixture.db, "SELECT pg_stat_statements_reset()")
            quiet_before = capture(fixture); assert quiet_before["valid"]
            cpu_before = process_snapshot(fixture.info["gatewayPid"])
            clock_before = time.time_ns() - time.monotonic_ns()
            quiet_samples = []; stop_guard = threading.Event()
            def guard():
                while not stop_guard.wait(1): quiet_samples.append(capture(fixture))
            thread = threading.Thread(target=guard, daemon=True); thread.start()
            try:
                raw = fixture.client(name, n, concurrency, stream, duration)
                fixture.total += raw["success"]
                immediate = fixture.census(); fixture.save(name + "-immediate", immediate)
                final = fixture.drain(name, fixture.total, raise_on_error=False)
                telemetry = fixture.queue_empty()
                # Both receipts AND ledger are drained; timestamp is an observed
                # completion bound and includes client serialization/probe cost.
                durable_end_wall_ns = time.time_ns()
                clock_after = time.time_ns() - time.monotonic_ns()
                cpu_after = process_snapshot(fixture.info["gatewayPid"])
            finally:
                stop_guard.set(); thread.join()
            quiet_after = capture(fixture)
            app_stats(fixture, name, fixture.db, True)
            sql_rows = json.loads((A / "results" / f"{fixture.label}-{name}-sql.json").read_text())
            reserve_calls = sum(row["calls"] for row in sql_rows if "fast-journal:reserve-intent" in row["query"] or row["query"].startswith("WITH current_owner AS MATERIALIZED"))
            lookup_calls = sum(row["calls"] for row in sql_rows if row["query"].startswith("SELECT i.request_id, i.intent_digest, COALESCE("))
            receipt_calls = sum(row["calls"] for row in sql_rows if "fast-journal:append-receipt" in row["query"])
            mock_after = fixture.metrics()
            client_start = int(raw["started_at_unix_ns"]); client_end = int(raw["completed_at_unix_ns"])
            clock_error_ns = abs((client_end - client_start) - round(raw["duration_s"] * 1e9))
            clock_stable = clock_error_ns <= 1000000 and abs(clock_after - clock_before) <= 1000000
            full_duration = (durable_end_wall_ns - client_start) / 1e9
            samples = raw["samples"]
            cpu_valid = cpu_before.get("available") and cpu_after.get("available") and cpu_before["start_ticks"] == cpu_after["start_ticks"]
            resource = {"before": cpu_before, "after": cpu_after, "valid": bool(cpu_valid),
                "scope": "gateway only; includes numeric telemetry and durable drain; RSS endpoints are not peaks/private memory"}
            if cpu_valid:
                cpu_ms = ((cpu_after["user_ticks"] + cpu_after["system_ticks"]) - (cpu_before["user_ticks"] + cpu_before["system_ticks"])) * 1000 / cpu_after["ticks_per_second"]
                resource.update(cpu_total_ms=cpu_ms, cpu_ms_per_success=cpu_ms / raw["success"] if raw["success"] else None)
            summary = {"scene": name, "mode": mode, "source_commit": args.expected_source,
                "pilot_only": True, "client": {key: value for key, value in raw.items() if key != "samples"},
                "client_completion_success_rps": raw["throughput_success_rps"],
                "client_plus_durable_drain_seconds": full_duration,
                "client_plus_durable_drain_success_rps": raw["success"] / full_duration if clock_stable else None,
                "observed_post_EOF_drain_tail_ms": (full_duration - raw["duration_s"]) * 1000,
                "drain_timestamp_qualification": "Observed full drain includes client result serialization/read, aggregate finance checks and queue metrics file acknowledgement; not pure receipt or COMMIT latency.",
                "clock": {"stable_within_1ms": clock_stable, "client_wall_vs_monotonic_error_ns": clock_error_ns,
                    "outer_realtime_monotonic_offset_change_ns": clock_after - clock_before,
                    "client_start_unix_ns": str(client_start), "observed_drain_end_unix_ns": str(durable_end_wall_ns)},
                "all_attempt_latency_ms": distribution([sample["MS"] for sample in samples]),
                "first_body_observed_all_status_ms": distribution([sample["TTFB"] for sample in samples if sample["Bytes"] > 0]),
                "zero_denials": raw["success"] == raw["requests"], "financial_drain_ok": final["drain"]["ok"],
                "census_before": before, "census_after": final, "queue_telemetry": telemetry,
                "process_resources": resource,
                "sql_recorded_app_role_calls_through_drain": sum(row["calls"] for row in sql_rows),
                "sql_recorded_calls_per_success": sum(row["calls"] for row in sql_rows) / raw["success"] if raw["success"] else None,
                "sql_scope": "PGSS recorded all app roles including worker/refill through drain and final snapshot; not client RTTs or complete internal trigger SQL",
                "recovery_SQL": {"reserve_calls": reserve_calls, "created_intents": final["intent_count"] - before["intent_count"],
                    "reserve_minus_created": reserve_calls - (final["intent_count"] - before["intent_count"]),
                    "intent_replay_lookup_calls": lookup_calls, "receipt_append_calls": receipt_calls,
                    "created_receipts": final["receipt_count"] - before["receipt_count"]},
                "mock_received_delta": mock_after["received"] - mock_before["received"],
                "mock_completed_delta": mock_after["completed"] - mock_before["completed"],
                "warm_successes": 138, "warm_gap_ms": (cpu_before["monotonic_ns"] / 1e9 - warm_drained) * 1000,
                "quiet": {"before": quiet_before, "after": quiet_after, "samples": quiet_samples,
                    "valid": quiet_before["valid"] and quiet_after["valid"] and all(value["valid"] for value in quiet_samples)}}
            fixture.save(name + "-summary", summary); results.append(summary); fixture.save("pilot-results", results)
            print(json.dumps({"scene": name, "attempts": raw["requests"], "success": raw["success"],
                "client_rps": summary["client_completion_success_rps"], "drained_rps": summary["client_plus_durable_drain_success_rps"],
                "p50": summary["all_attempt_latency_ms"]["p50"], "p99": summary["all_attempt_latency_ms"]["p99"],
                "financial": summary["financial_drain_ok"], "quiet": summary["quiet"]["valid"]}), flush=True)
            assert summary["quiet"]["valid"] and clock_stable
            assert final["drain"]["ok"], final["drain"]
            assert summary["mock_received_delta"] == summary["mock_completed_delta"] == raw["success"]
            assert raw["execution_modes"].get("fast-reserved-max", 0) == raw["success"] and not raw["fallback_reasons"]
            if mode == "memory-queue":
                assert telemetry["counterDeltas"]["accepted"] == telemetry["counterDeltas"]["durable"] == telemetry["counterDeltas"]["completed"]
                assert telemetry["receiptAckLag"]["missedDurableTransitions"] == 0
            fixture.stop(fixture.gateway)
            cleanup = json.loads((fixture.out / "async-gateway-cleanup.json").read_text())
            fixture.save(name + "-gateway-cleanup", cleanup)
            assert cleanup["allExited"] and cleanup["allGraceful"]
        fixture.save("result", {"passed": all(result["zero_denials"] for result in results), "scenes": len(results), "pilot_only": True})
    finally:
        fixture.cleanup()
        still_present = []
        for original in owned_gateway_identities:
            current = process_snapshot(original["pid"])
            if current.get("available") and current.get("start_ticks") == original.get("start_ticks"):
                still_present.append({"pid": original["pid"], "start_ticks": original.get("start_ticks")})
        if still_present:
            # Top-level launcher death alone does not prove its gateway exited.
            # Fail closed and leave this quiet window active for owned cleanup.
            fixture.save("cleanup", {"all_exited": False, "known_gateway_processes_still_present": still_present,
                "top_level_exit_codes": [child.returncode for child in fixture.children]})
            raise RuntimeError("ASYNC_PILOT_DESCENDANT_EXIT_UNPROVEN")
        # Never opens a mismatched/newer generation, and verifies owned exits.
        release(args.generation, args.expected_source, [args.label])


if __name__ == "__main__": main()
