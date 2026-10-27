"""Pure accounting/process-proof checks; no database, Redis or workload starts."""
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

from bounded_business_performance_pilot import (
    TOTAL_BUDGETS, TOTAL_CREDIT_TARGET, CAPACITY_COMPILED_SHA256, CAPACITY_COMPILED_PINS, CAPACITY_ALLOWED_COMPILED_SHA256, aggregate_resources, expected_budgets,
    router_environment, verify_bootstrap, verify_cluster_cleanup, verify_owner_bounds,
    verify_pending_term_observation,
    verify_queue_snapshots,
    cleanup_owned_cluster, finalize_run,
    cleanup_owned_group, process_group_members,
    verify_sse_qualification, verify_mock_counts, verify_main_client, verify_client_outcomes, verify_capacity_snapshots,
    experiment_passed, profile_client,
)

from bounded_business_profiles import aggregate_budgets, get_profile, profile_stream, scene_parameters


def bootstrap(workers=2, profile="c32"):
    budgets = expected_budgets(workers, profile)
    state = {"profile": profile, "primaryPid": 100, "businessWorkersStarted": workers, "restartEnabled": False,
             "phase": "ready", "workers": []}
    proofs = []
    for slot in range(workers):
        row = {"slot": slot, "pid": 101 + slot, "owner": f"fixture-slot-{slot}", "ready": True,
               "exitCode": None, "signal": None, "forcedKill": False}
        state["workers"].append(row)
        proofs.append({"profile": profile, "pid": row["pid"], "owner": row["owner"], "slot": slot,
                       "budgets": budgets.copy(), "pools": [{"max": budgets["databasePoolMax"] - 2}, {"max": 2}],
                       "poolObserverRemoved": True, "nativePoolPrototypes": True, "inferenceHooksInstalled": False,
                       "nativeFastPrototypes": True,
                       "startupObserversRemoved": True,
                       "executorLocalCaps": [budgets["httpInFlight"]], "compositionHttpCaps": [budgets["httpInFlight"]],
                       "receiptQueues": [{"maxEntries": budgets["receiptEntries"], "maxBytes": budgets["receiptBytes"],
                                          "maxPerTenant": budgets["receiptPerTenant"], "workers": budgets["receiptWorkers"],
                                          "maxAgeMs": 5000, "drainTimeoutMs": 10000}],
                       "readyStatus": 200, "readinessListenerClosed": True})
    return state, proofs


def census(workers=2, profile="c32"):
    target = aggregate_budgets(profile)["automaticCreditTarget"]
    allocations = []
    owners = [f"fixture-slot-{slot}" for slot in range(workers)]
    for owner in owners:
        for stripe in range(8 // workers):
            allocations.append({"owner": owner, "epoch": owner + "-epoch", "currency": "USD", "state": "active",
                                "stripe": stripe, "backing": str(target // 8),
                                "available": str(target // 8), "intents": 2, "completed": 2,
                                "settled_charge": "70"})
    return {"owners": [{"owner": owner, "epoch": owner + "-epoch"} for owner in owners],
            "allocations": allocations, "maxima": [{"maximum": "524480", "intents": 16}],
            "all_backing": str(target), "all_available": str(target)}, owners


class SerialProfileTests(unittest.TestCase):
    def test_serial_profiles_preserve_c32_budgets_and_require_one_process(self):
        for profile, stream in (("serial-json", False), ("serial-sse", True)):
            self.assertEqual(aggregate_budgets(profile), aggregate_budgets("c32"))
            self.assertEqual(expected_budgets(1, profile), aggregate_budgets("c32"))
            self.assertEqual(scene_parameters(profile, "timed"), {"count": 1000, "concurrency": 1, "duration": 0})
            self.assertIs(profile_stream(profile), stream)
            with self.assertRaises(ValueError): expected_budgets(2, profile)
            with self.assertRaises(ValueError): scene_parameters(profile, "qualification")
            state, proofs = bootstrap(1, profile)
            self.assertTrue(verify_bootstrap(state, proofs, 1, profile)["verified"])
            self.assertEqual(proofs[0]["receiptQueues"][0]["workers"], 8)
            rows, owners = census(1, profile)
            self.assertTrue(verify_owner_bounds(rows, owners, 1, profile=profile)["verified"])
            env = router_environment({"PAIR_ASYNC_METRICS": "1"}, 1, profile)
            self.assertEqual(env["PAIR_ASYNC_METRICS"], "0")
            self.assertEqual(env["PAIR_CONCURRENCY_CAP"], "64")
            proofs[0]["profile"] = "c32"
            with self.assertRaises(AssertionError): verify_bootstrap(state, proofs, 1, profile)

    def test_protocol_flag_matches_warm_and_main_without_changing_legacy_calls(self):
        class Fixture:
            def __init__(self): self.calls = []
            def client(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                return "native-client-result"
        for profile, stream, count, concurrency, duration in (
                ("serial-json", False, 1000, 1, 0), ("serial-sse", True, 1000, 1, 0),
                ("c32", False, 1000000, 32, 60), ("c200", False, 10000, 200, 0)):
            fixture = Fixture()
            profile_client(fixture, profile, "warm", 128, 32)
            result = profile_client(fixture, profile, "main", count, concurrency, duration)
            self.assertEqual(result, "native-client-result")
            self.assertEqual(fixture.calls, [(("warm", 128, 32), {"duration": 0, "stream": stream}),
                (("main", count, concurrency), {"duration": duration, "stream": stream})])

    def test_serial_preserves_all1000_and_checks_native_protocol_including_tail(self):
        for profile, stream in (("serial-json", False), ("serial-sse", True)):
            raw = {"stream": stream, "concurrency": 1, "requests": 1000,
                   "samples": [{"MS": 1}] * 999 + [{"MS": 10000, "Err": "tail-error"}]}
            self.assertEqual(verify_main_client(raw, profile, "timed")["retained_attempts"], 1000)
            for change in ({"stream": not stream}, {"stream": int(stream)}, {"concurrency": 32},
                           {"requests": 999, "samples": raw["samples"][:-1]}, {"samples": raw["samples"][:-1]}):
                with self.assertRaises(AssertionError): verify_main_client({**raw, **change}, profile, "timed")
            with self.assertRaises(KeyError): verify_main_client({k:v for k,v in raw.items() if k != "stream"}, profile, "timed")

    def test_legacy_profiles_are_unchanged_and_have_no_new_protocol_field(self):
        self.assertEqual(get_profile("c32"), {"httpInFlight": 64, "concurrency": 32, "timedSeconds": 60, "timedRequests": None})
        self.assertEqual(get_profile("c200"), {"httpInFlight": 256, "concurrency": 200, "timedSeconds": None, "timedRequests": 10000})


class CapacityDiagnosticTests(unittest.TestCase):
    def test_instrumented_zero_rejections_still_cannot_pass_experiment(self):
        raw = {"success": 10000, "requests": 10000}
        self.assertFalse(experiment_passed(raw, capacity_diagnostic=True))
        self.assertTrue(experiment_passed(raw))
        self.assertFalse(experiment_passed({"success": 9961, "requests": 10000}))

    def test_optin_never_inherited_and_budgets_unchanged(self):
        dirty = {"BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC": "1"}
        self.assertNotIn("BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC", router_environment(dirty, 2, "c200"))
        enabled = router_environment(dirty, 2, "c200", capacity_diagnostic=True)
        self.assertEqual(enabled["BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC"], "1")
        self.assertEqual(enabled["PAIR_CONCURRENCY_CAP"], "256")
        with self.assertRaises(AssertionError):
            router_environment({}, 1, "c200", capacity_diagnostic=True)

    def test_bootstrap_requires_instrumentation_only_when_explicit(self):
        state, proofs = bootstrap(2, "c200")
        state["capacityDiagnostic"] = True
        self.assertEqual(CAPACITY_ALLOWED_COMPILED_SHA256, frozenset(CAPACITY_COMPILED_PINS.values()))
        self.assertEqual(len(CAPACITY_ALLOWED_COMPILED_SHA256), 2)
        for pin in CAPACITY_ALLOWED_COMPILED_SHA256:
            for proof in proofs:
                proof.update(inferenceHooksInstalled=True, capacityDiagnostic={"enabled": True, "compiledSha256": pin})
            self.assertTrue(verify_bootstrap(state, proofs, 2, "c200", capacity_diagnostic=True)["verified"])
            self.assertTrue(all(proof["capacityDiagnostic"]["compiledSha256"] == pin for proof in proofs))
            with self.assertRaises(AssertionError):
                verify_bootstrap(state, proofs, 2, "c200")
        proofs[0]["capacityDiagnostic"]["compiledSha256"] = "0" * 64
        with self.assertRaises(AssertionError):
            verify_bootstrap(state, proofs, 2, "c200", capacity_diagnostic=True)

    def test_only_known429_can_continue_and_never_passes_zero_error_gate(self):
        success = {"Status": 200, "Err": "", "Bytes": 276, "Mode": "fast-reserved-max", "Fallback": ""}
        rejected = {"Status": 429, "Bytes": 150, "Mode": "", "Fallback": "", "Err": json.dumps({"error": {
            "code": "GATEWAY_CAPACITY_EXHAUSTED", "message": "The request could not be completed",
            "requestId": "033779f3-c541-4338-98ee-21a8fe8d7715"}})}
        raw = {"samples": [success, rejected], "success": 1, "requests": 2, "status_counts": {"200": 1, "429": 1}}
        with self.assertRaises(AssertionError):
            verify_client_outcomes(raw)
        proof = verify_client_outcomes(raw, capacity_diagnostic=True)
        self.assertFalse(proof["zero_error_gate_passed"])
        self.assertFalse(proof["performance_acceptance"])
        for change in ({"Status": 503}, {"Mode": "fast-reserved-max"}, {"Err": '{"error":{"code":"FAST_CREDIT_BUSY"}}'}):
            bad = copy.deepcopy(raw); bad["samples"][1].update(change)
            with self.assertRaises((AssertionError, KeyError)):
                verify_client_outcomes(bad, capacity_diagnostic=True)
        self.assertEqual(len(raw["samples"]), 2)

    def test_snapshot_exact_cap128_and_bounded_samples(self):
        state, _ = bootstrap(2, "c200")
        values = [{"pid": row["pid"], "slot": row["slot"], "capacityDiagnostic": {
            "enabled": True, "pid": row["pid"], "limit": 128, "current": 0, "peak": 128,
            "accepted": 10, "settled": 10, "rejected": 0, "dropped": 0, "violations": 0, "samples": [],
            "compiledSha256": "a98faa12c22e5283281af4e70b96c7153c0e57aacf12788de9afb3622aa9307f"}} for row in state["workers"]]
        for pin in CAPACITY_ALLOWED_COMPILED_SHA256:
            for value in values:
                value["capacityDiagnostic"]["compiledSha256"] = pin
            result = verify_capacity_snapshots(values, state)
            self.assertTrue(result["verified"])
            self.assertTrue(all(value["capacityDiagnostic"]["compiledSha256"] == pin for value in result["workers"]))
        values[0]["capacityDiagnostic"]["compiledSha256"] = "0" * 64
        with self.assertRaises(AssertionError):
            verify_capacity_snapshots(values, state)
        values[0]["capacityDiagnostic"]["compiledSha256"] = CAPACITY_COMPILED_SHA256
        values[0]["capacityDiagnostic"]["limit"] = 256
        with self.assertRaises(AssertionError):
            verify_capacity_snapshots(values, state)


class BudgetTests(unittest.TestCase):
    def test_profiles_share_fixed_budgets_but_explicitly_change_admission_and_funds(self):
        for profile, concurrency, cap, target in (("c32", 32, 64, 67133440), ("c200", 200, 256, 268533760)):
            totals = aggregate_budgets(profile)
            self.assertEqual(get_profile(profile)["concurrency"], concurrency)
            self.assertEqual(totals["httpInFlight"], cap)
            self.assertEqual(totals["automaticCreditTarget"], target)
            for workers in (1, 2):
                child = expected_budgets(workers, profile)
                self.assertEqual({key: value * workers for key, value in child.items()}, totals)
                self.assertEqual(child["databasePoolMax"] * workers, 16)
                self.assertEqual(child["receiptPerTenant"] * workers, 64)
                env = router_environment({"PAIR_CONCURRENCY_CAP": "999", "BOUNDED_CLUSTER_PROFILE": "unknown"}, workers, profile)
                self.assertEqual(env["PAIR_CONCURRENCY_CAP"], str(cap))
                self.assertEqual(env["BOUNDED_CLUSTER_PROFILE"], profile)
        for invalid in ("unknown", "", "C200", None, 200):
            with self.assertRaises(ValueError):
                get_profile(invalid)
        self.assertEqual(scene_parameters("c32", "timed"), {"count": 1000000, "concurrency": 32, "duration": 60})
        self.assertEqual(scene_parameters("c200", "timed"), {"count": 10000, "concurrency": 200, "duration": 0})
        self.assertEqual(scene_parameters("c200", "qualification"), {"count": 256, "concurrency": 200, "duration": 0})

    def test_c200_bootstrap_requires_profile_and_real_cap128_per_child(self):
        for workers in (1, 2):
            state, proofs = bootstrap(workers, "c200")
            self.assertTrue(verify_bootstrap(state, proofs, workers, "c200")["verified"])
            self.assertEqual(proofs[0]["budgets"]["automaticCreditTarget"], 268533760 // workers)
        for mutate in (lambda s, p: s.update(profile="c32"), lambda s, p: p[1].update(profile="c32"),
                       lambda s, p: p[1]["budgets"].update(httpInFlight=32),
                       lambda s, p: p[1].update(executorLocalCaps=[32]),
                       lambda s, p: p[1]["budgets"].update(automaticCreditTarget=33566720)):
            state, proofs = bootstrap(2, "c200")
            mutate(state, proofs)
            with self.assertRaises(AssertionError):
                verify_bootstrap(state, proofs, 2, "c200")

    def test_finite_c200_preserves_all10000_attempts_including_errors_and_tail(self):
        raw = {"concurrency": 200, "requests": 10000, "samples": [{"MS": 1}] * 9999 + [{"MS": 10000, "Err": "tail-error"}]}
        self.assertEqual(verify_main_client(raw, "c200", "timed")["retained_attempts"], 10000)
        for change in ({"requests": 9999, "samples": raw["samples"][:-1]}, {"samples": raw["samples"][:-1]},
                       {"concurrency": 32}):
            with self.assertRaises(AssertionError):
                verify_main_client({**raw, **change}, "c200", "timed")

    def test_mock_proofs_close_SSE_held_and_postshutdown_whole_fixture_gaps(self):
        initial = {"received": 0, "completed": 0}
        json_end = {"received": 394, "completed": 394}
        sse_end = {"received": 426, "completed": 426}
        held_end = {"received": 458, "completed": 458}
        self.assertTrue(verify_mock_counts(json_end, sse_end, 32)["verified"])
        self.assertTrue(verify_mock_counts(sse_end, held_end, 32)["verified"])
        proof = verify_mock_counts(initial, held_end, 458, fresh=True)
        self.assertEqual(proof["after"], held_end)
        for before, after, expected, fresh in ((sse_end, sse_end, 32, False),
                (sse_end, {"received": 459, "completed": 458}, 32, False),
                (initial, {"received": 459, "completed": 459}, 458, True),
                ({"received": 1, "completed": 1}, {"received": 459, "completed": 459}, 458, True)):
            with self.assertRaises(AssertionError):
                verify_mock_counts(before, after, expected, fresh=fresh)
        self.assertTrue(verify_mock_counts(initial, {"received": 10138, "completed": 10138}, 10138, fresh=True)["verified"])

    def test_every_total_is_conserved_and_stripes_are_four_each(self):
        for workers in (1, 2):
            per_child = expected_budgets(workers)
            self.assertEqual({key: value * workers for key, value in per_child.items()}, TOTAL_BUDGETS)
        self.assertEqual(expected_budgets(2)["creditStripes"], 4)
        for workers in (0, 3, 8):
            with self.assertRaises(ValueError):
                expected_budgets(workers)

    def test_bootstrap_requires_both_processes_actual_pools_and_private_readiness(self):
        for workers in (1, 2):
            state, proofs = bootstrap(workers)
            result = verify_bootstrap(state, proofs, workers)
            self.assertTrue(result["verified"])
            self.assertEqual(sum(result["actual_pool_maxima"]), 16)
        mutations = [lambda s, p: p[1]["pools"].append({"max": 8}),
                     lambda s, p: p[1]["budgets"].update(receiptPerTenant=64),
                     lambda s, p: p[1].update(readyStatus=503),
                     lambda s, p: p[1].update(readinessListenerClosed=False),
                     lambda s, p: p[1].update(poolObserverRemoved=False),
                     lambda s, p: p[1].update(nativePoolPrototypes=False),
                     lambda s, p: p[1].update(inferenceHooksInstalled=True),
                     lambda s, p: p[1].update(startupObserversRemoved=False),
                     lambda s, p: p[1].update(executorLocalCaps=[64]),
                     lambda s, p: p[1]["receiptQueues"][0].update(workers=8),
                     lambda s, p: s["workers"][1].update(owner=s["workers"][0]["owner"]),
                     lambda s, p: s["workers"][1].update(pid=s["workers"][0]["pid"]),
                     lambda s, p: s["workers"][1].update(ready=False),
                     lambda s, p: s.update(businessWorkersStarted=3),
                     lambda s, p: s.update(restartEnabled=True)]
        for mutate in mutations:
            state, proofs = bootstrap()
            mutate(state, proofs)
            with self.assertRaises(AssertionError):
                verify_bootstrap(state, proofs, 2)

    def test_environment_cannot_inherit_doubled_queue_or_external_observers(self):
        initial = {"MODEL_ROUTER_FAST_RECEIPT_WORKERS": "32", "MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES": "9999999",
                   "BOUNDED_CLUSTER_WORKERS": "7", "PAIR_INSTANCES": "3", "UNCHANGED": "yes"}
        env = router_environment(initial, 2)
        self.assertEqual(env["BOUNDED_CLUSTER_WORKERS"], "2")
        self.assertEqual(env["PAIR_INSTANCES"], "1")
        self.assertEqual(env["UNCHANGED"], "yes")
        self.assertNotIn("MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES", env)
        self.assertEqual(initial["PAIR_INSTANCES"], "3")
        for key in ("NODE_OPTIONS", "PAIR_GATEWAY_NODE_OPTIONS"):
            with self.assertRaises(AssertionError):
                router_environment({key: "--require forbidden.cjs"}, 1)


class OwnerTests(unittest.TestCase):
    def test_c200_owner_target_is134266880_each_not_c32_target(self):
        for workers in (1, 2):
            data, owners = census(workers, "c200")
            result = verify_owner_bounds(data, owners, workers, profile="c200")
            self.assertEqual(result["expected_initial_target_per_owner"], 268533760 // workers)
            self.assertEqual(result["all_active_and_retired_backing"], 268533760)
            with self.assertRaises(AssertionError):
                verify_owner_bounds(data, owners, workers)
        data, owners = census()
        with self.assertRaisesRegex(AssertionError, "COLD_TARGET_UNPROVEN"):
            verify_owner_bounds(data, owners, 2, profile="c200")

    def test_all_owners_have_work_and_sum_backing_is_not_multiplied(self):
        for workers in (1, 2):
            data, owners = census(workers)
            proof = verify_owner_bounds(data, owners, workers)
            self.assertTrue(proof["verified"])
            self.assertEqual(proof["all_active_and_retired_backing"], TOTAL_CREDIT_TARGET)
            self.assertEqual(sum(row["completed"] for row in proof["by_owner"].values()), 16)

    def test_ignored_sibling_backing_restart_epoch_and_unwarmed_worker_fail(self):
        mutations = [lambda d: d["owners"].append({"owner": "foreign", "epoch": "foreign"}),
                     lambda d: d["allocations"][0].update(epoch="previous-epoch"),
                     lambda d: d["allocations"][0].update(state="retired"),
                     lambda d: d["maxima"][0].update(maximum="524481"),
                     lambda d: d["allocations"][0].update(stripe=7),
                     lambda d: d.update(all_backing=str(TOTAL_CREDIT_TARGET // 2)),
                     lambda d: [r.update(completed=0) for r in d["allocations"] if r["owner"] == "fixture-slot-1"]]
        for mutate in mutations:
            data, owners = census()
            mutate(data)
            with self.assertRaises(AssertionError):
                verify_owner_bounds(data, owners, 2)
        data, owners = census()
        with self.assertRaises(AssertionError):
            verify_owner_bounds(data, owners, 2, epochs={owner: "old" for owner in owners})

    def test_retired_backing_included_and_not_forgiven_after_shutdown(self):
        data, owners = census()
        for row in data["allocations"]:
            row.update(state="retired", backing="0", available="0")
        data.update(all_backing="0", all_available="0")
        self.assertTrue(verify_owner_bounds(data, owners, 2, postshutdown=True)["verified"])
        data["allocations"][0]["backing"] = "1"
        data["all_backing"] = "1"
        with self.assertRaises(AssertionError):
            verify_owner_bounds(data, owners, 2, postshutdown=True)

    def test_total_and_each_owner_are_independently_bounded(self):
        data, owners = census()
        data["allocations"][0]["backing"] = str(TOTAL_CREDIT_TARGET)
        data["all_backing"] = str(sum(int(row["backing"]) for row in data["allocations"]))
        with self.assertRaises(AssertionError):
            verify_owner_bounds(data, owners, 2)

    def test_small_positive_backing_does_not_prove_cold_target_and_fees_are_per_owner(self):
        data, owners = census()
        for row in data["allocations"]:
            row.update(backing="100", available="100")
        data.update(all_backing="800", all_available="800")
        with self.assertRaisesRegex(AssertionError, "COLD_TARGET_UNPROVEN"):
            verify_owner_bounds(data, owners, 2)
        data, owners = census()
        data["allocations"][0]["settled_charge"] = "71"
        with self.assertRaisesRegex(AssertionError, "PER_OWNER_CHARGE_MISMATCH"):
            verify_owner_bounds(data, owners, 2)
        data, owners = census()
        for row in data["allocations"]:
            row["backing"] = row["available"] = str(int(row["backing"]) - 70)
        data["all_backing"] = data["all_available"] = str(TOTAL_CREDIT_TARGET - 8 * 70)
        self.assertTrue(verify_owner_bounds(data, owners, 2)["verified"])


class ResourceTests(unittest.TestCase):
    def test_group_fallback_rejects_foreign_session_or_reused_leader(self):
        group = {"pgid": 100, "sid": 100, "leader_pid": 100, "leader_start_ticks": "5"}
        for row in ({"pid": 101, "pgid": 100, "sid": 999, "start_ticks": "6", "state": "S"},
                    {"pid": 100, "pgid": 100, "sid": 100, "start_ticks": "99", "state": "S"}):
            sent = []
            with self.assertRaises(AssertionError):
                cleanup_owned_group(dict(group), lambda pgid: [row], lambda *args: sent.append(args),
                                    grace_seconds=0, kill_wait_seconds=0)
            self.assertEqual(sent, [])

    def test_group_fallback_catches_prestate_child_after_outer_KILL_only_in_owned_session(self):
        with tempfile.TemporaryDirectory(prefix="bounded-group-prestate-") as directory:
            root = Path(directory)
            (root / "child.cjs").write_text("const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.env.STATE,'late'),1500);setInterval(()=>{},1000);")
            (root / "outer.cjs").write_text("""const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,[path.join(__dirname,'child.cjs')],{env:process.env,stdio:'ignore'});
fs.writeFileSync(process.env.SPAWNED,String(child.pid));setInterval(()=>{},1000);
""")
            outer = subprocess.Popen(["node", str(root / "outer.cjs")], start_new_session=True,
                                     env={**os.environ, "STATE": str(root / "state"), "SPAWNED": str(root / "spawned")},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            unrelated = subprocess.Popen(["node", "-e", "setInterval(()=>{},1000)"],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            group = None
            try:
                self.assertEqual(os.getpgid(outer.pid), outer.pid)
                self.assertEqual(os.getsid(outer.pid), outer.pid)
                leader = next(row for row in process_group_members(outer.pid) if row["pid"] == outer.pid)
                group = {"pgid": outer.pid, "sid": outer.pid, "leader_pid": outer.pid,
                         "leader_start_ticks": leader["start_ticks"]}
                deadline = time.monotonic() + 5
                while not (root / "spawned").exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue((root / "spawned").exists())
                self.assertFalse((root / "state").exists())
                child_pid = int((root / "spawned").read_text())
                outer.kill()
                outer.wait(timeout=3)
                self.assertTrue(any(row["pid"] == child_pid for row in process_group_members(group["pgid"])))
                result = cleanup_owned_group(group, process_group_members, os.killpg, grace_seconds=2, kill_wait_seconds=1)
                self.assertTrue(result["all_exited"] and result["abnormal_cleanup"])
                self.assertFalse(result["graceful_validation"])
                self.assertTrue(all(action["pgid"] == outer.pid for action in result["actions"]))
                self.assertIsNone(unrelated.poll(), "fallback must not signal any unrelated process group")
                self.assertFalse((root / "state").exists(), "pre-state child must not survive to publish later")
            finally:
                if outer.poll() is None:
                    outer.kill()
                    outer.wait()
                if group:
                    cleanup_owned_group(group, process_group_members, os.killpg, grace_seconds=.1, kill_wait_seconds=1)
                unrelated.terminate()
                unrelated.wait(timeout=3)

    def test_SSE_qualification_retains_every_native_terminal_sample(self):
        raw = {"stream": True, "requests": 2, "success": 2, "status_counts": {"200": 2},
               "execution_modes": {"fast-reserved-max": 2}, "fallback_reasons": {},
               "samples": [{"Status": 200, "Err": "", "Bytes": 100, "Mode": "fast-reserved-max", "Fallback": ""} for _ in range(2)]}
        self.assertTrue(verify_sse_qualification(raw, 2)["verified"])
        for key, value in (("Err", "missing SSE DONE"), ("Status", 503), ("Bytes", 0), ("Mode", "strict")):
            bad = copy.deepcopy(raw)
            bad["samples"][1][key] = value
            with self.assertRaises(AssertionError):
                verify_sse_qualification(bad, 2)

    def test_cleanup_signals_only_original_identity_and_kills_bounded_survivor(self):
        identities = [{"pid": 101, "start_ticks": "11", "role": "primary"},
                      {"pid": 102, "start_ticks": "12", "role": "business"}]
        live = {102: {"available": True, "start_ticks": "12"}}
        now = [0.0]
        sent = []

        def send(pid, sig):
            sent.append((pid, sig))
            if sig == signal.SIGKILL:
                live.pop(pid, None)

        value = cleanup_owned_cluster(lambda: identities, lambda pid: live.get(pid, {"available": False}), send,
                                      monotonic=lambda: now[0], sleep=lambda duration: now.__setitem__(0, now[0] + duration),
                                      grace_seconds=.1, kill_wait_seconds=.1)
        self.assertTrue(value["all_exited"] and value["abnormal_cleanup"])
        self.assertEqual(sent, [(102, signal.SIGTERM), (102, signal.SIGKILL)])
        self.assertFalse(value["graceful_validation"])
        live[102] = {"available": True, "start_ticks": "999"}
        sent.clear()
        value = cleanup_owned_cluster(lambda: identities, lambda pid: live.get(pid, {"available": False}), send,
                                      grace_seconds=0, kill_wait_seconds=0)
        self.assertTrue(value["all_exited"])
        self.assertEqual(sent, [], "a reused unrelated PID must never be signalled")

    def test_result_is_published_only_after_cleanup_and_release_and_never_stale_pass(self):
        for failure in (None, "cleanup", "release"):
            events = []

            def step(name):
                events.append(name)
                if failure == name:
                    raise RuntimeError(name)

            saved = []
            if failure:
                with self.assertRaises(RuntimeError):
                    finalize_run({"passed": True}, lambda: step("cleanup"), lambda: step("release"), saved.append)
                self.assertTrue(saved)
                self.assertTrue(all(not row["passed"] for row in saved))
            else:
                finalize_run({"passed": True}, lambda: step("cleanup"), lambda: step("release"),
                             lambda value: (events.append("save"), saved.append(value)))
                self.assertEqual(events, ["cleanup", "release", "save"])
                self.assertTrue(saved[-1]["passed"])

    def test_early_outer_launcher_TERM_does_not_leave_primary_or_business_orphan(self):
        # A tiny process tree, no sockets/database/Redis or production services.
        # The OUTER process deliberately has no late-startup signal handler.
        with tempfile.TemporaryDirectory(prefix="bounded-outer-term-") as directory:
            root = Path(directory)
            (root / "worker.cjs").write_text("""const fs=require('node:fs');
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.env.DRAINED,'yes');process.exit(0)},100));
process.send({ready:true});setInterval(()=>{},1000);
""")
            (root / "primary.cjs").write_text("""const fs=require('node:fs'),{spawn}=require('node:child_process'),path=require('node:path');
const ticks=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(')').at(-1).trim().split(/\\s+/)[19];
const child=spawn(process.execPath,[path.join(__dirname,'worker.cjs')],{env:process.env,stdio:['ignore','ignore','ignore','ipc']});
process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',()=>process.exit(0));
child.on('message',()=>fs.writeFileSync(process.env.STATE,JSON.stringify([
{pid:process.pid,start_ticks:ticks(process.pid),role:'primary'},
{pid:child.pid,start_ticks:ticks(child.pid),role:'business'}])));
""")
            (root / "outer.cjs").write_text("""const {spawn}=require('node:child_process'),path=require('node:path');
spawn(process.execPath,[path.join(__dirname,'primary.cjs')],{env:process.env,stdio:'ignore'});
setInterval(()=>{},1000);
""")
            state = root / "state.json"
            drained = root / "drained"
            outer = subprocess.Popen(["node", str(root / "outer.cjs")],
                                     env={**os.environ, "STATE": str(state), "DRAINED": str(drained)},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def snapshot(pid):
                try:
                    values = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
                    return {"available": True, "state": values[0], "start_ticks": values[19]}
                except (OSError, IndexError):
                    return {"available": False}

            identities = []
            try:
                deadline = time.monotonic() + 5
                while not state.exists() and time.monotonic() < deadline:
                    self.assertIsNone(outer.poll())
                    time.sleep(.01)
                self.assertTrue(state.exists())
                identities = json.loads(state.read_text())
                outer.terminate()
                self.assertEqual(outer.wait(timeout=3), -signal.SIGTERM)
                self.assertTrue(all(snapshot(row["pid"])["available"] for row in identities))
                proof = cleanup_owned_cluster(lambda: identities, snapshot, os.kill, grace_seconds=3, kill_wait_seconds=1)
                self.assertTrue(proof["all_exited"] and proof["abnormal_cleanup"])
                self.assertEqual(proof["actions"][0]["pid"], identities[0]["pid"])
                self.assertEqual(proof["actions"][0]["signal"], "SIGTERM")
                self.assertEqual(len(proof["actions"]), 1, "primary owns the one child TERM")
                self.assertTrue(drained.exists(), "original business drain was allowed to finish")
            finally:
                if outer.poll() is None:
                    outer.kill()
                    outer.wait()
                if identities:
                    cleanup_owned_cluster(lambda: identities, snapshot, os.kill, grace_seconds=.1, kill_wait_seconds=1)

    def test_native_queue_snapshots_are_per_child_bounded_and_prove_retained_M(self):
        initial, _ = bootstrap()
        values = [{"pid": child["pid"], "slot": child["slot"], "snapshot": {
            "pending": 16, "undurable": 16, "bytes": 10000, "receiptRunning": 4,
            "reconciliationRunning": 0, "running": 4, "undurableLiabilityByCurrency": {"USD": str(524480 * 16)}}}
                  for child in initial["workers"]]
        pending = {child["owner"]: 16 for child in initial["workers"]}
        self.assertTrue(verify_queue_snapshots(values, initial, 2, pending_by_owner=pending)["verified"])
        for key, value in (("pending", 129), ("bytes", 1048577), ("receiptRunning", 5), ("undurable", 15)):
            bad = copy.deepcopy(values)
            bad[1]["snapshot"][key] = value
            with self.assertRaises(AssertionError):
                verify_queue_snapshots(bad, initial, 2, pending_by_owner=pending)
        with self.assertRaises(AssertionError):
            verify_queue_snapshots(values, initial, 2, empty=True)
        for row in values:
            row["snapshot"].update(pending=0, undurable=0, bytes=0, receiptRunning=0, running=0,
                                   undurableLiabilityByCurrency={})
        self.assertTrue(verify_queue_snapshots(values, initial, 2, empty=True)["verified"])

    def test_pending_term_requires_actual_successful_intents_on_both_owners(self):
        initial, _ = bootstrap()
        stopping = copy.deepcopy(initial)
        stopping["phase"] = "stopping"
        before = {"intent_count": 138, "receipt_count": 138, "completed_jobs": 138}
        held = {"intent_count": 170, "receipt_count": 138, "completed_jobs": 138,
                "allocation_backing_minor_units": TOTAL_CREDIT_TARGET}
        owners_before = {"fixture-slot-0": {"intents": 70}, "fixture-slot-1": {"intents": 68}}
        owners_held = {"fixture-slot-0": {"intents": 86}, "fixture-slot-1": {"intents": 84}}
        self.assertTrue(verify_pending_term_observation(before, held, owners_before, owners_held,
                                                       32, initial, stopping)["verified"])
        for key in ("receipt_count", "completed_jobs"):
            bad = dict(held)
            bad[key] += 1
            with self.assertRaises(AssertionError):
                verify_pending_term_observation(before, bad, owners_before, owners_held, 32, initial, stopping)
        skewed = {"fixture-slot-0": {"intents": 102}, "fixture-slot-1": {"intents": 68}}
        with self.assertRaises(AssertionError):
            verify_pending_term_observation(before, held, owners_before, skewed, 32, initial, stopping)
        stopping["workers"][1]["exitCode"] = 0
        with self.assertRaises(AssertionError):
            verify_pending_term_observation(before, held, owners_before, owners_held, 32, initial, stopping)

    def test_sum_all_business_processes_keep_primary_separate_and_guard_pid_reuse(self):
        before = {pid: {"pid": pid, "available": True, "start_ticks": str(pid), "ticks_per_second": 100,
                        "monotonic_ns": 1000000000, "user_ticks": 10, "system_ticks": 5, "resident_bytes": 1024}
                  for pid in (100, 101, 102)}
        after = copy.deepcopy(before)
        for pid, delta in ((100, 2), (101, 30), (102, 40)):
            after[pid].update(monotonic_ns=2000000000, user_ticks=10 + delta, resident_bytes=2048)
        value = aggregate_resources(before, after, 100, [101, 102], 10)
        self.assertTrue(value["valid"])
        self.assertEqual(value["business_cpu_ms"], 700)
        self.assertEqual(value["primary_cpu_ms"], 20)
        self.assertEqual(value["combined_cpu_ms"], 720)
        self.assertEqual(value["business_rss_after_bytes"], 4096)
        after[102]["start_ticks"] = "reused"
        invalid = aggregate_resources(before, after, 100, [101, 102], 10)
        self.assertFalse(invalid["valid"])
        self.assertNotIn("business_cpu_ms", invalid)

    def test_cleanup_requires_every_original_child_no_restart_and_zero_exit(self):
        initial, _ = bootstrap()
        final = copy.deepcopy(initial)
        final.update(phase="exited", allGraceful=True)
        for row in final["workers"]:
            row.update(exitCode=0, signal=None, forcedKill=False)
        outer = {"allExited": True, "allGraceful": True}
        self.assertTrue(verify_cluster_cleanup(final, initial, outer)["verified"])
        for key, value in (("exitCode", 1), ("signal", "SIGKILL"), ("forcedKill", True), ("pid", 9876)):
            bad = copy.deepcopy(final)
            bad["workers"][1][key] = value
            with self.assertRaises(AssertionError):
                verify_cluster_cleanup(bad, initial, outer)
        with self.assertRaises(AssertionError):
            verify_cluster_cleanup(final, initial, {"allExited": True, "allGraceful": False})


if __name__ == "__main__":
    unittest.main()
