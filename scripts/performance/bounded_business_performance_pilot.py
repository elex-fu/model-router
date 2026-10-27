"""Diagnostic one-versus-two business processes with fixed aggregate budgets.

Requires an explicit root-approved quiet generation. One invocation runs one
fresh-fixture arm. Repeat/reverse invocations externally; no one-pair gain claim.
No queue observer, profiler, periodic SQL sampler, restart, or liability expiry.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import threading
import time

from async_receipt_performance_pilot import (
    capture_lease_reconciliation, distribution, receipt_append_calls,
    unavailable_queue_telemetry, verify_lease_reconciliation, verify_tpm_reconciled,
)
from bounded_business_launcher_adapter import adapt

from bounded_business_profiles import (
    MAXIMUM, PROFILE_NAMES, SERIAL_PROFILES, aggregate_budgets, expected_budgets, get_profile, profile_stream, scene_parameters,
)

# Backward-compatible default-profile exports; every execution uses its explicit
# selected profile, never these aliases for c200 accounting.
TOTAL_BUDGETS = aggregate_budgets()
TOTAL_CREDIT_TARGET = TOTAL_BUDGETS["automaticCreditTarget"]
# One exact registry is shared with the Node probe/supervisor. The legacy alias
# remains available to historical pure fixtures; observed metadata is never replaced.
CAPACITY_COMPILED_PINS = json.loads(Path(__file__).with_name("bounded-business-capacity-pins.json").read_text())
CAPACITY_ALLOWED_COMPILED_SHA256 = frozenset(CAPACITY_COMPILED_PINS.values())
CAPACITY_COMPILED_SHA256 = CAPACITY_COMPILED_PINS["legacy"]

# All allocations, including retired epochs, are included. Nothing here mutates
# financial authority, creates jobs, repairs state, or waits for TTL expiry.
OWNER_CENSUS_SQL = """
SELECT jsonb_build_object(
 'observed_at',clock_timestamp(),
 'owners',(SELECT COALESCE(jsonb_agg(jsonb_build_object('owner',owner,'epoch',epoch) ORDER BY owner),'[]'::jsonb)
           FROM model_router_saas.saas_fast_gateway_owners),
 'maxima',(SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]'::jsonb) FROM
           (SELECT max_cost_minor_units::text AS maximum,count(*) AS intents
            FROM model_router_saas.saas_fast_gateway_intents GROUP BY max_cost_minor_units) m),
 'allocations',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'owner',a.owner,'epoch',a.epoch,'currency',a.currency,'state',a.state,'stripe',a.stripe,
   'backing',a.backing_minor_units::text,'available',a.available_minor_units::text,
   'intents',(SELECT count(*) FROM model_router_saas.saas_fast_gateway_intents i WHERE i.allocation_id=a.id),
   'completed',(SELECT count(*) FROM model_router_saas.saas_fast_gateway_intents i
       JOIN model_router_saas.saas_fast_billing_jobs j ON j.intent_id=i.id
       WHERE i.allocation_id=a.id AND j.state='completed'),
   'settled_charge',(SELECT COALESCE(sum(r.charge_minor_units),0)::text
       FROM model_router_saas.saas_fast_gateway_intents i
       JOIN model_router_saas.saas_fast_billing_jobs j ON j.intent_id=i.id
       JOIN model_router_saas.saas_fast_gateway_receipts r ON r.intent_id=i.id
       WHERE i.allocation_id=a.id AND j.state='completed')) ORDER BY a.owner,a.epoch,a.stripe),'[]'::jsonb)
   FROM model_router_saas.saas_fast_credit_allocations a),
 'all_backing',(SELECT COALESCE(sum(backing_minor_units),0)::text FROM model_router_saas.saas_fast_credit_allocations),
 'all_available',(SELECT COALESCE(sum(available_minor_units),0)::text FROM model_router_saas.saas_fast_credit_allocations))
"""


def verify_bootstrap(state, proofs, workers, profile="c32", *, capacity_diagnostic=False):
    budgets = expected_budgets(workers, profile)
    assert state.get("capacityDiagnostic", False) is capacity_diagnostic
    assert state["profile"] == profile, "BOUNDED_BUSINESS_STATE_PROFILE_MISMATCH"
    assert state["businessWorkersStarted"] == workers and state["restartEnabled"] is False
    assert state["phase"] == "ready"
    assert len(state["workers"]) == len(proofs) == workers
    pids = [item["pid"] for item in state["workers"]]
    owners = [item["owner"] for item in state["workers"]]
    assert len(set(pids)) == len(set(owners)) == workers
    assert state["primaryPid"] not in pids
    assert {item["slot"] for item in state["workers"]} == set(range(workers))
    expected_pools = sorted([budgets["databasePoolMax"] - 2, 2])
    for item, proof in zip(state["workers"], proofs):
        assert item["ready"] is True
        assert item.get("exitCode") is None and item.get("signal") is None
        assert not item.get("forcedKill", False)
        assert proof["pid"] == item["pid"] and proof["owner"] == item["owner"]
        assert proof["slot"] == item["slot"]
        assert proof["profile"] == profile, "BOUNDED_BUSINESS_PROOF_PROFILE_MISMATCH"
        assert proof["readyStatus"] == 200 and proof["readinessListenerClosed"] is True
        assert proof["poolObserverRemoved"] is True and proof["nativePoolPrototypes"] is True
        assert proof["nativeFastPrototypes"] is True
        assert proof["startupObserversRemoved"] is True
        assert proof["inferenceHooksInstalled"] is capacity_diagnostic
        assert bool(proof.get("capacityDiagnostic", {}).get("enabled", False)) is capacity_diagnostic
        if capacity_diagnostic:
            assert proof["capacityDiagnostic"]["compiledSha256"] in CAPACITY_ALLOWED_COMPILED_SHA256
        for key, expected in budgets.items():
            assert proof["budgets"][key] == expected, (key, proof["budgets"], budgets)
        assert sorted(pool["max"] for pool in proof["pools"]) == expected_pools
        assert proof["executorLocalCaps"] == proof["compositionHttpCaps"] == [budgets["httpInFlight"]]
        assert proof["receiptQueues"] == [{"maxEntries": budgets["receiptEntries"], "maxBytes": budgets["receiptBytes"],
                                          "maxPerTenant": budgets["receiptPerTenant"], "workers": budgets["receiptWorkers"],
                                          "maxAgeMs": 5000, "drainTimeoutMs": 10000}]
    return {"verified": True, "business_workers": workers, "pids": pids, "owners": owners,
            "profile": profile, "per_child": budgets, "aggregate": aggregate_budgets(profile),
            "actual_pool_maxima": [pool["max"] for proof in proofs for pool in proof["pools"]],
            "proof_scope": "Each child: native Pool.options.max at construction, real private /readyz=200, readiness listener closed before warm."}


def verify_owner_bounds(census, owners, workers, *, epochs=None, require_work=True, postshutdown=False, profile="c32"):
    totals = aggregate_budgets(profile)
    target = totals["automaticCreditTarget"]
    stripes = totals["creditStripes"]
    assert len(owners) == workers and len(set(owners)) == workers
    records = census["owners"]
    assert len(records) == workers and {row["owner"] for row in records} == set(owners), "BOUNDED_BUSINESS_UNEXPECTED_OWNER"
    current_epochs = {row["owner"]: row["epoch"] for row in records}
    if epochs is not None:
        assert current_epochs == epochs, "BOUNDED_BUSINESS_OWNER_EPOCH_CHANGED"
    result = {owner: {"backing": 0, "available": 0, "intents": 0, "completed": 0, "settled_charge": 0,
                      "active_stripes": 0, "retired_stripes": 0} for owner in owners}
    seen = set()
    for row in census["allocations"]:
        assert row["owner"] in result and row["epoch"] == current_epochs[row["owner"]], "BOUNDED_BUSINESS_OLD_OR_FOREIGN_ALLOCATION"
        assert row["currency"] == "USD"
        assert row["state"] in ("active", "retired")
        if not postshutdown:
            assert row["state"] == "active", "BOUNDED_BUSINESS_UNEXPECTED_RETIREMENT"
        assert isinstance(row["stripe"], int) and 0 <= row["stripe"] < stripes // workers
        identity = (row["owner"], row["epoch"], row["stripe"])
        assert identity not in seen
        seen.add(identity)
        backing, available = int(row["backing"]), int(row["available"])
        assert 0 <= available <= backing
        group = result[row["owner"]]
        group["backing"] += backing
        group["available"] += available
        group["intents"] += row["intents"]
        group["completed"] += row["completed"]
        group["settled_charge"] += int(row["settled_charge"])
        group[row["state"] + "_stripes"] += 1
    assert sum(row["backing"] for row in result.values()) == int(census["all_backing"])
    assert sum(row["available"] for row in result.values()) == int(census["all_available"])
    assert int(census["all_backing"]) <= target, "BOUNDED_BUSINESS_TOTAL_BACKING_EXCEEDED"
    for row in result.values():
        assert row["backing"] <= target // workers
        assert row["settled_charge"] == row["completed"] * 35, "BOUNDED_BUSINESS_PER_OWNER_CHARGE_MISMATCH"
        if require_work:
            assert row["completed"] > 0, "BOUNDED_BUSINESS_WORKER_TRAFFIC_UNPROVEN"
            assert row["active_stripes"] + row["retired_stripes"] == stripes // workers
            if not postshutdown:
                assert row["backing"] + row["settled_charge"] >= target // workers, "BOUNDED_BUSINESS_COLD_TARGET_UNPROVEN"
        if postshutdown:
            assert row["backing"] == row["available"] == row["active_stripes"] == 0
    if require_work:
        assert len(census["maxima"]) == 1 and int(census["maxima"][0]["maximum"]) == MAXIMUM
        assert census["maxima"][0]["intents"] == sum(row["intents"] for row in result.values())
    return {"verified": True, "profile": profile, "epochs": current_epochs, "by_owner": result,
            "all_active_and_retired_backing": int(census["all_backing"]),
            "expected_initial_target_per_owner": target // workers,
            "cold_target_floor_required": require_work and not postshutdown,
            "target_interval": "Before retirement: target - own completed charges <= backing <= target. Warm fixed35-fee proof establishes cold target; later refill can replace spent credit, never increase the target.",
            "scope": "Read-only boundary census of all allocations, not a sampled peak. Fresh fixed-M fixture, unchanged owners/epochs and no respawn are required; restart does not have a lifetime aggregate T guarantee."}


def resource_delta(before, after, successes):
    assert before["pid"] == after["pid"]
    valid = (before.get("available") and after.get("available") and
             before["start_ticks"] == after["start_ticks"] and
             before["ticks_per_second"] == after["ticks_per_second"])
    result = {"before": before, "after": after, "valid": bool(valid)}
    if valid:
        ticks = after["user_ticks"] + after["system_ticks"] - before["user_ticks"] - before["system_ticks"]
        assert ticks >= 0
        duration = (after["monotonic_ns"] - before["monotonic_ns"]) / 1e9
        assert duration > 0
        cpu_ms = ticks * 1000 / after["ticks_per_second"]
        result.update(cpu_total_ms=cpu_ms, resource_span_s=duration,
                      average_process_cpu_cores=cpu_ms / (duration * 1000),
                      cpu_ms_per_success=cpu_ms / successes if successes else None)
    return result


def aggregate_resources(before, after, primary_pid, business_pids, successes):
    assert set(before) == set(after) == set([primary_pid, *business_pids])
    rows = {pid: resource_delta(before[pid], after[pid], successes) for pid in before}
    valid = all(row["valid"] for row in rows.values())
    result = {"valid": valid, "primary": rows[primary_pid],
              "business": [rows[pid] for pid in business_pids],
              "scope": "Boundary CPU across every business process plus RR primary, through financial+TPM drain. Includes all threads; excludes launcher, PostgreSQL, Redis, mock and client. RSS sums include shared pages, not private memory or peaks."}
    if valid:
        business_cpu = sum(rows[pid]["cpu_total_ms"] for pid in business_pids)
        result.update(business_cpu_ms=business_cpu,
                      primary_cpu_ms=rows[primary_pid]["cpu_total_ms"],
                      combined_cpu_ms=business_cpu + rows[primary_pid]["cpu_total_ms"],
                      business_cpu_ms_per_success=business_cpu / successes if successes else None,
                      business_rss_before_bytes=sum(before[pid]["resident_bytes"] for pid in business_pids),
                      business_rss_after_bytes=sum(after[pid]["resident_bytes"] for pid in business_pids))
    return result


def verify_cluster_cleanup(state, bootstrap, outer):
    assert outer["allExited"] and outer["allGraceful"], "BOUNDED_BUSINESS_PRIMARY_CLEAN_EXIT_REQUIRED"
    assert state["profile"] == bootstrap["profile"]
    assert state["primaryPid"] == bootstrap["primaryPid"]
    assert state["businessWorkersStarted"] == bootstrap["businessWorkersStarted"]
    assert state["restartEnabled"] is False
    assert state["phase"] == "exited" and state["allGraceful"] is True
    assert len(state["workers"]) == len(bootstrap["workers"])
    original = {row["slot"]: row for row in bootstrap["workers"]}
    for row in state["workers"]:
        first = original[row["slot"]]
        assert row["pid"] == first["pid"] and row["owner"] == first["owner"]
        assert row["exitCode"] == 0 and row["signal"] is None and not row["forcedKill"]
    return {"verified": True, "state": state, "outer_launcher_cleanup": outer,
            "scope": "Both business children and primary exited normally with no restart or forced kill; native application lifecycle owns receipt and ledger drain."}


def router_environment(env, workers, profile="c32", *, capacity_diagnostic=False):
    budgets = expected_budgets(workers, profile)
    result = dict(env)
    for key in list(result):
        if key.startswith("MODEL_ROUTER_FAST_RECEIPT_") or key.startswith("BOUNDED_CLUSTER_"):
            del result[key]
    assert not result.get("PAIR_GATEWAY_NODE_OPTIONS") and not result.get("NODE_OPTIONS")
    result.update(PAIR_INSTANCES="1", PAIR_ASYNC_FAULTS="0", PAIR_ASYNC_METRICS="0",
                  PAIR_ASYNC_CPU_PROFILE="0", MODEL_ROUTER_FAST_RECEIPT_MODE="memory-queue",
                  BOUNDED_CLUSTER_WORKERS=str(workers), BOUNDED_CLUSTER_PROFILE=profile,
                  PAIR_CONCURRENCY_CAP=str(budgets["httpInFlight"] * workers))
    if capacity_diagnostic:
        assert profile == "c200" and workers == 2
        result["BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC"] = "1"
    return result


def verify_pending_term_observation(before, held, owner_before, owner_held, expected, bootstrap, stopping, profile="c32"):
    """Completed clients are backed by durable intents, not yet by receipts."""
    assert expected > 0
    assert held["intent_count"] - before["intent_count"] == expected
    assert held["receipt_count"] == before["receipt_count"]
    assert held["completed_jobs"] == before["completed_jobs"]
    assert int(held["allocation_backing_minor_units"]) <= aggregate_budgets(profile)["automaticCreditTarget"]
    assert stopping["profile"] == bootstrap["profile"] == profile
    deltas = {owner: owner_held[owner]["intents"] - row["intents"] for owner, row in owner_before.items()}
    assert sum(deltas.values()) == expected and all(delta > 0 for delta in deltas.values())
    assert stopping["phase"] == "stopping" and stopping["businessWorkersStarted"] == bootstrap["businessWorkersStarted"]
    assert stopping["restartEnabled"] is False
    for original, current in zip(bootstrap["workers"], stopping["workers"]):
        assert current["pid"] == original["pid"] and current["owner"] == original["owner"]
        assert current["exitCode"] is None and current["signal"] is None and not current["forcedKill"]
    return {"verified": True, "pending_intents_by_owner": deltas, "pending_successful_clients": expected,
            "scope": "Actual successful clients, durable intents on both owners, receipts held by one admin table lock, and both original processes alive after TERM. No synthetic receipt or liability release."}


def verify_queue_snapshots(values, bootstrap, workers, *, empty=False, pending_by_owner=None, profile="c32"):
    budgets = expected_budgets(workers, profile)
    assert bootstrap["profile"] == profile
    assert len(values) == len(bootstrap["workers"]) == workers
    for value, child in zip(values, bootstrap["workers"]):
        assert value["pid"] == child["pid"] and value["slot"] == child["slot"]
        snapshot = value["snapshot"]
        assert 0 <= snapshot["undurable"] <= snapshot["pending"] <= budgets["receiptEntries"]
        assert 0 <= snapshot["bytes"] <= budgets["receiptBytes"]
        assert 0 <= snapshot["receiptRunning"] <= budgets["receiptWorkers"]
        assert 0 <= snapshot["reconciliationRunning"] <= budgets["reconciliationWorkers"]
        assert snapshot["running"] == snapshot["receiptRunning"] + snapshot["reconciliationRunning"]
        if empty:
            assert snapshot["pending"] == snapshot["undurable"] == snapshot["running"] == snapshot["bytes"] == 0
        if pending_by_owner is not None:
            count = pending_by_owner[child["owner"]]
            assert count > 0
            assert snapshot["pending"] == snapshot["undurable"] == count
            assert snapshot["undurableLiabilityByCurrency"] == {"USD": str(MAXIMUM * count)}
    return {"verified": True, "empty": empty,
            "pending_by_owner_proven": pending_by_owner,
            "scope": "Explicit native queue snapshots outside performance timing, not per-event telemetry or a sampled peak; no phase histogram claims.",
            "values": values}


def verify_sse_qualification(raw, count):
    assert raw["stream"] is True and raw["requests"] == raw["success"] == count
    assert raw["status_counts"] == {"200": count}
    assert raw["execution_modes"].get("fast-reserved-max", 0) == count and not raw["fallback_reasons"]
    assert len(raw["samples"]) == count
    for sample in raw["samples"]:
        assert sample["Status"] == 200 and sample["Err"] == "" and sample["Bytes"] > 0
        assert sample["Mode"] == "fast-reserved-max" and sample["Fallback"] == ""
    return {"verified": True, "requests": count,
            "scope": "Unchanged native client reads complete body and requires data: [DONE] in SSE mode; every retained sample is200, complete, nonempty and fast-reserved-max. Exact35 fee and15-token reconciliation are separately checked in financial/TPM census."}


def profile_client(fixture, profile, name, count, concurrency, duration=0):
    """Use the same native protocol flag for the 128 warm requests and main scene."""
    return fixture.client(name, count, concurrency, duration=duration, stream=profile_stream(profile))


def verify_main_client(raw, profile, scene):
    plan = scene_parameters(profile, scene)
    if profile in SERIAL_PROFILES:
        assert raw["stream"] is profile_stream(profile), "BOUNDED_BUSINESS_SERIAL_PROTOCOL_REQUIRED"
    assert raw["concurrency"] == plan["concurrency"]
    assert raw["requests"] == len(raw["samples"]), "BOUNDED_BUSINESS_ALL_ATTEMPTS_REQUIRED"
    if plan["duration"] == 0:
        assert raw["requests"] == plan["count"], "BOUNDED_BUSINESS_FINITE_REQUEST_COUNT_REQUIRED"
    assert raw["requests"] > 0
    return {"verified": True, "plan": plan, "retained_attempts": len(raw["samples"]),
            "scope": "All native client attempts retained, including errors and finite-run tails; no warm, status, duration or outlier filtering."}


def verify_client_outcomes(raw, *, capacity_diagnostic=False):
    """Only the native pre-auth capacity code may continue diagnostic collection."""
    successes = rejections = 0
    for sample in raw["samples"]:
        if sample["Status"] == 200:
            assert sample["Err"] == "" and sample["Bytes"] > 0
            assert sample["Mode"] == "fast-reserved-max" and sample["Fallback"] == ""
            successes += 1
        else:
            assert capacity_diagnostic, "BOUNDED_BUSINESS_ZERO_ERROR_GATE"
            assert sample["Status"] == 429 and sample["Mode"] == sample["Fallback"] == ""
            payload = json.loads(sample["Err"])
            assert set(payload) == {"error"} and set(payload["error"]) == {"code", "message", "requestId"}
            error = payload["error"]
            assert error["code"] == "GATEWAY_CAPACITY_EXHAUSTED"
            assert error["message"] == "The request could not be completed"
            assert isinstance(error["requestId"], str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", error["requestId"])
            assert sample["Bytes"] > 0
            rejections += 1
    assert successes == raw["success"] and successes + rejections == raw["requests"]
    assert raw["status_counts"] == {**({"200": successes} if successes else {}), **({"429": rejections} if rejections else {})}
    return {"verified": True, "successes": successes, "capacity_rejections": rejections,
            "zero_error_gate_passed": rejections == 0, "performance_acceptance": not capacity_diagnostic and rejections == 0}


def experiment_passed(raw, *, capacity_diagnostic=False):
    # An instrumented diagnostic is never promoted to a passing experiment.
    return not capacity_diagnostic and raw["success"] == raw["requests"]


def verify_capacity_snapshots(values, bootstrap):
    assert len(values) == len(bootstrap["workers"])
    for value, worker in zip(values, bootstrap["workers"]):
        assert value["pid"] == worker["pid"] and value["slot"] == worker["slot"]
        probe = value["capacityDiagnostic"]
        assert probe["enabled"] is True and probe["pid"] == worker["pid"]
        assert probe["limit"] == 128 and 0 <= probe["current"] <= probe["peak"] <= 128
        assert len(probe["samples"]) <= 128 and probe["violations"] == 0
        assert probe["accepted"] - probe["settled"] == probe["current"]
        assert probe["rejected"] == len(probe["samples"]) + probe["dropped"]
        assert probe["compiledSha256"] in CAPACITY_ALLOWED_COMPILED_SHA256
    return {"verified": True, "workers": values,
            "scope": "Bounded native rejection snapshots; boundary observations are not simultaneous cross-worker occupancy proof."}


def verify_mock_counts(before, after, expected, *, fresh=False):
    """Counter evidence, not an inferred per-request deduplication identity."""
    assert type(expected) is int and expected >= 0
    for name in ("received", "completed"):
        assert type(before[name]) is int and type(after[name]) is int
        assert 0 <= before[name] <= after[name]
        if fresh:
            assert before[name] == 0, "BOUNDED_BUSINESS_MOCK_NOT_FRESH"
        assert after[name] - before[name] == expected, "BOUNDED_BUSINESS_MOCK_COUNT_MISMATCH"
    return {"verified": True, "before": before, "after": after, "expected_requests": expected,
            "received_delta": after["received"] - before["received"],
            "completed_delta": after["completed"] - before["completed"], "fresh_fixture": fresh,
            "scope": "Actual mock received/completed counter deltas; whole-fixture proof starts at zero before gateway startup and ends after real shutdown. Counters alone are not per-request identity evidence."}


def cleanup_owned_cluster(discover, snapshot, send_signal, *, monotonic=time.monotonic, sleep=time.sleep,
                          grace_seconds=46, kill_wait_seconds=5):
    """Close only recorded PID/start identities, while PG/Redis still exist.

    A primary TERM owns propagation. Do not double-TERM its children while their
    native handlers drain. If no primary remains, TERM each verified orphan.
    Re-read state to include a child forked just before the primary stops.
    """
    known, actions, errors = {}, [], []

    def current():
        for item in discover():
            assert isinstance(item["pid"], int) and item["pid"] > 1
            assert str(item["start_ticks"]).isdigit(), "BOUNDED_BUSINESS_PROCESS_IDENTITY_REQUIRED"
            previous = known.get(item["pid"])
            assert previous is None or str(previous["start_ticks"]) == str(item["start_ticks"])
            known[item["pid"]] = item
        live = []
        for item in known.values():
            observed = snapshot(item["pid"])
            if (observed.get("available") and observed.get("state") != "Z" and
                    str(observed.get("start_ticks")) == str(item["start_ticks"])):
                assert all(argument in observed.get("argv", ()) for argument in item.get("expected_argv", ())), "BOUNDED_BUSINESS_PROCESS_COMMAND_MISMATCH"
                live.append(item)
        return live

    def signal_owned(item, sig):
        if not any(row["pid"] == item["pid"] for row in current()):
            return False
        try:
            send_signal(item["pid"], sig)
            actions.append({"pid": item["pid"], "start_ticks": str(item["start_ticks"]), "signal": sig.name})
            return True
        except ProcessLookupError:
            return False
        except OSError as error:
            errors.append({"pid": item["pid"], "category": type(error).__name__})
            return False

    live = current()
    if not live:
        return {"all_exited": True, "abnormal_cleanup": False, "actions": [], "errors": [], "survivors": []}
    primaries = [item for item in live if item["role"] == "primary"]
    assert len(primaries) <= 1
    propagated = bool(primaries and signal_owned(primaries[0], signal.SIGTERM))
    if not propagated:
        for item in live:
            if item["role"] == "business":
                signal_owned(item, signal.SIGTERM)
    deadline = monotonic() + grace_seconds
    while current() and monotonic() < deadline:
        sleep(.05)
    for item in current():
        signal_owned(item, signal.SIGKILL)
    deadline = monotonic() + kill_wait_seconds
    while current() and monotonic() < deadline:
        sleep(.05)
    survivors = [{key: item[key] for key in ("pid", "start_ticks", "role")} for item in current()]
    return {"all_exited": not survivors, "abnormal_cleanup": True, "actions": actions, "errors": errors,
            "survivors": survivors, "graceful_validation": False,
            "scope": "Failure cleanup only, using original PID/start/argv identities before dependency shutdown. Successful cleanup is not a graceful experiment pass."}


def finalize_run(result, cleanup, release, save):
    """Never leave a passing result ahead of failed cleanup/window release."""
    try:
        cleanup()
        release()
        save(result)
    except BaseException as error:
        try:
            save({"passed": False, "error_category": type(error).__name__, "stage": "cleanup_or_release"})
        except Exception:
            pass
        raise


def process_group_members(pgid):
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if int(fields[2]) == pgid:
            members.append({"pid": int(entry.name), "pgid": int(fields[2]), "sid": int(fields[3]),
                            "state": fields[0], "start_ticks": fields[19]})
    return members


def cleanup_owned_group(group, members, send_group_signal, *, monotonic=time.monotonic, sleep=time.sleep,
                        grace_seconds=46, kill_wait_seconds=5):
    """Abnormal fallback only: a dedicated outer-launcher session, never shared PGID."""
    if group is None or group.get("closed"):
        return {"all_exited": True, "abnormal_cleanup": False, "actions": [], "survivors": []}
    assert group["pgid"] == group["sid"] == group["leader_pid"] > 1
    assert str(group["leader_start_ticks"]).isdigit()

    def live():
        rows = members(group["pgid"])
        for row in rows:
            assert row["pgid"] == group["pgid"] and row["sid"] == group["sid"]
            assert int(row["start_ticks"]) >= int(group["leader_start_ticks"])
            if row["pid"] == group["leader_pid"]:
                assert str(row["start_ticks"]) == str(group["leader_start_ticks"]), "BOUNDED_BUSINESS_GROUP_LEADER_REUSED"
        return [row for row in rows if row["state"] != "Z"]

    actions = []
    rows = live()
    if not rows:
        group["closed"] = True
        return {"all_exited": True, "abnormal_cleanup": False, "actions": [], "survivors": []}
    for sig, budget in ((signal.SIGTERM, grace_seconds), (signal.SIGKILL, kill_wait_seconds)):
        if not live():
            break
        try:
            send_group_signal(group["pgid"], sig)
            actions.append({"pgid": group["pgid"], "signal": sig.name})
        except ProcessLookupError:
            pass
        deadline = monotonic() + budget
        while live() and monotonic() < deadline:
            sleep(.05)
    survivors = live()
    if not survivors:
        group["closed"] = True
    return {"all_exited": not survivors, "abnormal_cleanup": True, "graceful_validation": False,
            "actions": actions, "survivors": survivors,
            "scope": "Fallback after outer shutdown and recorded-PID cleanup, for its dedicated start_new_session process group. Any group TERM/KILL is abnormal and can never validate graceful financial drain."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--client", type=Path, required=True)
    parser.add_argument("--profile", choices=PROFILE_NAMES, default="c32")
    parser.add_argument("--workers", type=int, choices=(1, 2), required=True)
    parser.add_argument("--scene", choices=("qualification", "timed"), required=True)
    parser.add_argument("--capacity-diagnostic", action="store_true", help="Opt-in bounded HTTP-cap rejection probe; never a performance comparison")
    parser.add_argument("--pending-term", action="store_true",
                        help="Untimed qualification only: prove native queue drain while receipt INSERT is temporarily locked")
    args = parser.parse_args()
    if args.profile in SERIAL_PROFILES and (args.workers != 1 or args.scene != "timed"):
        parser.error("serial profiles require --workers 1 --scene timed; they are diagnostics, not a new acceptance gate")
    selected = get_profile(args.profile)
    totals = aggregate_budgets(args.profile)
    scene = scene_parameters(args.profile, args.scene)
    if not args.execute:
        parser.error("--execute requires root quiet-window GO")
    if args.pending_term and args.scene != "qualification":
        parser.error("--pending-term is forbidden in timed performance scenes")
    if args.capacity_diagnostic and (args.profile, args.workers, args.scene) != ("c200", 2, "timed"):
        parser.error("--capacity-diagnostic requires --profile c200 --workers 2 --scene timed")
    assert args.label.startswith("bounded-business-pilot-"), "BOUNDED_BUSINESS_UNIQUE_LABEL_REQUIRED"
    assert subprocess.check_output(["git", "-C", args.source, "rev-parse", "HEAD"], text=True).strip() == args.expected_source
    here = Path(__file__).resolve().parent
    assert not any((args.harness.parent / "results").glob(args.label + "-*")), "BOUNDED_BUSINESS_REFUSE_ARTIFACT_OVERWRITE"
    generated = args.harness / ("router-launch-" + args.label + ".mjs")
    assert not generated.exists(), "BOUNDED_BUSINESS_REFUSE_LAUNCHER_OVERWRITE"
    generated.write_text(adapt((args.harness / "router-launch.mjs").read_text(),
                               base_directory=args.harness, observer_directory=here, profile=args.profile, capacity_diagnostic=args.capacity_diagnostic))
    subprocess.run(["node", "--check", str(generated)], check=True)
    sys.path.insert(0, str(args.harness.resolve()))
    from evaluate import Evaluation, A, PG, ROUTERPORT
    from evaluate_formal import process_snapshot
    from paired_scenes import app_stats
    from quiet_window import capture, wait_active
    from release_quiet import release
    from redis_counter_capture import capture as capture_redis
    os.environ.update(PAIR_CONCURRENCY_CAP=str(selected["httpInFlight"]), PAIR_PREPARED="off", PAIR_CONNECTION_REUSE="auto",
                      PAIR_BUILTIN_ESTIMATOR="1", PAIR_TRANCHE_MINOR_UNITS="auto", PAIR_EXPECT_COLD_SUCCESS="1",
                      PAIR_SEED_HEALTH="0", PAIR_MOCK_DELAY_MS="5", PAIR_WARM_PROTOCOL="matched-v2",
                      PAIR_WINDOW_GENERATION=str(args.generation), PAIR_QUIET_WINDOW_CONFIRMED="1")
    args.mode = "smoke"
    args.replicates = 1

    class Pilot(Evaluation):
        gateway_term_sent = False
        owned_launcher_group = None

        def spawn(self, name, command, env=None):
            if name == "router-launch":
                command = ["node", generated]
                env = router_environment(env, args.workers, args.profile, capacity_diagnostic=args.capacity_diagnostic)
                log = (A / "logs" / f"{self.label}-{name}.log").open("w")
                self.logs.append(log)
                process = subprocess.Popen([str(value) for value in command], env=env,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                self.children.append(process)
                self.gateway = process
                identity = process_snapshot(process.pid)
                assert identity.get("available"), "BOUNDED_BUSINESS_OUTER_START_IDENTITY_REQUIRED"
                assert os.getpgid(process.pid) == os.getsid(process.pid) == process.pid
                self.owned_launcher_group = {"leader_pid": process.pid, "leader_start_ticks": identity["start_ticks"],
                                             "pgid": process.pid, "sid": process.pid, "closed": False}
                self.save("outer-process-group", self.owned_launcher_group)
                return process
            return super().spawn(name, command, env)

        def stop(self, process):
            if process and process.poll() is None:
                if process is not self.gateway or not self.gateway_term_sent:
                    process.terminate()
                    if process is self.gateway:
                        self.gateway_term_sent = True
                try:
                    process.wait(timeout=75)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        def owner_census(self, name, **kwargs):
            value = json.loads(self.sql(self.db, OWNER_CENSUS_SQL))
            proof = verify_owner_bounds(value, self.owners, args.workers, profile=args.profile, **kwargs)
            return self.save(name + "-owner-census", {"census": value, "proof": proof})

        def tpm_drain(self, name):
            # One post-finance read, not a loop that can pass by expiring a leak.
            counters = capture_redis(self)
            leases = capture_lease_reconciliation(self)
            try:
                proof = verify_tpm_reconciled(counters, self.total, leases["observed_at_redis_ms"])
                proof["lease_reconciliation"] = verify_lease_reconciliation(leases, self.total)
                if args.scene == "qualification":
                    assert leases["records"] == leases["settled_actual"] == self.total and leases["expired_pending"] == 0
                    proof["qualification_exact_leases"] = {"verified": True, "records": leases["records"],
                                                          "settled_actual": leases["settled_actual"], "expired_pending": 0,
                                                          "scope": "Fresh short qualification only, all successful leases observed actually settled; no expiry-as-completion allowance."}
            except AssertionError:
                self.save(name + "-tpm-drain", {"verified": False, "counters": counters, "leases": leases})
                raise
            return self.save(name + "-tpm-drain", proof)

        def queue_snapshots(self, bootstrap, state_file, timeout=2):
            previous = json.loads(state_file.read_text()).get("snapshotSequence", 0)
            sequence = previous + 1
            os.kill(bootstrap["primaryPid"], signal.SIGHUP)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                values = []
                for row in bootstrap["workers"]:
                    try:
                        value = json.loads(Path(row["queueSnapshotFile"]).read_text())
                        if value["sequence"] == sequence:
                            values.append(value)
                    except (OSError, ValueError, KeyError):
                        pass
                if len(values) == len(bootstrap["workers"]):
                    return values
                time.sleep(.01)
            raise TimeoutError("BOUNDED_BUSINESS_QUEUE_SNAPSHOT_TIMEOUT")

        def qualification_queue_empty(self, name, bootstrap, state_file):
            deadline = time.monotonic() + 5
            while True:
                values = self.queue_snapshots(bootstrap, state_file)
                verify_queue_snapshots(values, bootstrap, args.workers, profile=args.profile)
                if all(value["snapshot"]["pending"] == 0 for value in values):
                    return self.save(name + "-queue-empty", verify_queue_snapshots(values, bootstrap, args.workers, empty=True, profile=args.profile))
                if time.monotonic() >= deadline:
                    raise TimeoutError("BOUNDED_BUSINESS_QUALIFICATION_QUEUE_NOT_EMPTY")
                time.sleep(.01)

        def client(self, name, count, concurrency, duration=0, timeout=None, stream=False):
            command = [args.client, "-url", f"http://127.0.0.1:{ROUTERPORT}/v1/chat/completions",
                       "-key-file", self.out / "proxy-key", "-n", str(count), "-c", str(concurrency),
                       "-out", A / "results" / f"{self.label}-{name}.json"]
            if duration:
                command += ["-duration", f"{duration}s"]
            if stream:
                command.append("-stream")
            with (A / "logs" / f"{self.label}-{name}-client.log").open("w") as log:
                self.run(command, stdout=log, **({} if timeout is None else {"timeout": timeout}))
            return json.loads((A / "results" / f"{self.label}-{name}.json").read_text())

        def pending_term(self, name, bootstrap, epochs, state_file):
            before = self.census()
            owner_before = self.owner_census(name + "-before", epochs=epochs)["proof"]["by_owner"]
            mock_before = self.metrics()
            self.save(name + "-mock-before", mock_before)
            log = (A / "logs" / f"{self.label}-{name}-receipt-lock.log").open("w")
            self.logs.append(log)
            lock = subprocess.Popen([str(PG / "psql"), "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", self.db],
                                    env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=log, text=True, bufsize=1)
            self.children.append(lock)
            started = time.monotonic()
            stopping = None
            try:
                # Automatic rollback is a fail-safe, not successful drain proof.
                # Keep the hold safely shorter than the unchanged10s receipt deadline.
                lock.stdin.write("BEGIN; SET LOCAL lock_timeout='1000ms'; "
                                 "SET LOCAL idle_in_transaction_session_timeout='8000ms'; "
                                 "LOCK TABLE model_router_saas.saas_fast_gateway_receipts IN SHARE MODE;\n"
                                 "\\echo BOUNDED_RECEIPT_LOCK_HELD\n")
                lock.stdin.flush()
                with selectors.DefaultSelector() as selector:
                    selector.register(lock.stdout, selectors.EVENT_READ)
                    assert selector.select(timeout=2), "BOUNDED_BUSINESS_RECEIPT_LOCK_TIMEOUT"
                    assert lock.stdout.readline().strip() == "BOUNDED_RECEIPT_LOCK_HELD"
                pending = self.client(name + "-clients", 32, 32, timeout=5)
                assert pending["requests"] == pending["success"] == 32 and pending["status_counts"] == {"200": 32}
                assert pending["execution_modes"].get("fast-reserved-max", 0) == 32 and not pending["fallback_reasons"]
                self.total += 32
                mock_after = self.metrics()
                self.save(name + "-mock-after", mock_after)
                mock_proof = verify_mock_counts(mock_before, mock_after, 32)
                self.save(name + "-mock-proof", mock_proof)
                held = self.census()
                owner_held = self.owner_census(name + "-held", epochs=epochs)["proof"]["by_owner"]
                pending_by_owner = {owner: owner_held[owner]["intents"] - row["intents"]
                                    for owner, row in owner_before.items()}
                queues = self.queue_snapshots(bootstrap, state_file, timeout=1)
                queue_proof = verify_queue_snapshots(queues, bootstrap, args.workers,
                                                    pending_by_owner=pending_by_owner, profile=args.profile)
                self.gateway.terminate()
                self.gateway_term_sent = True
                deadline = time.monotonic() + 1.5
                while time.monotonic() < deadline:
                    stopping = json.loads(state_file.read_text())
                    if stopping["phase"] == "stopping":
                        break
                    time.sleep(.01)
                # A shutdown that skips its pending queue could appear to stop
                # briefly; retain the lock and require every PID still present.
                time.sleep(.1)
                assert lock.poll() is None, "BOUNDED_BUSINESS_RECEIPT_LOCK_EXPIRED"
                stopping = json.loads(state_file.read_text())
                proof = verify_pending_term_observation(before, held, owner_before, owner_held,
                                                        32, bootstrap, stopping, args.profile)
                assert proof["pending_intents_by_owner"] == pending_by_owner
                assert lock.poll() is None, "BOUNDED_BUSINESS_RECEIPT_LOCK_EXPIRED"
                alive = [process_snapshot(row["pid"]) for row in bootstrap["workers"]]
                assert all(row.get("available") for row in alive)
                self.save(name + "-held-proof", {"proof": proof, "before": before, "held": held,
                                                "native_queues_before_TERM": queue_proof,
                                                "state_after_TERM": stopping, "processes_after_TERM": alive,
                                                "lock_hold_elapsed_seconds": time.monotonic() - started})
            finally:
                if lock.poll() is None:
                    lock.stdin.write("ROLLBACK;\n\\q\n")
                    lock.stdin.flush()
                    try:
                        lock.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        lock.kill()
                        lock.wait()
                if lock.stdin:
                    lock.stdin.close()
                if lock.stdout:
                    lock.stdout.close()
            assert lock.returncode == 0, "BOUNDED_BUSINESS_LOCK_RELEASE_FAILED"
            # TERM was already delivered; sending it twice could kill the outer
            # fixture launcher after its once() signal handler was removed.
            try:
                self.gateway.wait(timeout=75)
            except subprocess.TimeoutExpired:
                self.gateway.kill()
                self.gateway.wait()
                raise RuntimeError("BOUNDED_BUSINESS_PENDING_TERM_DRAIN_TIMEOUT")
            return {"requested": True, "successful_clients": 32, "both_owners_pending_after_TERM": True,
                    "lock_released_by_rollback": True, "lock_exit_code": lock.returncode,
                    "mock_counts": mock_proof}

    fixture = Pilot(args)
    owned_identities = []
    bootstrap = None
    result = {"passed": False, "stage": "incomplete"}
    name = f"{args.scene}-{args.profile}-business{args.workers}"
    try:
        wait_active(fixture)
        fixture.save("manifest", {
            "source_commit": args.expected_source, "generation": args.generation,
            "scene": args.scene, "profile": args.profile, "client_plan": scene, "business_workers": args.workers, "diagnostic_only": True,
            "pending_TERM_qualification_requested": args.pending_term,
            "not_full_performance_acceptance": True, "production_changes": False,
            "capacity_diagnostic": args.capacity_diagnostic, "performance_acceptance": False,
            "native_http_capacity_probe": args.capacity_diagnostic,
            "topology": "same RR primary and public port; one or two actual business workers",
            "aggregate_budgets": totals, "per_child_budgets": expected_budgets(args.workers, args.profile),
            "M": MAXIMUM, "fee_per_success": 35, "actual_usage": {"input": 10, "output": 5},
            "fresh_fixture_required": True, "restart_enabled": False,
            "queue_observer": False, "cpu_profiler": False, "timed_driver_hooks": False,
            "extra_SQL_periodic_sampler": False, "quiet_guard_file_sampler_seconds": 1,
            "client_sha256": hashlib.sha256(args.client.read_bytes()).hexdigest(),
            "helper_hashes": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                              for file in here.glob("*bounded*business*") if file.is_file()},
            "warm_protocol": ("10 JSON bootstrap +128 protocol-matched c32; total138; full finance+TPM drain and minimum1s gap"
                              if args.profile in SERIAL_PROFILES else
                              "10 bootstrap +128 c32, same total138 in both arms; both owners must have actual completed work; full finance+TPM drain and minimum1s gap"),
            "qualification_request_counts": {"warm": 138, "JSON": 256, "SSE": 32, "held_before_TERM": 32 if args.pending_term else 0,
                                             "total": 458 if args.pending_term else 426} if args.scene == "qualification" else None,
            "caveats": ["No lifetime aggregate T guarantee across restart/retired unresolved liabilities; exactly the fresh fixed-M owners are allowed.",
                        "PG lane split changes14+2 to6+2 per child; two journal pollers instead of one.",
                        "Eight total credit stripes in both arms; local partitions may strand capacity under keepalive/tenant skew.",
                        "CPU and RAM may increase. No multicore gain or available CPU quota is assumed.",
                        "Node cluster internal pending socket handoff is not a production bounded request queue.",
                        "One arm per invocation; use matched reversed/repeated runs before claiming a performance effect."],
        })
        fixture.start_services()
        mock_initial = fixture.metrics()
        fixture.save(name + "-mock-fresh", verify_mock_counts(mock_initial, mock_initial, 0, fresh=True))
        fixture.start_router(observer=False)
        state_file = Path(fixture.info["clusterStateFile"])
        bootstrap = json.loads(state_file.read_text())
        proofs = [json.loads(Path(row["bootstrapProofFile"]).read_text()) for row in bootstrap["workers"]]
        bootstrap_proof = verify_bootstrap(bootstrap, proofs, args.workers, args.profile, capacity_diagnostic=args.capacity_diagnostic)
        fixture.owners = bootstrap_proof["owners"]
        primary_pid = bootstrap["primaryPid"]
        business_pids = bootstrap_proof["pids"]
        assert fixture.info["profile"] == args.profile
        assert fixture.info["gatewayPids"] == business_pids and fixture.info["clusterPrimaryPid"] == primary_pid
        all_pids = [primary_pid, *business_pids]
        owned_identities = [process_snapshot(pid) for pid in all_pids]
        assert all(row.get("available") for row in owned_identities)
        fixture.save(name + "-bootstrap", {"state": bootstrap, "children": proofs, "verification": bootstrap_proof})
        initial = fixture.owner_census(name + "-initial", require_work=False)
        epochs = initial["proof"]["epochs"]
        assert initial["census"]["allocations"] == [] and initial["census"]["maxima"] == [], "BOUNDED_BUSINESS_FRESH_FIXTURE_REQUIRED"
        fixture.warm(10)
        fixture.checkpoint(name)
        warm = profile_client(fixture, args.profile, name + "-warm", 128, 32)
        assert warm["success"] == warm["requests"] == 128 and warm["status_counts"] == {"200": 128}
        if args.profile in SERIAL_PROFILES:
            assert warm["stream"] is profile_stream(args.profile), "BOUNDED_BUSINESS_SERIAL_WARM_PROTOCOL_REQUIRED"
        fixture.total += 128
        fixture.drain(name + "-warm", fixture.total)
        fixture.tpm_drain(name + "-warm")
        if args.scene == "qualification":
            fixture.qualification_queue_empty(name + "-warm", bootstrap, state_file)
        owners_before = fixture.owner_census(name + "-warm", epochs=epochs)
        warm_drained = time.monotonic()
        before = fixture.census()
        mock_before = fixture.metrics()
        fixture.save(name + "-warm-mock-after", mock_before)
        fixture.save(name + "-warm-mock", verify_mock_counts(mock_initial, mock_before, 138, fresh=True))
        time.sleep(max(0, warm_drained + 1 - time.monotonic()))
        if args.capacity_diagnostic:
            capacity_before = verify_capacity_snapshots(fixture.queue_snapshots(bootstrap, state_file), bootstrap)
            fixture.save(name + "-capacity-before", capacity_before)
        fixture.sql(fixture.db, "SELECT pg_stat_statements_reset()")
        quiet_before = capture(fixture)
        assert quiet_before["valid"]
        cpu_before = {pid: process_snapshot(pid) for pid in all_pids}
        clock_before = time.time_ns() - time.monotonic_ns()
        quiet_samples = []
        stop_guard = threading.Event()

        def guard():
            while not stop_guard.wait(1):
                quiet_samples.append(capture(fixture))

        thread = threading.Thread(target=guard, daemon=True)
        thread.start()
        try:
            raw = profile_client(fixture, args.profile, name, scene["count"], scene["concurrency"], duration=scene["duration"])
            fixture.total += raw["success"]
            immediate = fixture.census()
            fixture.save(name + "-immediate", immediate)
            assert int(immediate["allocation_backing_minor_units"]) <= totals["automaticCreditTarget"]
            final = fixture.drain(name, fixture.total, raise_on_error=False)
            tpm_proof = fixture.tpm_drain(name)
            financial_tpm_end_wall_ns = time.time_ns()
            clock_after = time.time_ns() - time.monotonic_ns()
            cpu_after = {pid: process_snapshot(pid) for pid in all_pids}
        finally:
            stop_guard.set()
            thread.join()
        quiet_after = capture(fixture)
        if args.capacity_diagnostic:
            capacity_after = verify_capacity_snapshots(fixture.queue_snapshots(bootstrap, state_file), bootstrap)
            fixture.save(name + "-capacity-after", capacity_after)
        owners_after = fixture.owner_census(name + "-after", epochs=epochs)
        app_stats(fixture, name, fixture.db, True)
        sql_rows = json.loads((A / "results" / f"{fixture.label}-{name}-sql.json").read_text())
        reserve_calls = sum(row["calls"] for row in sql_rows if "fast-journal:reserve-intent" in row["query"] or row["query"].startswith("WITH current_owner AS MATERIALIZED"))
        lookup_calls = sum(row["calls"] for row in sql_rows if row["query"].startswith("SELECT i.request_id, i.intent_digest, COALESCE("))
        mock_after = fixture.metrics()
        client_proof = verify_main_client(raw, args.profile, args.scene)
        # Preserve ordinary failed-run summaries before its unchanged strict gate.
        # Diagnostic mode must classify every failure before continuing collection.
        outcome_proof = (verify_client_outcomes(raw, capacity_diagnostic=args.capacity_diagnostic)
                         if args.capacity_diagnostic or raw["success"] == raw["requests"] else
                         {"verified": False, "zero_error_gate_passed": False, "performance_acceptance": False})
        if args.capacity_diagnostic:
            reject_delta = sum(v["capacityDiagnostic"]["rejected"] for v in capacity_after["workers"]) - sum(v["capacityDiagnostic"]["rejected"] for v in capacity_before["workers"])
            assert reject_delta == outcome_proof["capacity_rejections"], "BOUNDED_CAPACITY_REJECTION_CENSUS_MISMATCH"
        client_start, client_end = int(raw["started_at_unix_ns"]), int(raw["completed_at_unix_ns"])
        clock_error_ns = abs((client_end - client_start) - round(raw["duration_s"] * 1e9))
        clock_stable = clock_error_ns <= 1000000 and abs(clock_after - clock_before) <= 1000000
        financial_duration = (financial_tpm_end_wall_ns - client_start) / 1e9
        resource = aggregate_resources(cpu_before, cpu_after, primary_pid, business_pids, raw["success"])
        owner_deltas = {owner: {key: owners_after["proof"]["by_owner"][owner][key] - owners_before["proof"]["by_owner"][owner][key]
                                for key in ("intents", "completed")} for owner in fixture.owners}
        summary = {
            "scene": name, "profile": args.profile, "client_plan": scene, "source_commit": args.expected_source, "business_workers": args.workers,
            "diagnostic_only": True, "qualification_only": args.scene == "qualification",
            "all_attempt_client_proof": client_proof, "outcome_proof": outcome_proof,
            "capacity_diagnostic": args.capacity_diagnostic, "performance_acceptance": False if args.capacity_diagnostic else None,
            "client": {key: value for key, value in raw.items() if key != "samples"},
            "client_completion_success_rps": raw["throughput_success_rps"],
            "client_plus_financial_and_tpm_drain_seconds": financial_duration,
            "client_plus_financial_and_tpm_drain_success_rps": raw["success"] / financial_duration if clock_stable else None,
            "financial_and_tpm_drain": tpm_proof,
            "financial_drain_ok": final["drain"]["ok"], "zero_denials": raw["success"] == raw["requests"],
            "all_attempt_latency_ms": distribution([sample["MS"] for sample in raw["samples"]]),
            "first_body_observed_all_status_ms": distribution([sample["TTFB"] for sample in raw["samples"] if sample["Bytes"] > 0]),
            "census_before": before, "census_after": final, "owner_work_deltas": owner_deltas,
            "process_resources": resource, "queue_telemetry": unavailable_queue_telemetry(),
            "queue_empty_verified_before_shutdown": None,
            "observer_off_qualification": "Queue occupancy, phase waits, fallbacks, retries and empty state are unavailable, not zero; native graceful lifecycle drain is separately required.",
            "drain_timestamp_qualification": "Includes client serialization/read and aggregate finance/Redis truth probes; not pure receipt/COMMIT latency. No queue empty observation before shutdown.",
            "clock": {"stable_within_1ms": clock_stable, "client_wall_vs_monotonic_error_ns": clock_error_ns,
                      "outer_realtime_monotonic_offset_change_ns": clock_after - clock_before,
                      "client_start_unix_ns": str(client_start), "observed_financial_tpm_end_unix_ns": str(financial_tpm_end_wall_ns)},
            "sql_recorded_app_role_calls_through_drain": sum(row["calls"] for row in sql_rows),
            "sql_scope": "PGSS recorded app-role calls through drain, not TCP roundtrips or complete internal SQL.",
            "recovery_SQL": {"reserve_calls": reserve_calls, "created_intents": final["intent_count"] - before["intent_count"],
                             "reserve_minus_created": reserve_calls - (final["intent_count"] - before["intent_count"]),
                             "intent_replay_lookup_calls": lookup_calls, "receipt_append_calls": receipt_append_calls(sql_rows)},
            "mock_received_delta": mock_after["received"] - mock_before["received"],
            "mock_completed_delta": mock_after["completed"] - mock_before["completed"],
            "warm_successes": 138,
            "quiet": {"before": quiet_before, "after": quiet_after, "samples": quiet_samples,
                      "valid": quiet_before["valid"] and quiet_after["valid"] and all(value["valid"] for value in quiet_samples)},
        }
        fixture.save(name + "-summary", summary)
        print(json.dumps({"scene": name, "attempts": raw["requests"], "success": raw["success"],
                          "client_rps": summary["client_completion_success_rps"],
                          "financial_tpm_rps": summary["client_plus_financial_and_tpm_drain_success_rps"],
                          "p99": summary["all_attempt_latency_ms"]["p99"],
                          "financial": summary["financial_drain_ok"], "quiet": summary["quiet"]["valid"]}), flush=True)
        assert summary["quiet"]["valid"] and clock_stable and resource["valid"]
        assert final["drain"]["ok"]
        if not args.capacity_diagnostic:
            verify_client_outcomes(raw)
        assert args.capacity_diagnostic or raw["success"] == raw["requests"]
        assert summary["mock_received_delta"] == summary["mock_completed_delta"] == raw["success"]
        assert raw["execution_modes"].get("fast-reserved-max", 0) == raw["success"] and not raw["fallback_reasons"]
        assert all(value["intents"] == value["completed"] and value["completed"] > 0 for value in owner_deltas.values())
        assert sum(value["completed"] for value in owner_deltas.values()) == raw["success"]
        if args.scene == "qualification":
            fixture.qualification_queue_empty(name + "-after", bootstrap, state_file)
            sse_before = fixture.census()
            sse_mock_before = fixture.metrics()
            fixture.save(name + "-SSE-mock-before", sse_mock_before)
            sse = fixture.client(name + "-SSE", 32, 32, stream=True)
            sse_proof = verify_sse_qualification(sse, 32)
            fixture.total += 32
            sse_final = fixture.drain(name + "-SSE", fixture.total)
            sse_tpm = fixture.tpm_drain(name + "-SSE")
            fixture.qualification_queue_empty(name + "-SSE", bootstrap, state_file)
            sse_mock_after = fixture.metrics()
            fixture.save(name + "-SSE-mock-after", sse_mock_after)
            sse_mock_proof = verify_mock_counts(sse_mock_before, sse_mock_after, 32)
            fixture.save(name + "-SSE-mock-proof", sse_mock_proof)
            assert sse_final["intent_count"] - sse_before["intent_count"] == 32
            fixture.owner_census(name + "-SSE", epochs=epochs)
            fixture.save(name + "-SSE-qualification", {"verification": sse_proof, "financial": sse_final["drain"],
                                                      "TPM": sse_tpm, "mock_counts": sse_mock_proof,
                                                      "total_successes_including_warm": fixture.total})
        pending_term = fixture.pending_term(name + "-pending-term", bootstrap, epochs, state_file) if args.pending_term else None
        if not args.pending_term:
            fixture.stop(fixture.gateway)
        outer = json.loads((fixture.out / "async-gateway-cleanup.json").read_text())
        stopped = json.loads(state_file.read_text())
        cleanup = verify_cluster_cleanup(stopped, bootstrap, outer)
        fixture.save(name + "-gateway-cleanup", cleanup)
        if args.capacity_diagnostic:
            capacity_final = [json.loads(Path(row["queueSnapshotFile"] + ".capacity-final.json").read_text()) for row in bootstrap["workers"]]
            final_probe = verify_capacity_snapshots(capacity_final, bootstrap)
            assert all(value["final"] is True and value["capacityDiagnostic"]["current"] == 0 for value in capacity_final)
            fixture.save(name + "-capacity-postshutdown", final_probe)
        fixture.drain(name + "-postshutdown", fixture.total)
        fixture.tpm_drain(name + "-postshutdown")
        fixture.owner_census(name + "-postshutdown", epochs=epochs, postshutdown=True)
        mock_postshutdown = fixture.metrics()
        fixture.save(name + "-postshutdown-mock", mock_postshutdown)
        whole_mock = verify_mock_counts(mock_initial, mock_postshutdown, fixture.total, fresh=True)
        fixture.save(name + "-whole-fixture-mock", whole_mock)
        if pending_term:
            fixture.save(name + "-pending-term-qualification", {**pending_term, "verified": True,
                         "all_original_children_graceful": True, "postshutdown_finance_and_TPM_exact": True,
                         "total_successes_including_warm_and_pending": fixture.total})
        result = {"passed": experiment_passed(raw, capacity_diagnostic=args.capacity_diagnostic), "scene": name,
                  "performance_acceptance": False, "capacity_diagnostic": args.capacity_diagnostic,
                  "diagnostic_collection_complete": args.capacity_diagnostic, "outcome_proof": outcome_proof, "profile": args.profile, "diagnostic_only": True,
                  "qualification_only": args.scene == "qualification", "business_workers": args.workers,
                  "whole_fixture_mock_verified": True, "whole_fixture_successes": fixture.total,
                  "pending_TERM_qualification_verified": bool(pending_term)}
    except BaseException as error:
        result = {"passed": False, "error_category": type(error).__name__, "stage": "experiment"}
        raise
    finally:
        def discover_owned():
            if fixture.out is None:
                return []
            state_path = fixture.out / "bounded-business-cluster-state.json"
            if not state_path.exists():
                return []
            state = json.loads(state_path.read_text())
            assert len(state.get("workers", [])) <= args.workers
            entrypoint = str(Path(args.source).resolve() / "dist/cli/index.js")
            rows = [{"pid": state["primaryPid"], "start_ticks": str(state["primaryStartTicks"]), "role": "primary",
                     "expected_argv": [str(here / "bounded-business-cluster.cjs"), entrypoint]}]
            for row in state["workers"]:
                assert row["owner"] == f"{fixture.db}-bounded-slot-{row['slot']}"
                rows.append({"pid": row["pid"], "start_ticks": str(row["startTicks"]), "role": "business",
                             "expected_argv": [entrypoint]})
            captured = {row["pid"]: row for row in owned_identities}
            for row in rows:
                if row["pid"] in captured:
                    assert row["start_ticks"] == str(captured[row["pid"]]["start_ticks"])
            return rows

        def cleanup_snapshot(pid):
            value = process_snapshot(pid)
            if value.get("available"):
                try:
                    value["state"] = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                    value["argv"] = [part.decode() for part in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if part]
                except (OSError, UnicodeError, IndexError):
                    value["available"] = False
            return value

        def cleanup_run():
            # An early TERM of the OUTER fixture launcher must not orphan its
            # primary/business descendants and shut PostgreSQL down first.
            # Quiesce its spawn owner before treating an absent state as empty.
            # The derived adapter owns signals before any asynchronous startup.
            fixture.stop(fixture.gateway)
            descendant_cleanup = cleanup_owned_cluster(discover_owned, cleanup_snapshot, os.kill)
            fixture.save("descendant-cleanup", descendant_cleanup)
            group_cleanup = cleanup_owned_group(fixture.owned_launcher_group, process_group_members, os.killpg)
            fixture.save("process-group-cleanup", group_cleanup)
            if not descendant_cleanup["all_exited"] or not group_cleanup["all_exited"]:
                fixture.save("cleanup", {"all_exited": False, "descendant_cleanup": descendant_cleanup,
                                         "process_group_cleanup": group_cleanup})
                raise RuntimeError("BOUNDED_BUSINESS_DESCENDANT_EXIT_UNPROVEN")
            fixture.cleanup()
            post_outer = cleanup_owned_cluster(discover_owned, cleanup_snapshot, os.kill)
            if not post_outer["all_exited"] or post_outer["abnormal_cleanup"]:
                fixture.save("cleanup", {"all_exited": False, "unexpected_post_dependency_descendants": post_outer})
                raise RuntimeError("BOUNDED_BUSINESS_LATE_DESCENDANT_AFTER_OUTER_EXIT")
            cleanup_record = json.loads((A / "results" / f"{fixture.label}-cleanup.json").read_text())
            cleanup_record["descendant_cleanup"] = descendant_cleanup
            cleanup_record["process_group_cleanup"] = group_cleanup
            fixture.save("cleanup", cleanup_record)
            assert cleanup_record["all_exited"]
            if (descendant_cleanup["abnormal_cleanup"] or group_cleanup["abnormal_cleanup"]) and (result.get("passed") or result.get("diagnostic_collection_complete")):
                raise RuntimeError("BOUNDED_BUSINESS_ABNORMAL_CLEANUP_CANNOT_PASS")

        finalize_run(result, cleanup_run,
                     lambda: release(args.generation, args.expected_source, [args.label]),
                     lambda value: fixture.save("result", value))


if __name__ == "__main__":
    main()
