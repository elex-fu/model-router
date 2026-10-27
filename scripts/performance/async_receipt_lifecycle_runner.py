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

from async_receipt_fixture_checks import assert_completed_http, assert_receipt_not_written, assert_receipt_durable_worker_paused, assert_conservation, wait_until
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


def pressure_case(fixture, case, before, before_mock, hold, waiting):
    if case == "intent-ack-loss":
        hold.unlink()
        (fixture.out / "intent-ack-loss.once").write_text("arm\n")
        result = fixture.request()
        assert result["status"] == 503, result
        after = fixture.census(); assert_receipt_not_written(before, after)
        assert fixture.metrics()["received"] == before_mock["received"]
        fixture.save("intent-ack-loss-no-send-proof", {"response": result, "before": before,
            "after": after, "raw_upstream_send_delta": 0, "unknown_durable_intent_M_retained": 524480})
        fixture.drain("intent-ack-loss-known-unknown", fixture.total, allow_unknown=1)
        return
    if case == "receipt-ack-loss":
        hold.unlink()
        (fixture.out / "receipt-ack-loss.once").write_text("arm\n")
        result = fixture.request(); assert_completed_http(result, False)
        fixture.total += 1
        final = fixture.drain("receipt-ack-loss-final", fixture.total)
        fixture.save_observers("receipt-ack-loss-final")
        events = json.loads((fixture.out / "async-receipt-fault-events.json").read_text())["events"]
        lost = [event for event in events if event["phase"] == "ack_loss_injected" and event["kind"] == "receipt"]
        assert len(lost) == 1
        attempts = [event for event in events if event["phase"] == "query_driver_start" and event["kind"] == "receipt" and event["identityHash"] == lost[0]["identityHash"]]
        assert len(attempts) == 2 and len({event["inputHash"] for event in attempts}) == 1
        assert fixture.metrics()["received"] - before_mock["received"] == 1
        fixture.save("receipt-ack-loss-proof", {"real_driver_success_hidden_once": True,
            "same_identity_and_full_parameter_hash": True, "receipt_sql_attempts": len(attempts),
            "raw_upstream_sends": 1, "receipt_delta": final["receipt_count"] - before["receipt_count"],
            "release_marker_delta": final["receipt_release_count"] - before["receipt_release_count"],
            "ledger_delta": final["settlement_ledger_count"] - before["settlement_ledger_count"]})
        return
    if case == "ledger-pause":
        hold.unlink()
        worker_hold = fixture.out / "worker-before-claim.hold"
        worker_wait = fixture.out / "worker-before-claim.waiting"
        worker_wait.unlink(missing_ok=True); worker_hold.write_text("hold\n")
        try:
            wait_until(worker_wait.exists)
            result = fixture.request(); assert_completed_http(result, False)
            def durable_receipt():
                state = fixture.census()
                return state if state["receipt_count"] == before["receipt_count"] + 1 else None
            held = wait_until(durable_receipt)
            assert_receipt_durable_worker_paused(before, held)
            fixture.save("ledger-paused-proof", {"external_EOF_complete": True, "before": before, "held": held,
                "remaining_H": 35, "original_M": 524480, "pause": "worker claim before SQL, not receipt"})
        finally: worker_hold.unlink(missing_ok=True)
        fixture.total += 1; fixture.drain("ledger-resumed", fixture.total)
        return
    first = fixture.request(); assert_completed_http(first, False)
    wait_until(waiting.exists)
    assert_receipt_not_written(before, fixture.census())
    if case == "queue-age":
        time.sleep(.2)  # Explicit test-only maxAge100ms, not a performance parameter.
        denied = fixture.request()
        assert denied["status"] == 503 and "FAST_RECEIPT_BACKPRESSURE" in denied["body"], denied
        held = fixture.census(); assert_receipt_not_written(before, held)
        assert fixture.metrics()["received"] - before_mock["received"] == 1
        fixture.save("age-preintent-denial-proof", {"response": denied, "before": before, "held": held,
            "max_age_ms": 100, "new_intent_for_denied_request": False, "new_upstream_for_denied_request": False})
        hold.unlink(); fixture.total += 1; fixture.drain("age-resumed", fixture.total)
        return
    assert case == "queue-full"
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        second = pool.submit(fixture.request)
        wait_until(lambda: fixture.metrics()["completed"] == before_mock["completed"] + 2)
        def both_receipts_held():
            file = fixture.out / "async-receipt-fault-events.json"
            if not file.exists(): return False
            events = json.loads(file.read_text())["events"]
            return sum(event["phase"] == "before_sql_hold" and event["kind"] == "receipt" for event in events) == 2
        wait_until(both_receipts_held)
        assert not second.done(), "full queue synchronous fallback must keep terminal gated"
        held = fixture.census(); assert_receipt_not_written(before, held, count=2)
        metrics = fixture.save_observers("queue-full-held")
        assert metrics["latest"]["pending"] == metrics["latest"]["undurable"] == 1
        assert metrics["latest"]["fallbacks"] == 1
        fixture.save("queue-full-proof", {"first_external_EOF_complete": True, "second_external_EOF_complete": False,
            "max_entries": 1, "workers": 1, "queued_pending": 1, "synchronous_fallbacks": 1,
            "before": before, "held": held})
    finally:
        hold.unlink(missing_ok=True); pool.shutdown(wait=True)
    assert_completed_http(second.result(timeout=10), False)
    fixture.total += 2; fixture.drain("queue-full-resumed", fixture.total)
    assert fixture.metrics()["received"] - before_mock["received"] == 2


def semantic_case(fixture, case, capture):
    before = fixture.metrics()
    if case == "byok":
        responses = [fixture.request(stream=stream) for stream in [False, True, False]]
        for result, stream in zip(responses, [False, True, False]): assert_completed_http(result, stream)
        def drained():
            state = fixture.census()
            return state if state["completed_jobs"] == 3 else None
        census = wait_until(drained, timeout=15)
        assert census["intent_count"] == census["receipt_success_count"] == census["completed_jobs"] == 3
        assert census["input_tokens"] == 30 and census["output_tokens"] == 15
        for key in ("wallet_posted_minor_units", "allocation_count", "receipt_charge_minor_units", "settlement_ledger_count",
                    "receipt_release_count", "legacy_requests", "legacy_attempts", "legacy_evidence", "legacy_usage_events", "unresolved_intents"):
            assert census[key] == 0, key
        bounds = json.loads(fixture.sql(fixture.db, "SELECT json_agg(t) FROM (SELECT currency,max_cost_minor_units,count(*) FROM model_router_saas.saas_fast_gateway_intents GROUP BY currency,max_cost_minor_units) t"))
        assert bounds == [{"currency": None, "max_cost_minor_units": 0, "count": 3}]
        metrics = fixture.save_observers("byok-final")
        assert metrics["latest"]["accepted"] == metrics["latest"]["durable"] == metrics["latest"]["completed"] == 3
        assert metrics["latest"]["undurableLiabilityByCurrency"] == {}
        counters = capture(fixture)
        for scope in ("tenant", "project", "key"):
            assert counters[scope]["reserved_requests"] == 3 and counters[scope]["reserved_token_units"] == 45
            assert counters[scope]["live_slots"] == 0
        fixture.save("byok-proof", {"responses": responses, "census": census, "persisted_bounds": bounds,
            "redis": counters, "unfunded_platform_wallet": True, "platform_customer_charge": 0})
    else:
        assert case == "strict-fallback"
        first = fixture.request(extra_headers={"Idempotency-Key": "async-receipt-strict-control"})
        assert first["status"] == 200 and first["mode"] == "strict" and first["fallback"] == "client_idempotency", first
        replay = fixture.request(extra_headers={"Idempotency-Key": "async-receipt-strict-control"})
        assert replay["status"] in (200, 202)
        assert fixture.metrics()["received"] - before["received"] == 1
        tools = fixture.request(body_patch={"tools": []})
        assert tools["status"] == 200 and tools["mode"] == "strict" and tools["fallback"] == "unbounded_request_field", tools
        # Mutate before the first eligible fast snapshot, not an immediate-revoke claim.
        fixture.sql(fixture.db, "UPDATE model_router_saas.saas_api_key_budget_policies SET token_daily=1000000")
        cap = fixture.request()
        assert cap["status"] == 200 and cap["mode"] == "strict" and cap["fallback"] == "snapshot_policy", cap
        def legacy_drained():
            value = json.loads(fixture.sql(fixture.db, "SELECT json_build_object('fast_intents',(SELECT count(*) FROM model_router_saas.saas_fast_gateway_intents),'legacy_requests',(SELECT count(*) FROM model_router_saas.saas_requests),'settled',(SELECT count(*) FROM model_router_saas.saas_requests WHERE execution_state='succeeded' AND financial_status='settled'),'ledger_count',(SELECT count(*) FROM model_router_saas.saas_ledger_transactions WHERE source_type='billing_settlement'),'charge',(SELECT COALESCE(sum(amount_minor_units),0) FROM model_router_saas.saas_ledger_transactions WHERE source_type='billing_settlement'),'wallet',(SELECT sum(posted_balance_minor_units) FROM model_router_saas.saas_wallets))"))
            return value if value["settled"] == 3 else None
        census = wait_until(legacy_drained, timeout=20)
        assert census == {"fast_intents": 0, "legacy_requests": 3, "settled": 3, "ledger_count": 3, "charge": 105, "wallet": 99999999895}
        fixture.save("strict-fallback-proof", {"responses": [first, replay, tools, cap], "census": census,
            "idempotent_replay_upstream_send": False, "fast_intents_before_fallback": 0,
            "finite_cap_scope": "configured before any eligible fast snapshot; not an immediate invalidation test"})
    assert fixture.metrics()["received"] - before["received"] == 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--window", type=Path, required=True)
    parser.add_argument("--case", choices=["kill-after-eof", "term-inflight", "queue-full", "queue-age", "receipt-ack-loss", "intent-ack-loss", "ledger-pause", "byok", "strict-fallback"], required=True)
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
    args.mode = "byok-smoke" if args.case == "byok" else "smoke"; args.replicates = 1

    class OwnedFixture(Evaluation):
        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = dict(env, PAIR_ASYNC_FAULTS="1", PAIR_ASYNC_METRICS="1")
                for key in list(env):
                    if key.startswith("MODEL_ROUTER_FAST_RECEIPT_"):
                        del env[key]
                env["MODEL_ROUTER_FAST_RECEIPT_MODE"] = "memory-queue"
                if args.case == "queue-full":
                    env.update(MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES="1", MODEL_ROUTER_FAST_RECEIPT_WORKERS="1", MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT="1")
                if args.case == "queue-age":
                    env["MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS"] = "100"
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
        fixture.start_services(); fixture.start_router(observer=False)
        if args.case in ("byok", "strict-fallback"):
            semantic_case(fixture, args.case, capture)
            fixture.save("result", {"passed": True, "not_performance_acceptance": True,
                "case": args.case, "publication_status": "LOCAL_UNPUBLISHED"})
            print("ASYNC_RECEIPT_SEMANTICS_PASS", args.case, flush=True)
            return
        fixture.warm(1)
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
        elif args.case == "term-inflight":
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
        else:
            pressure_case(fixture, args.case, before, before_mock, hold, waiting)
            fixture.save_observers("final")
        fixture.save("result", {"passed": True, "not_performance_acceptance": True,
            "case": args.case, "publication_status": "LOCAL_UNPUBLISHED", "expected_sigkill_pid": expected_killed_pid})
        print("ASYNC_RECEIPT_LIFECYCLE_PASS", args.case, flush=True)
    finally:
        if hold is not None: hold.unlink(missing_ok=True)
        fixture.cleanup()


if __name__ == "__main__": main()
