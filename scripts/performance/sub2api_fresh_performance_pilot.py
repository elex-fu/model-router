"""Pinned Sub2api c32/60s or finite c200 arm; diagnostic, never a parity claim.

Reuses the external GEN17 start_sub/sub_drain fixture, not its periodic SQL
sampler. Importing this module starts nothing. --execute AND the root-owned
active quiet generation are required before binary hashing or service startup.
No downloads, dependency installation, builds, profiler or inference hooks.
"""
import argparse
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import threading
import time

SUB_COMMIT = "ba81c7fd758e425d67f856d601147ef0c5263d3f"
SUB_SHA256 = "1c8ef9adeaf1816d30e34c040cf0289bce4a91490863cc29a8dc80442816ac66"
CLIENT_SHA256 = "a9fb9c9101bfa78bba1e1954eeefedbb1a9e33935c0dbaae62a198726e22a5a0"
MOCK_SHA256 = "cdd05120d8881ffed2cffce86242014e5243099cacee8ed02e9c7df8ed3131a2"
# Values below pin the external, retained GEN17 fixture; no secret content is copied.
TEMPLATE_SHA256 = "1ed712c9d67de44e816616c6d0388c3bcb4ab9008b8be24c64fe1dc51dabb50b"
PRICING_SHA256 = "e092d8fe3fb6abd66ecdc1da5ac1c094d9aaadd07a8d3df752dc5f7d09997812"
HARNESS_SHA256 = {
    "evaluate.py": "84db0457b28032527d6539f668dc30da1d0e8ee795f00a4a050a6fc711f15c8c",
    "paired_scenes.py": "341b80c27abc1401a0973f9bc4fdb6308a0140547582ef83e61ea9e0ab41bfc4",
    "evaluate_formal.py": "eb105674d90a175a4789e5bddd621d1fed65c51722ffba6d3e728bbfe70a75eb",
    "quiet_window.py": "3bb60091276f526f2443dfb9edbd28e031fc17488d772994ca3f121288351842",
    "release_quiet.py": "10ec119768ece9cb0047f0551824527baaf23e5acab20e2126e4040874c88488",
    "seed-benchmark.sql": "58a526948573abcc444da81947ddfab872a551a184018522926a57afde4c0215",
}
WARM_SUCCESSES = 138
FEE = Decimal("0.0000045")
PROFILES = {
    "c32": {"count": 1000000, "concurrency": 32, "duration": 60, "cap": 64},
    "c200": {"count": 10000, "concurrency": 200, "duration": 0, "cap": 256},
}
SHARED_ENV_FORBIDDEN = (
    "GOMAXPROCS", "GODEBUG", "GOGC", "GOMEMLIMIT", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH",
    "PGOPTIONS", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR", "PAIR_RECOVER_AUTHORITY_DBS",
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def profile_config(name="c32"):
    require(name in PROFILES, "SUB_FRESH_PROFILE")
    return dict(PROFILES[name])


def verify_profile(raw, profile):
    require(raw["concurrency"] == profile["concurrency"], "SUB_FRESH_PROFILE_CONCURRENCY")
    require(math.isfinite(raw["duration_s"]) and raw["duration_s"] > 0, "SUB_FRESH_PROFILE_DURATION")
    if profile["duration"]:
        require(60 <= raw["duration_s"] <= 120, "SUB_FRESH_C32_DURATION")
    else:
        require(raw["requests"] == profile["count"], "SUB_FRESH_FINITE_REQUEST_COUNT")


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_hash(path, expected):
    actual = sha256_file(path)
    require(actual == expected, "SUB_FRESH_PIN_MISMATCH: " + Path(path).name)
    return actual


def sub_environment(env):
    """No inherited Sub2api config overrides, GOMAXPROCS, loader or profiler."""
    names = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "DATA_DIR"}
    result = {key: value for key, value in env.items() if key in names}
    require(result.get("TZ") == "UTC", "SUB_FRESH_TIMEZONE_REQUIRED")
    require(result.get("DATA_DIR") and result.get("SSL_CERT_FILE"), "SUB_FRESH_CONFIG_REQUIRED")
    return result


def verify_shared_environment(env):
    """Reject inherited shared-client/mock/SQL runtime or extra-work overrides."""
    present = sorted(key for key in SHARED_ENV_FORBIDDEN if key in env)
    require(not present, "SUB_FRESH_SHARED_ENV_OVERRIDE: " + ",".join(present))
    return {"verified": True, "forbidden_variables_absent": list(SHARED_ENV_FORBIDDEN),
            "scope": "Shared fixture retains other inherited environment; listed Go, loader, libpq and recovery overrides must be absent, even if empty."}


def quiet_sample(capture, fixture):
    try:
        return capture(fixture)
    except Exception as error:
        return {"valid": False, "error_category": type(error).__name__}


def distribution(values):
    values = sorted(values)
    require(all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in values),
            "SUB_FRESH_INVALID_LATENCY")
    count = len(values)
    return {"count": count, **{key: values[int((count - 1) * q)] if count else None
        for key, q in (("p50", .5), ("p95", .95), ("p99", .99), ("p999", .999), ("max", 1))}}


def financial_checks(census, count):
    cost = FEE * count
    return {
        "usage_rows": census["usage_rows"] == count,
        "dedup_rows": census["dedup_rows"] == count,
        "usage_cost": Decimal(str(census["usage_cost"])) == cost,
        "balance": Decimal(str(census["balance"])) == Decimal("1000000") - cost,
        "quota": Decimal(str(census["quota_used"])) == cost,
        "window_5h": Decimal(str(census["window_5h"])) == cost,
        "input_tokens": census["input_tokens"] == count * 10,
        "output_tokens": census["output_tokens"] == count * 5,
    }


def verify_raw(raw, expected=None):
    count = raw["requests"]
    require(isinstance(count, int) and count > 0, "SUB_FRESH_NO_ATTEMPTS")
    require(expected is None or count == expected, "SUB_FRESH_REQUEST_COUNT")
    require(raw["success"] == count and raw["status_counts"] == {"200": count} and not raw["errors"],
            "SUB_FRESH_HTTP_FAILURE")
    require(raw["stream"] is False and len(raw["samples"]) == count, "SUB_FRESH_RAW_SAMPLE_COUNT")
    require(not raw["fallback_reasons"], "SUB_FRESH_UNEXPECTED_FALLBACK")
    for row in raw["samples"]:
        require(row["Status"] == 200 and row["Err"] == "" and row["Bytes"] > 0,
                "SUB_FRESH_INCOMPLETE_SAMPLE")
        require(row["Mode"] == "" and row["Fallback"] == "", "SUB_FRESH_NOT_SUB_RESPONSE")
    distribution([row["MS"] for row in raw["samples"]])
    distribution([row["TTFB"] for row in raw["samples"]])
    return {"verified": True, "attempts": count, "successes": count}


def verify_mock(before, after, count):
    deltas = {key: after[key] - before[key] for key in
              ("received", "completed", "json", "sse", "unexpected_paths", "bad_requests", "write_errors",
               "inference_connections", "inference_tls_full", "inference_tls_resumed")}
    require(deltas["received"] == deltas["completed"] == deltas["json"] == count,
            "SUB_FRESH_MOCK_REQUEST_MISMATCH")
    require(all(deltas[key] == 0 for key in ("sse", "unexpected_paths", "bad_requests", "write_errors")),
            "SUB_FRESH_MOCK_ERROR")
    require(before["in_flight"] == after["in_flight"] == 0, "SUB_FRESH_MOCK_NOT_DRAINED")
    require(before["delay_ms"] == after["delay_ms"] == 5, "SUB_FRESH_MOCK_DELAY")
    require(all(value >= 0 for value in deltas.values()), "SUB_FRESH_MOCK_COUNTER_RESET")
    return {"verified": True, "deltas": deltas}


def resources(before, after, successes):
    require(before.get("available") and after.get("available") and
            before["pid"] == after["pid"] and before["start_ticks"] == after["start_ticks"] and
            before["ticks_per_second"] == after["ticks_per_second"], "SUB_FRESH_PROCESS_IDENTITY")
    ticks = after["user_ticks"] + after["system_ticks"] - before["user_ticks"] - before["system_ticks"]
    span = (after["monotonic_ns"] - before["monotonic_ns"]) / 1e9
    require(ticks >= 0 and span > 0 and successes > 0, "SUB_FRESH_PROCESS_COUNTER")
    cpu = ticks * 1000 / after["ticks_per_second"]
    return {"valid": True, "before": before, "after": after, "cpu_total_ms": cpu,
            "resource_span_s": span, "average_process_cpu_cores": cpu / (span * 1000),
            "cpu_ms_per_success": cpu / successes,
            "scope": "One Sub2api process, all threads, before client through exact DB financial drain; excludes PG/Redis/mock/client. RSS boundary snapshots include shared pages, not peak/private memory. Cache queue completion is not observed."}


def clock_proof(raw, finish_wall_ns, offset_before, offset_after):
    start, end = int(raw["started_at_unix_ns"]), int(raw["completed_at_unix_ns"])
    duration = raw["duration_s"]
    require(math.isfinite(duration) and duration > 0 and finish_wall_ns >= end > start,
            "SUB_FRESH_CLOCK_ORDER")
    error = abs(end - start - round(duration * 1e9))
    stable = error <= 1000000 and abs(offset_after - offset_before) <= 1000000
    return {"stable_within_1ms": stable, "client_wall_monotonic_error_ns": error,
            "outer_offset_change_ns": offset_after - offset_before,
            "financial_seconds": (finish_wall_ns - start) / 1e9,
            "scope": "Includes raw-client serialization/read and DB truth probes, not pure COMMIT latency; no cache/TPM equivalence claim."}


def node_reference(path):
    if path is None:
        return {"available": False, "scope": "No Node comparator supplied; no ratio or multicore claim."}
    value = json.loads(Path(path).read_text())
    resource = value["process_resources"]
    require(value["diagnostic_only"] is True and value["financial_drain_ok"] is True and
            value["zero_denials"] is True and value["business_workers"] == 2 and value["warm_successes"] == WARM_SUCCESSES and
            resource["valid"] and len(resource["business"]) == 2 and resource["primary"]["valid"],
            "SUB_FRESH_NODE_REFERENCE_SCOPE")
    require(resource["combined_cpu_ms"] == resource["business_cpu_ms"] + resource["primary_cpu_ms"],
            "SUB_FRESH_NODE_PRIMARY_NOT_COUNTED")
    return {"available": True, "file": str(Path(path).resolve()), "sha256": sha256_file(path),
            "source_commit": value["source_commit"], "business_workers": 2,
            "process_resource_scope": resource["scope"],
            "scope": "Independent result reference only, not automatically matched/repeated; no derived performance ratio. Node CPU must include both businesses plus primary, and its finance+TPM boundary differs from Sub DB-only drain."}


def stop_owned(process, forced, timeout=45):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            forced.append(process.pid)
            process.kill()
            process.wait(timeout=5)
    return process.returncode


def require_free_ports(ports=(15462, 16399, 18453, 18088)):
    """Fail before inherited FLUSHDB can ever target a pre-existing listener."""
    probes = []
    try:
        for port in ports:
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probes.append(probe)
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", port))
    finally:
        for probe in probes:
            probe.close()
    return {"verified": True, "ports": list(ports),
            "scope": "IPv4 loopback bind probes before startup, not listeners. Exclusive root quiet ownership remains required after probes close."}


def cleanup_children(children, logs, forced, stop):
    errors = []
    for child in reversed(children):
        try:
            stop(child)
        except BaseException as error:
            errors.append({"pid": child.pid, "category": type(error).__name__})
    for log in logs:
        try:
            log.close()
        except BaseException as error:
            errors.append({"stage": "log_close", "category": type(error).__name__})
    return {"all_exited": all(child.poll() is not None for child in children),
            "all_graceful": not errors and not forced and all(child.returncode == 0 for child in children),
            "forced_pids": list(forced), "errors": errors, "exit_codes": [child.returncode for child in children]}


def finalize(result, cleanup, release, save):
    """A passing result is written only after owned cleanup and exact release."""
    try:
        proof = cleanup()
        require(proof["all_exited"], "SUB_FRESH_CLEANUP_INCOMPLETE")
        release()
        require(proof["all_graceful"], "SUB_FRESH_FORCED_OR_ABNORMAL_EXIT")
        save(result)
    except BaseException as error:
        save({"passed": False, "stage": "cleanup_or_release", "error_category": type(error).__name__})
        raise


def revision(path, expected):
    commit = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    require(commit == expected and not dirty, "SUB_FRESH_SOURCE_PIN_OR_DIRTY_TREE")
    return commit


def request_stop(_number, _frame):
    raise InterruptedError("SUB_FRESH_STOP")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True, help="Frozen router repo identity owning quiet generation")
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--sub-source", type=Path, required=True)
    parser.add_argument("--client", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--node-summary", type=Path)
    parser.add_argument("--profile", choices=tuple(PROFILES), default="c32")
    args = parser.parse_args(argv)
    if not args.execute:
        parser.error("--execute and root quiet-window GO required; no service was started")
    require(re.fullmatch(r"sub2api-fresh-pilot-[a-z0-9-]+", args.label) is not None, "SUB_FRESH_LABEL")
    require(args.generation > 0, "SUB_FRESH_GENERATION")
    profile = profile_config(args.profile)
    shared_environment = verify_shared_environment(os.environ)
    require(args.source.resolve() == Path(__file__).resolve().parents[2], "SUB_FRESH_RUNNER_SOURCE_IDENTITY")
    revision(args.source, args.expected_source)
    revision(args.sub_source, SUB_COMMIT)
    # External imports are allowed only from the pinned existing fixture files.
    for name, digest in HARNESS_SHA256.items():
        verify_hash(args.harness / name, digest)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation, A, B, PGPORT, REDISPORT, MOCKPORT
    from evaluate_formal import process_snapshot
    from paired_scenes import start_sub, sub_census, sub_drain, app_stats
    from quiet_window import capture, wait_active
    from release_quiet import release
    require(args.harness.resolve() == (A / "harness").resolve(), "SUB_FRESH_HARNESS_LOCATION")
    require((PGPORT, REDISPORT, MOCKPORT) == (15462, 16399, 18453), "SUB_FRESH_SERVICE_PORTS")
    require(args.sub_source.resolve() == Path("/workspace/scratch/381a7e57e000/sub2api-comparison"),
            "SUB_FRESH_BUNDLED_PRICING_SOURCE")
    require(not list((A / "results").glob(args.label + "-*")), "SUB_FRESH_REFUSE_OVERWRITE")
    os.environ.update(PAIR_CONCURRENCY_CAP=str(profile["cap"]), PAIR_MOCK_DELAY_MS="5", PAIR_WINDOW_GENERATION=str(args.generation),
                      PAIR_QUIET_WINDOW_CONFIRMED="1", PAIR_WARM_PROTOCOL="matched-v2")
    args.mode, args.replicates = "sustained" if args.profile == "c32" else "c200", 1

    class Pilot(Evaluation):
        def __init__(self, options):
            super().__init__(options)
            self.forced = []

        def spawn(self, name, command, env=None):
            if str(command[0]) == str(B / "sub2api"):
                env = sub_environment(env or self.env)
            return super().spawn(name, command, env)

        def stop(self, process):
            return stop_owned(process, self.forced)

        def client(self, name, count, concurrency, duration=0):
            command = [args.client, "-url", "http://127.0.0.1:18088/v1/chat/completions",
                       "-key-file", B / "benchmark-api-key", "-n", str(count), "-c", str(concurrency),
                       "-out", A / "results" / f"{self.label}-{name}.json"]
            if duration:
                command += ["-duration", f"{duration}s"]
            with (A / "logs" / f"{self.label}-{name}-client.log").open("w") as log:
                self.run(command, stdout=log, timeout=150)
            return json.loads((A / "results" / f"{self.label}-{name}.json").read_text())

        def cleanup(self):
            proof = cleanup_children(self.children, self.logs, self.forced, self.stop)
            self.save("cleanup", proof)
            return proof

    fixture = Pilot(args)
    admitted = False
    result = {"passed": False, "stage": "incomplete"}
    name = "timed-" + args.profile + "-sub"
    previous_handlers = {}
    try:
        wait_active(fixture)
        admitted = True
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, request_stop)
        pins = {"sub_binary": verify_hash(B / "sub2api", SUB_SHA256),
                "client": verify_hash(args.client, CLIENT_SHA256),
                "mock": verify_hash(A / "mock-tls-v2", MOCK_SHA256),
                "config_template": verify_hash(B / "data/config.yaml", TEMPLATE_SHA256),
                "pricing_cache": verify_hash(B / "data/pricing/model_pricing.json", PRICING_SHA256),
                "pricing_fallback": verify_hash(args.sub_source / "backend/resources/model-pricing/model_prices_and_context_window.json", PRICING_SHA256)}
        require((B / "data/pricing/model_pricing.sha256").read_text().strip() == PRICING_SHA256,
                "SUB_FRESH_PRICING_HASH_RECORD")
        binary_stat = (B / "sub2api").stat()
        fixture.save("manifest", {"diagnostic_only": True, "source_commit": args.expected_source,
            "sub_source_commit": SUB_COMMIT, "binary": str(B / "sub2api"), "pins": pins,
            "generation": args.generation, "harness_hashes": HARNESS_SHA256,
            "runner_sha256": sha256_file(__file__),
            "source_provenance": "Exact GEN17 recorded binary hash plus pinned clean source checkout; not a fresh reproducible build proof.",
            "profile": args.profile, "timed_profile": profile,
            "database_pool_max_idle": [16, 16], "user_and_each_account_cap": profile["cap"], "provider_accounts": 4,
            "runtime_worker_pool_sizes": None, "runtime_worker_pool_scope": "Not observed; source defaults are not substituted for runtime evidence.",
            "run_mode": "standard", "model": "gpt-4o-mini", "max_tokens": 64,
            "actual_tokens": {"input": 10, "output": 5}, "actual_fee": str(FEE),
            "key_quota_and_5h_1d_7d_limits": 1000000, "initial_balance": 1000000,
            "warm_protocol": "10 serial + CHECKPOINT +128/c32 + exact DB drain + minimum1s gap",
            "periodic_financial_sampler": False, "queue_observer": False, "cpu_profiler": False,
            "sub_environment": "Minimal allowlist; no inherited config/profiler/GOMAXPROCS overrides",
            "shared_environment": shared_environment,
            "node_reference": node_reference(args.node_summary),
            "limits": ["No cache queue-empty or router TPM equivalence evidence.",
                       "GEN17 periodic financial SQL sampling is deliberately not reused; matches boundary-only Node diagnostic.",
                       "Sub account/proxy pooling and financial semantics differ from router.",
                       "One new arm is not matched/repeated acceptance or a new parity claim."]})
        fixture.save("free-port-proof", require_free_ports())
        fixture.start_services()
        require(all(child.poll() is None for child in fixture.children), "SUB_FRESH_OWNED_SERVICE_EXITED")
        pg = json.loads((A / "results" / f"{args.label}-postgres-config.json").read_text())
        expected_pg = {"server_version": "18.0", "fsync": "on", "synchronous_commit": "on",
                       "max_connections": "100", "shared_buffers": "16384", "checkpoint_timeout": "1800",
                       "max_wal_size": "4096", "pg_stat_statements.track": "top", "pg_stat_statements.track_utility": "on"}
        require(all(pg[key] == value for key, value in expected_pg.items()),
                "SUB_FRESH_PG_DURABILITY_PROFILE")
        child, db = start_sub(fixture, "r1-sub")
        fixture.db = db
        require((Path(f"/proc/{child.pid}/exe").stat().st_dev, Path(f"/proc/{child.pid}/exe").stat().st_ino) ==
                (binary_stat.st_dev, binary_stat.st_ino), "SUB_FRESH_EXECUTABLE_IDENTITY")
        cold = fixture.client("cold-bootstrap", 10, 1)
        verify_raw(cold, 10)
        sub_drain(fixture, "cold-bootstrap", db, 10)
        started = time.monotonic()
        fixture.sql(db, "CHECKPOINT")
        fixture.save("checkpoint", {"seconds": time.monotonic() - started, "outside_timing": True})
        warm = fixture.client("matched-warm", 128, 32)
        verify_raw(warm, 128)
        before = sub_drain(fixture, "matched-warm", db, WARM_SUCCESSES)
        warm_drained = time.monotonic()
        mock_before = fixture.metrics()
        fixture.save("mock-before", mock_before)
        time.sleep(max(0, warm_drained + 1 - time.monotonic()))
        fixture.sql(db, "SELECT pg_stat_statements_reset()")
        quiet_before = capture(fixture)
        require(quiet_before["valid"], "SUB_FRESH_QUIET_REQUIRED")
        cpu_before = process_snapshot(child.pid)
        offset_before = time.time_ns() - time.monotonic_ns()
        samples, stopped = [], threading.Event()

        def quiet_guard():
            while not stopped.wait(1):
                samples.append(quiet_sample(capture, fixture))

        guard = threading.Thread(target=quiet_guard, daemon=True)
        guard.start()
        try:
            raw = fixture.client(name, profile["count"], profile["concurrency"], profile["duration"])
            total = WARM_SUCCESSES + raw["success"]
            fixture.save(name + "-immediate", sub_census(fixture, db))
            final = sub_drain(fixture, name, db, total)
            finish_wall = time.time_ns()
            offset_after = time.time_ns() - time.monotonic_ns()
            cpu_after = process_snapshot(child.pid)
        finally:
            stopped.set()
            guard.join()
        quiet_after = capture(fixture)
        mock_after = fixture.metrics()
        fixture.save("mock-after", mock_after)
        app_stats(fixture, name, db, False)
        sql_rows = json.loads((A / "results" / f"{args.label}-{name}-sql.json").read_text())
        clock = clock_proof(raw, finish_wall, offset_before, offset_after)
        checks = financial_checks(final, total)
        summary = {"diagnostic_only": True, "implementation": "sub2api", "source_commit": SUB_COMMIT,
            "runner_source_commit": args.expected_source, "profile": args.profile, "timed_profile": profile,
            "client": {k: v for k, v in raw.items() if k != "samples"},
            "client_completion_success_rps": raw["throughput_success_rps"],
            "client_plus_DB_financial_drain_seconds": clock["financial_seconds"],
            "client_plus_DB_financial_drain_success_rps": raw["success"] / clock["financial_seconds"] if clock["stable_within_1ms"] else None,
            "all_attempt_latency_ms": distribution([row["MS"] for row in raw["samples"]]),
            "first_body_observed_all_status_ms": distribution([row["TTFB"] for row in raw["samples"] if row["Bytes"] > 0]),
            "warm_successes": WARM_SUCCESSES, "census_before": before, "census_after": final,
            "financial_checks": checks, "financial_drain_ok": all(checks.values()),
            "cache_queue_empty_verified": None, "router_TPM_equivalence": None,
            "clock": clock, "process_resources": resources(cpu_before, cpu_after, raw["success"]),
            "sql_recorded_app_role_calls_through_drain": sum(row["calls"] for row in sql_rows),
            "sql_scope": "PGSS recorded Sub app-role calls through DB drain; not RTTs or complete internal SQL.",
            "quiet": {"before": quiet_before, "after": quiet_after, "samples": samples,
                      "valid": quiet_after["valid"] and all(row["valid"] for row in samples)},
            "mock_before": mock_before, "mock_after": mock_after,
            "node_comparison": "Independent Node result only; CPU must include both business workers plus RR primary. No ratio is computed."}
        fixture.save(name + "-summary", summary)
        verify_raw(raw)
        verify_profile(raw, profile)
        mock_proof = verify_mock(mock_before, mock_after, raw["success"])
        fixture.save(name + "-mock-proof", mock_proof)
        require(all(checks.values()) and clock["stable_within_1ms"] and summary["quiet"]["valid"], "SUB_FRESH_FINAL_GATE")
        require(fixture.stop(child) == 0 and not fixture.forced, "SUB_FRESH_GATEWAY_GRACEFUL_EXIT")
        post = sub_drain(fixture, "postshutdown", db, total)
        require(all(financial_checks(post, total).values()), "SUB_FRESH_POSTSHUTDOWN_FINANCE")
        revision(args.sub_source, SUB_COMMIT)
        revision(args.source, args.expected_source)
        result = {"passed": True, "diagnostic_only": True, "scene": name, "attempts": raw["requests"],
                  "success": raw["success"], "financial_drain_ok": True, "cache_queue_empty_verified": None}
        print(json.dumps({**result, "client_rps": raw["throughput_success_rps"],
                          "p99": summary["all_attempt_latency_ms"]["p99"], "status": "awaiting_cleanup"}), flush=True)
    except BaseException as error:
        result = {"passed": False, "diagnostic_only": True, "stage": "experiment", "error_category": type(error).__name__}
        raise
    finally:
        for sig in previous_handlers:
            signal.signal(sig, signal.SIG_IGN)
        try:
            finalize(result, fixture.cleanup,
                     lambda: release(args.generation, args.expected_source, [args.label]) if admitted else None,
                     lambda value: fixture.save("result", value))
        finally:
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    main()
