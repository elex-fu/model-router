"""Bounded same-source receipt pilot/diagnostic scenes, not full acceptance.

No fault/phase/SQL profiler. Only the explicit observer-cost plan omits the
numeric queue observer in its OFF scene; absent telemetry is not a zero queue.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from async_receipt_launcher_adapter import adapt
from async_receipt_fixture_checks import wait_until
from async_receipt_cpu_profile import summarize_cpu_profile

OBSERVER_COST_PLAN = "observer-workers8-c32-60s"
CPU_PROFILE_PLAN = "cpu-profile-workers8-c32-30s"

# Atomic read-only, post-load census of this fixture's lease tombstones. Only
# aggregate counts leave Redis; no lease identity, binding or token is emitted.
LEASE_CENSUS_LUA = """
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+tonumber(clock[2])/1000
local result={observed_at_redis_ms=now,records=0,settled_actual=0,expired_pending=0,unresolved=0}
local cursor='0'; local seen={}
repeat
  local page=redis.call('SCAN',cursor,'MATCH',ARGV[1]..':lease:*','COUNT',1000)
  cursor=page[1]
  for _,key in ipairs(page[2]) do
    if not seen[key] then
      seen[key]=true
      local raw=redis.call('GET',key)
      if raw then
        local r=cjson.decode(raw)
        result.records=result.records+1
        if r.state=='released' and r.usageState=='settled' and r.actualTokenUnits==15 then
          result.settled_actual=result.settled_actual+1
        elseif r.state=='released' and r.usageState=='pending' and tonumber(r.bucket)
          and tonumber(r.bucket)*1000+61000<=now then
          result.expired_pending=result.expired_pending+1
        else result.unresolved=result.unresolved+1 end
      end
    end
  end
until cursor=='0'
return cjson.encode(result)
"""


def capture_lease_reconciliation(fixture):
    from evaluate import REDIS, REDISPORT
    from redis_counter_capture import digest
    prefix = "mr:fast:{" + digest([fixture.db]) + "}"
    return json.loads(subprocess.check_output([
        str(REDIS / "redis-cli"), "-h", "127.0.0.1", "-p", str(REDISPORT), "-n", "1", "--raw",
        "EVAL_RO", LEASE_CENSUS_LUA, "0", prefix], text=True, env=fixture.env))


def verify_lease_reconciliation(census, total_success):
    assert 0 < census["records"] <= total_success, "ASYNC_PILOT_LEASE_EVIDENCE_REQUIRED"
    assert census["unresolved"] == 0, "ASYNC_PILOT_LIVE_RECONCILIATION_TARGETS"
    assert census["settled_actual"] + census["expired_pending"] == census["records"]
    return {"verified": True, "census": census,
            "scope": "Every retained lease is released and either settled to 15 actual tokens or pending only in its original expired bucket (bucket*1000+61000 <= Redis TIME). Missing expired leases are not counted as observed settlement; no writes or expiry waits."}


def distribution(values):
    values = sorted(values); count = len(values)
    return {"count": count, **{key: values[int((count - 1) * quantile)] if count else None
        for key, quantile in [("p50", .5), ("p95", .95), ("p99", .99), ("p999", .999), ("max", 1)]}}


def scene_plan(name):
    if name == CPU_PROFILE_PLAN:
        return [("cpu-profile-c32-workers8", "memory-queue", 1000000, 32, False, 30)]
    if name == OBSERVER_COST_PLAN:
        return [("observer-on-c32-workers8", "memory-queue", 1000000, 32, False, 60),
                ("observer-off-c32-workers8", "memory-queue", 1000000, 32, False, 60)]
    if name == "phase-workers2-30s":
        return [("phase-c32-workers2", "memory-queue", 1000000, 32, False, 30)]
    if name == "workers4-8-c32-60s":
        return [("sustained-c32", "durable", 1000000, 32, False, 60),
                ("sustained-c32-workers4", "memory-queue", 1000000, 32, False, 60),
                ("sustained-c32-workers8", "memory-queue", 1000000, 32, False, 60)]
    if name != "pilot-six":
        raise ValueError("ASYNC_PILOT_UNKNOWN_PLAN")
    return [("serial-json", "durable", 1000, 1, False, 0),
            ("serial-json", "memory-queue", 1000, 1, False, 0),
            ("serial-sse", "memory-queue", 1000, 1, True, 0),
            ("serial-sse", "durable", 1000, 1, True, 0),
            ("sustained-c32", "durable", 1000000, 32, False, 60),
            ("sustained-c32", "memory-queue", 1000000, 32, False, 60)]


def scene_worker_override(plan, protocol):
    if plan == CPU_PROFILE_PLAN:
        return {"cpu-profile-c32-workers8": 8}[protocol]
    if plan == OBSERVER_COST_PLAN:
        return {"observer-on-c32-workers8": 8, "observer-off-c32-workers8": 8}[protocol]
    if plan != "workers4-8-c32-60s":
        return None
    return {"sustained-c32": None, "sustained-c32-workers4": 4,
            "sustained-c32-workers8": 8}[protocol]


def scene_metrics_enabled(plan, protocol):
    if plan == CPU_PROFILE_PLAN:
        return {"cpu-profile-c32-workers8": False}[protocol]
    if plan == OBSERVER_COST_PLAN:
        return {"observer-on-c32-workers8": True, "observer-off-c32-workers8": False}[protocol]
    return True


def router_environment(env, mode, workers, metrics_enabled, cpu_profile=False):
    assert not cpu_profile or not metrics_enabled, "ASYNC_PILOT_CPU_PROFILE_OBSERVER_MUST_BE_OFF"
    env = dict(env, PAIR_ASYNC_FAULTS="0", PAIR_ASYNC_METRICS="1" if metrics_enabled else "0",
               PAIR_ASYNC_CPU_PROFILE="1" if cpu_profile else "0")
    for key in list(env):
        if key.startswith("MODEL_ROUTER_FAST_RECEIPT_"): del env[key]
    env["MODEL_ROUTER_FAST_RECEIPT_MODE"] = mode
    if workers is not None:
        env["MODEL_ROUTER_FAST_RECEIPT_WORKERS"] = str(workers)
    return env


def unavailable_queue_telemetry():
    return {"available": False, "enabled": False, "reason": "observer disabled; not measured",
            "observations": None, "latest": None, "baseline": None,
            "counterDeltas": None, "observedPeaks": None, "undurableLiabilityPeaksByCurrency": None,
            "receiptAckLag": None, "phaseMetrics": {"available": False, "groups": None},
            "queue_empty_verified": None}


def queue_metrics_snapshot(fixture, reset=False):
    # OFF has no signal handlers installed. Never signal it or fabricate
    # counters from an absent file (SIGHUP would terminate the gateway).
    if not fixture.metrics_enabled: return unavailable_queue_telemetry()
    file = fixture.out / "async-receipt-queue-metrics.json"
    old = file.stat().st_mtime_ns if file.exists() else -1
    os.kill(fixture.info["gatewayPid"], signal.SIGWINCH if reset else signal.SIGHUP)
    wait_until(lambda: file.exists() and file.stat().st_mtime_ns > old, timeout=5)
    value = json.loads(file.read_text())
    assert value["eventLimit"] == 0 and value["invalidObservations"] == 0
    return value


def verify_tpm_reconciled(counters, total_success, observed_at_redis_ms=None):
    """Exact actual usage in live original buckets, not expired lifetime totals."""
    bucket_proof = {}
    for scope in ("tenant", "project", "key", "account"):
        assert counters[scope]["live_slots"] == 0, "ASYNC_PILOT_ADMISSION_SLOTS_NOT_DRAINED"
    for scope in ("tenant", "project", "key"):
        state = counters[scope]
        assert 0 < state["reserved_requests"] <= total_success, "ASYNC_PILOT_RATE_REQUESTS_UNPROVEN"
        assert state["buckets"], "ASYNC_PILOT_RATE_BUCKETS_REQUIRED"
        live_requests = 0; expired_buckets = 0
        for bucket, (requests, tokens) in state["buckets"].items():
            assert isinstance(requests, int) and requests >= 0
            if observed_at_redis_ms is not None and int(bucket) * 1000 + 61000 <= observed_at_redis_ms:
                expired_buckets += 1
            else:
                assert tokens == 15 * requests, "ASYNC_PILOT_TPM_BUCKET_NOT_RECONCILED"
                live_requests += requests
        assert live_requests > 0, "ASYNC_PILOT_LIVE_RATE_EVIDENCE_REQUIRED"
        assert state["reserved_requests"] == sum(value[0] for value in state["buckets"].values())
        assert state["reserved_token_units"] == sum(value[1] for value in state["buckets"].values())
        bucket_proof[scope] = {"live_requests": live_requests, "live_actual_tokens": live_requests * 15,
                               "retained_but_expired_buckets": expired_buckets}
    return {"verified": True, "actual_tokens_per_success": 15, "counters": counters,
            "bucket_proof": bucket_proof, "observed_at_redis_ms": observed_at_redis_ms,
            "scope": "All four admission scopes have no live slots; each live original tenant/project/key rate bucket equals 15 actual tokens per request. Original buckets expire at bucket*1000+61000 using Redis TIME; expired buckets are not lifetime accounting."}


def receipt_append_calls(rows):
    # PGSS may discard the source comment. Do not apply retroactively to GEN18
    # summaries: its additive qualification sidecar preserves that parser miss.
    return sum(row["calls"] for row in rows if
        "fast-journal:append-receipt" in row["query"] or
        (row["query"].lstrip().startswith("WITH receipt AS (") and
         "INSERT INTO saas_fast_gateway_receipts" in row["query"]))


def verify_phase_metrics(telemetry):
    phases = telemetry["phaseMetrics"]
    assert phases["available"], "ASYNC_PHASE_METRICS_REQUIRED"
    counters = telemetry["counterDeltas"]
    receipt_attempts = counters["durable"] + counters["retries"] + counters["conflicts"]
    reconciliation_attempts = (counters["completed"] - phases["completedWithoutReconciliationDelta"]
                               + counters["reconciliationRetries"])
    expected = {"receiptQueueWait": receipt_attempts, "receiptAwait": receipt_attempts,
                "reconciliationQueueWait": reconciliation_attempts,
                "reconciliationAwait": reconciliation_attempts, "residence": counters["completed"]}
    for phase, count in expected.items():
        group = phases["groups"][phase]
        assert group["counterCountDelta"] == group["observedCount"] == sum(group["buckets"]) == count
        assert group["missedTransitions"] == group["counterResets"] == 0
        assert math.isclose(group["counterSumMsDelta"], group["observedSumMs"], rel_tol=1e-9, abs_tol=1e-6)
    return {"verified": True, "settled_receipt_attempts": receipt_attempts,
            "settled_reconciliation_attempts": reconciliation_attempts,
            "completed_residences": counters["completed"],
            "scope": "built-in scalar phase metrics; await includes pool/driver/ACK wait, not pure database or Redis execution"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--client", type=Path, required=True)
    parser.add_argument("--plan", choices=["pilot-six", "phase-workers2-30s", "workers4-8-c32-60s", OBSERVER_COST_PLAN, CPU_PROFILE_PLAN], default="pilot-six")
    args = parser.parse_args()
    if not args.execute: parser.error("--execute requires root quiet-window GO")
    assert args.label.startswith("async-receipt-pilot-")
    assert subprocess.check_output(["git", "-C", args.source, "rev-parse", "HEAD"], text=True).strip() == args.expected_source
    here = Path(__file__).resolve().parent
    assert not any((args.harness.parent / "results").glob(args.label + "-*")), "ASYNC_PILOT_REFUSE_ARTIFACT_OVERWRITE"
    generated = args.harness / ("router-launch-" + args.label + ".mjs")
    assert not generated.exists(), "ASYNC_PILOT_REFUSE_LAUNCHER_OVERWRITE"
    generated.write_text(adapt((args.harness / "router-launch.mjs").read_text(), base_directory=args.harness, observer_directory=here))
    subprocess.run(["node", "--check", str(generated)], check=True)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation, A, ROUTERPORT
    from evaluate_formal import process_snapshot
    from paired_scenes import app_stats
    from quiet_window import capture, wait_active
    from release_quiet import release
    from redis_counter_capture import capture as capture_redis
    os.environ.update(PAIR_CONCURRENCY_CAP="64", PAIR_PREPARED="off", PAIR_CONNECTION_REUSE="auto",
        PAIR_BUILTIN_ESTIMATOR="1", PAIR_TRANCHE_MINOR_UNITS="auto", PAIR_EXPECT_COLD_SUCCESS="1",
        PAIR_SEED_HEALTH="0", PAIR_MOCK_DELAY_MS="5", PAIR_WARM_PROTOCOL="matched-v2",
        PAIR_WINDOW_GENERATION=str(args.generation), PAIR_QUIET_WINDOW_CONFIRMED="1")
    args.mode = "smoke"; args.replicates = 1

    class Pilot(Evaluation):
        receipt_mode = "durable"
        receipt_workers = None
        metrics_enabled = True
        cpu_profile = False

        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = router_environment(env, self.receipt_mode, self.receipt_workers, self.metrics_enabled, self.cpu_profile)
            return super().spawn(name, command, env)

        def stop(self, process):
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=55)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

        def queue_snapshot(self, reset=False):
            return queue_metrics_snapshot(self, reset)

        def queue_empty(self):
            if not self.metrics_enabled: return unavailable_queue_telemetry()
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

        def tpm_drain(self, name):
            # One post-finance probe, not a retry loop that could turn a leaked
            # live reservation into a pass merely by waiting for bucket expiry.
            counters = capture_redis(self)
            leases = capture_lease_reconciliation(self)
            try:
                proof = verify_tpm_reconciled(counters, self.total, leases["observed_at_redis_ms"])
                proof["lease_reconciliation"] = verify_lease_reconciliation(leases, self.total)
            except AssertionError:
                self.save(name + "-tpm-drain", {"verified": False, "last_observed": counters, "lease_census": leases})
                raise
            return self.save(name + "-tpm-drain", proof)

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
    planned = scene_plan(args.plan)
    phase_required = args.plan != "pilot-six"
    observer_cost = args.plan == OBSERVER_COST_PLAN
    cpu_profile = args.plan == CPU_PROFILE_PLAN
    background_truth_required = observer_cost or cpu_profile
    diagnostic_only = args.plan == "phase-workers2-30s" or background_truth_required
    results = []
    owned_gateway_identities = []
    try:
        wait_active(fixture)
        fixture.save("manifest", {"source_commit": args.expected_source, "generation": args.generation,
            "planned": planned, "plan": args.plan, "pilot_only": True, "not_full_performance_acceptance": True,
            "built_in_queue_phase_metrics_required": "when observer enabled" if background_truth_required else phase_required,
            "diagnostic_only": diagnostic_only,
            "queue_telemetry_factory_wrapper": False if cpu_profile else "per-scene" if observer_cost else True, "fault_preload": False, "phase_profiler": False,
            "cpu_profile_only": cpu_profile,
            "cpu_profile_scope": "Gateway child Node CLI --cpu-prof at 1000us; whole process startup/warm/load/drain/shutdown, not timed-window-only. No HTTP/fetch/PG/eventloop observer. Profiled throughput is diagnostic and must not be compared as unprofiled acceptance." if cpu_profile else None,
            "extra_SQL_periodic_sampler": False, "quiet_guard_file_sampler_seconds": 1,
            "client_change": "GEN17 transport/body/workload unchanged; post-loop wall-clock endpoints added",
            "client_sha256": hashlib.sha256(args.client.read_bytes()).hexdigest(),
            "helper_hashes": {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in here.glob("async*receipt*") if file.is_file()},
            "M": 524480, "automatic_credit_target": 67133440, "concurrency_cap": 64, "database_pool_max": 16,
            "warm_protocol": "10 bootstrap + 128 c32 protocol-matched + full financial drain; observer-cost/CPU-profile also prove retained TPM/slots drain; queue snapshot only if observer enabled; minimum1s gap",
            "queue_defaults": {"entries": 256, "bytes": 2097152, "workers": 2, "per_tenant": 64, "max_age_ms": 5000, "drain_timeout_ms": 10000},
            "scene_worker_overrides": {protocol: scene_worker_override(args.plan, protocol) for protocol, *_ in planned},
            "scene_metrics_enabled": {protocol: scene_metrics_enabled(args.plan, protocol) for protocol, *_ in planned},
            "observer_cost_scope": "ON then OFF, one pair only; order-confounded diagnostic, not a repeated acceptance. OFF removes only the synchronous snapshot/observer sink; queue scheduling, internal scalar phase counters and all production behavior remain unchanged." if observer_cost else None,
            "worker_knob_scope": "Existing WORKERS knob changes BOTH receipt and reconciliation phase concurrency; PG pool, queue entries/bytes/per-tenant, M and credit target unchanged.",
            "claim_limit": "Same-source bounded mode/worker pilot only. Not an updated sub2api comparison or repeated acceptance."})
        fixture.start_services()
        for protocol, mode, n, concurrency, stream, duration in planned:
            name = protocol + "-" + mode
            fixture.receipt_mode = mode; fixture.total = 0
            fixture.receipt_workers = scene_worker_override(args.plan, protocol)
            fixture.metrics_enabled = scene_metrics_enabled(args.plan, protocol)
            fixture.cpu_profile = cpu_profile
            fixture.start_router(observer=False)
            owned_gateway_identities.append(process_snapshot(fixture.info["gatewayPid"]))
            fixture.save("source-manifest", {"commit": args.expected_source, "tracked_clean": True,
                "mode": mode, "diagnostic_instrumented": fixture.metrics_enabled,
                "instrumentation_kind": "supported numeric queue telemetry factory wrapper only" if fixture.metrics_enabled else "none; observer disabled",
                "factory_wrapper_preload": fixture.metrics_enabled, "fault_preload": False, "phase_profiler": False,
                "cpu_profiler": cpu_profile,
                "SQL_observer": False, "periodic_SQL_sampler": False})
            profile = json.loads((fixture.out / "async-receipt-profile.json").read_text())
            assert profile["mode"] == mode and profile["metricsEnabled"] == fixture.metrics_enabled and not profile["faultEnabled"]
            assert profile["cpuProfileEnabled"] == cpu_profile
            expected_overrides = {"MODEL_ROUTER_FAST_RECEIPT_MODE": mode}
            if fixture.receipt_workers is not None:
                expected_overrides["MODEL_ROUTER_FAST_RECEIPT_WORKERS"] = str(fixture.receipt_workers)
            assert profile["receiptOverrides"] == expected_overrides
            fixture.save(name + "-profile", profile)
            fixture.warm(10)
            fixture.checkpoint(name)
            warm = fixture.client(name + "-warm", 128, 32, stream)
            assert warm["success"] == warm["requests"] == 128 and warm["status_counts"] == {"200": 128}
            fixture.total += 128; fixture.drain(name + "-warm", fixture.total); fixture.queue_empty()
            if background_truth_required: fixture.tpm_drain(name + "-warm")
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
                tpm_proof = fixture.tpm_drain(name) if background_truth_required else None
                financial_tpm_end_wall_ns = time.time_ns()
                telemetry = fixture.queue_empty()
                # OFF has no pre-shutdown queue-empty observation. Its common
                # finance+TPM endpoint remains comparable; queue lifecycle drain
                # is separately required by the later clean gateway shutdown.
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
            receipt_calls = receipt_append_calls(sql_rows)
            mock_after = fixture.metrics()
            client_start = int(raw["started_at_unix_ns"]); client_end = int(raw["completed_at_unix_ns"])
            clock_error_ns = abs((client_end - client_start) - round(raw["duration_s"] * 1e9))
            clock_stable = clock_error_ns <= 1000000 and abs(clock_after - clock_before) <= 1000000
            full_duration = (durable_end_wall_ns - client_start) / 1e9
            financial_tpm_duration = (financial_tpm_end_wall_ns - client_start) / 1e9
            samples = raw["samples"]
            cpu_valid = cpu_before.get("available") and cpu_after.get("available") and cpu_before["start_ticks"] == cpu_after["start_ticks"]
            resource = {"before": cpu_before, "after": cpu_after, "valid": bool(cpu_valid),
                "scope": "gateway only; includes selected observer and post-EOF checks, excludes shutdown; RSS endpoints are not peaks/private memory"}
            if cpu_valid:
                cpu_ms = ((cpu_after["user_ticks"] + cpu_after["system_ticks"]) - (cpu_before["user_ticks"] + cpu_before["system_ticks"])) * 1000 / cpu_after["ticks_per_second"]
                resource.update(cpu_total_ms=cpu_ms, cpu_ms_per_success=cpu_ms / raw["success"] if raw["success"] else None)
            summary = {"scene": name, "mode": mode, "source_commit": args.expected_source,
                "plan": args.plan, "diagnostic_only": diagnostic_only,
                "receipt_and_reconciliation_workers_each": fixture.receipt_workers or 2,
                "queue_telemetry_enabled": fixture.metrics_enabled,
                "cpu_profile_only": cpu_profile,
                "pilot_only": True, "client": {key: value for key, value in raw.items() if key != "samples"},
                "client_completion_success_rps": raw["throughput_success_rps"],
                "client_plus_durable_drain_seconds": full_duration if fixture.metrics_enabled else None,
                "client_plus_durable_drain_success_rps": raw["success"] / full_duration if clock_stable and fixture.metrics_enabled else None,
                "observed_post_EOF_drain_tail_ms": (full_duration - raw["duration_s"]) * 1000 if fixture.metrics_enabled else None,
                "client_plus_financial_and_tpm_drain_seconds": financial_tpm_duration if background_truth_required else None,
                "client_plus_financial_and_tpm_drain_success_rps": raw["success"] / financial_tpm_duration if background_truth_required and clock_stable else None,
                "financial_and_tpm_drain": tpm_proof,
                "queue_empty_verified_before_shutdown": True if fixture.metrics_enabled else None,
                "observer_off_qualification": None if fixture.metrics_enabled else "Queue occupancy/phase/lag/fallback/retry counts are unavailable, not zero. Financial+TPM completion does not by itself prove queue empty; graceful lifecycle exit is separately required.",
                "drain_timestamp_qualification": "Observed endpoints include client serialization/read, aggregate finance and (for observer-cost) Redis truth probes; ON also observes queue-file acknowledgement. OFF full-queue endpoint is unavailable; lifecycle drain is proved separately after shutdown. Not pure receipt or COMMIT latency.",
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
            if mode == "memory-queue" and fixture.metrics_enabled:
                assert telemetry["counterDeltas"]["accepted"] == telemetry["counterDeltas"]["durable"] == telemetry["counterDeltas"]["completed"]
                assert telemetry["receiptAckLag"]["missedDurableTransitions"] == 0
                assert telemetry["counterDeltas"]["accepted"] + telemetry["counterDeltas"]["fallbacks"] == raw["success"]
            if phase_required and mode == "memory-queue" and fixture.metrics_enabled:
                fixture.save(name + "-phase-verification", verify_phase_metrics(telemetry))
            fixture.stop(fixture.gateway)
            cleanup = json.loads((fixture.out / "async-gateway-cleanup.json").read_text())
            fixture.save(name + "-gateway-cleanup", cleanup)
            assert cleanup["allExited"] and cleanup["allGraceful"]
            # Native shutdown awaits receipt.close() before closing the journal
            # and admission; clean exit is required even when OFF cannot observe
            # the last in-memory removal. Recheck financial truth after exit.
            if background_truth_required:
                fixture.drain(name + "-postshutdown", fixture.total)
                fixture.save(name + "-lifecycle-drain", {"verified": True,
                    "all_exited": True, "all_graceful": True,
                    "queue_empty_verified_before_shutdown": True if fixture.metrics_enabled else None,
                    "scope": "Native graceful shutdown plus exact postshutdown finance; OFF has no occupancy/phase samples."})
            if cpu_profile:
                profile_path = fixture.out / "gateway.cpuprofile"
                assert profile_path.is_file(), "ASYNC_PILOT_CPU_PROFILE_MISSING_AFTER_CLEAN_EXIT"
                output = A / "results" / f"{fixture.label}-{name}.cpuprofile"
                assert not output.exists(), "ASYNC_PILOT_REFUSE_PROFILE_OVERWRITE"
                payload = profile_path.read_bytes(); output.write_bytes(payload)
                profile_summary = summarize_cpu_profile(json.loads(payload))
                profile_summary.update(profile_file=output.name, profile_bytes=len(payload),
                    profile_sha256=hashlib.sha256(payload).hexdigest(),
                    sampling_interval_us=1000, graceful_exit_required=True,
                    scope="Whole gateway process including startup/warm/load/drain/shutdown until profiler stop; profile-file write adds exit latency outside the recorded client/drain timing. No timed-only attribution or unprofiled throughput claim.")
                fixture.save(name + "-cpu-profile-summary", profile_summary)
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
