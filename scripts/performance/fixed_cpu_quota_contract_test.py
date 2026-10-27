"""Pure quota tests: synthetic files only; no Docker, ports, PG or workloads."""
import copy
from pathlib import Path
import tempfile
import unittest

from fixed_cpu_quota_contract import (
    ABBA, CGROUP_FILES, CPU_STAT_REQUIRED, FIXED_TOTALS, MEMORY_LIMIT_BYTES,
    cohort_plan, parse_cgroup_snapshot, profile_contract, read_cgroup_snapshot,
    resource_delta, summarize_attempts, validate_workload_result,
)


def raw_snapshot():
    return {
        "cgroup.controllers": "", "cpu.max": "200000 100000\n",
        "cpu.stat": "usage_usec 1000\nuser_usec 700\nsystem_usec 300\nnr_periods 10\nnr_throttled 2\nthrottled_usec 20\n",
        "memory.max": "2147483648\n", "memory.current": "512\n", "memory.peak": "1024\n",
        "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
        "cgroup.procs": "1\n12\n13\n", "cgroup.threads": "1\n12\n13\n14\n15\n",
    }


def sample(**changes):
    return {"MS": 2.5, "TTFB": 1.5, "Status": 200, "Err": "", "Mode": "fast-reserved-max",
            "Fallback": "", **changes}


class ProfileContractTests(unittest.TestCase):
    def test_fixed_aggregate_totals_and_global_money_cap(self):
        for name, cap, concurrency, money in (("c32", 64, 32, 67133440), ("c200", 256, 200, 268533760)):
            contract = profile_contract(name)
            self.assertEqual(contract["httpInFlight"], cap)
            self.assertEqual(contract["concurrency"], concurrency)
            self.assertEqual(contract["creditCapMinorUnits"], money)
            self.assertEqual(contract["maximumMinorUnits"], 524480)
            self.assertEqual(contract["chargeMinorUnits"], 35)
            self.assertEqual({key: contract[key] for key in FIXED_TOTALS}, FIXED_TOTALS)
            self.assertEqual(contract["cpuEquivalents"], 2)
            self.assertEqual(contract["memoryLimitBytes"], MEMORY_LIMIT_BYTES)
        edited = profile_contract("c32")
        edited["databasePoolMax"] = 99
        self.assertEqual(profile_contract("c32")["databasePoolMax"], 16)
        with self.assertRaises(ValueError):
            profile_contract("serial-json")

    def test_finite_abba_for_both_protocols_and_profiles(self):
        plan = cohort_plan()
        self.assertEqual(len(plan), 16)
        self.assertEqual(len({arm["label"] for arm in plan}), 16)
        for start in range(0, len(plan), 4):
            block = plan[start:start + 4]
            self.assertEqual(tuple(arm["arm"] for arm in block), ABBA)
            self.assertEqual([arm["position"] for arm in block], [1, 2, 3, 4])
            self.assertEqual(len({arm["profile"] for arm in block}), 1)
            self.assertEqual(len({arm["protocol"] for arm in block}), 1)
        self.assertEqual(len(cohort_plan("c32", "sse")), 4)
        for duration in (0, 10, 30, 60, 61, True, "30"):
            with self.subTest(duration=duration), self.assertRaises(TypeError):
                cohort_plan(duration_seconds=duration)
        with self.assertRaises(TypeError):
            cohort_plan("c32", "sse", 60)
        for profiles, protocols in (([], ["json"]), (["c32", "c32"], ["json"]),
                                    (["c32"], ["xml"]), (["c32"], ["json", "json"])):
            with self.assertRaises(ValueError):
                cohort_plan(profiles, protocols)

    def test_exact_workload_and_warm_drain_quiet_contracts(self):
        for entry in cohort_plan():
            contract = profile_contract(entry["profile"])
            expected = (60, None, None) if entry["profile"] == "c32" else (None, 10000, 10000)
            self.assertEqual(tuple(entry[key] for key in ("timedSeconds", "timedRequests", "maxAttempts")), expected)
            self.assertEqual(tuple(contract[key] for key in ("timedSeconds", "timedRequests", "maxAttempts")), expected)
            self.assertEqual(entry["warmup"], {
                "bootstrap": {"protocol": "json", "requests": 10, "concurrency": 1},
                "matched": {"protocol": entry["protocol"], "requests": 128, "concurrency": 32},
                "financialDrain": True, "actualTpmDrain": True, "nativeQueueZero": True,
                "quietMilliseconds": 1000,
            })
        plan = cohort_plan("c32", "json")
        plan[0]["warmup"]["bootstrap"]["requests"] = 1
        self.assertEqual(plan[1]["warmup"]["bootstrap"]["requests"], 10)


class FixedWorkloadTests(unittest.TestCase):
    @staticmethod
    def result(profile="c32", protocol="json", count=None, duration=None):
        count = count if count is not None else (5000 if profile == "c32" else 10000)
        duration = duration if duration is not None else (60.1 if profile == "c32" else 25)
        return {
            "stream": protocol == "sse", "concurrency": 32 if profile == "c32" else 200,
            "requests": count, "samples": [sample()] * count, "duration_s": duration, "deadline_exceeded": False,
            "request_limit": 0 if profile == "c32" else 10000, "admission_duration_s": 60 if profile == "c32" else 0,
        }

    def test_c32_fixed_sixty_seconds_without_a_count_cap(self):
        entry = cohort_plan("c32", "json")[0]
        proof = validate_workload_result(entry, self.result())
        self.assertTrue(proof["workloadComplete"])
        self.assertEqual(proof["timedSeconds"], 60)
        self.assertFalse(proof["performanceAcceptance"])
        for count in (99999, 100000, 100001):
            validate_workload_result(entry, self.result(count=count, duration=60))
        for raw in (self.result(duration=30), self.result(duration=59.999)):
            with self.assertRaises(ValueError):
                validate_workload_result(entry, raw)

    def test_c200_fixed_ten_thousand_attempts_never_a_duration_slice(self):
        entry = cohort_plan("c200", "sse")[0]
        raw = self.result("c200", "sse")
        raw["samples"][-1] = sample(Status=429, Err="HTTP 429: capacity", Mode="")
        proof = validate_workload_result(entry, raw)
        self.assertTrue(proof["workloadComplete"], "errors stay in the fixed workload denominator")
        self.assertEqual(proof["attempts"], 10000)
        self.assertIsNone(proof["timedSeconds"])
        self.assertEqual(proof["timedRequests"], 10000)
        for count in (1, 9999, 10001):
            with self.subTest(count=count), self.assertRaises(ValueError):
                validate_workload_result(entry, self.result("c200", "sse", count=count))

    def test_driver_deadline_or_invalid_duration_cannot_complete_workload(self):
        for profile in ("c32", "c200"):
            entry = cohort_plan(profile, "json")[0]
            for duration in (0, -1, float("nan"), float("inf"), True, "60", 120, 120.01):
                with self.subTest(profile=profile, duration=duration), self.assertRaises(ValueError):
                    validate_workload_result(entry, self.result(profile, duration=duration))
            for flag in (True, 1, "false"):
                with self.assertRaises(ValueError):
                    validate_workload_result(entry, {**self.result(profile), "deadline_exceeded": flag})

    def test_plan_protocol_concurrency_and_raw_counts_must_match(self):
        entry = cohort_plan("c32", "json")[0]
        raw = self.result()
        for change in ({"requests": 4999}, {"requests": True}, {"samples": None},
                       {"samples": []}, {"request_limit": 100000}, {"admission_duration_s": 30}, {"concurrency": 1}, {"stream": True}, {"stream": 0}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_workload_result(entry, {**raw, **change})
        for change in ({"timedSeconds": 30}, {"timedSeconds": 60.0}, {"timedRequests": 5000},
                       {"maxAttempts": 200000}, {"protocol": "xml"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_workload_result({**entry, **change}, raw)


class CgroupProofTests(unittest.TestCase):
    def test_full_cgroup_snapshot_read_without_writes(self):
        raw = raw_snapshot()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, contents in raw.items():
                (root / name).write_text(contents)
            before = {name: (root / name).read_bytes() for name in CGROUP_FILES}
            proof = read_cgroup_snapshot(root)
            self.assertEqual(proof["raw"], raw)
            self.assertEqual(proof["cpuEquivalents"], 2)
            self.assertEqual(proof["memoryLimitBytes"], MEMORY_LIMIT_BYTES)
            self.assertEqual(proof["processIds"], [1, 12, 13])
            self.assertEqual(proof["threadIds"], [1, 12, 13, 14, 15])
            self.assertEqual(proof["cpuStat"]["throttled_usec"], 20)
            self.assertEqual(before, {name: (root / name).read_bytes() for name in CGROUP_FILES})

    def test_missing_v2_quota_or_measurement_file_cannot_time(self):
        for filename in CGROUP_FILES:
            raw = raw_snapshot()
            del raw[filename]
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                parse_cgroup_snapshot(raw)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            read_cgroup_snapshot(directory)

    def test_unlimited_affinity_and_other_quotas_are_not_two_cpu_proof(self):
        for value in ("max 100000", "100000 100000", "400000 100000", "200000 0", "-1 100000",
                      "200001 100000", "2", "200000 100000 extra", "NaN 100000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_cgroup_snapshot({**raw_snapshot(), "cpu.max": value})
        self.assertEqual(parse_cgroup_snapshot({**raw_snapshot(), "cpu.max": "100000 50000"})["cpuEquivalents"], 2)
        for value in ("max", "1073741824", "2147483649", "-1", "NaN"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_cgroup_snapshot({**raw_snapshot(), "memory.max": value})

    def test_missing_duplicate_or_invalid_counters_fail_closed(self):
        for name in CPU_STAT_REQUIRED:
            raw = raw_snapshot()
            raw["cpu.stat"] = "\n".join(line for line in raw["cpu.stat"].splitlines() if not line.startswith(name + " "))
            with self.subTest(name=name), self.assertRaises(ValueError):
                parse_cgroup_snapshot(raw)
        for key, value in (("cpu.stat", raw_snapshot()["cpu.stat"] + "usage_usec 10\n"),
                           ("cpu.stat", raw_snapshot()["cpu.stat"].replace("usage_usec 1000", "usage_usec -1")),
                           ("memory.events", "oom_kill 0\n"), ("memory.current", "-1"),
                           ("memory.peak", "NaN"), ("cgroup.procs", "0\n"), ("cgroup.threads", "not-pid\n")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                parse_cgroup_snapshot({**raw_snapshot(), key: value})

    def test_resource_deltas_include_primary_and_native_threads_and_throttling(self):
        before = parse_cgroup_snapshot(raw_snapshot())
        raw = raw_snapshot()
        raw["cpu.stat"] = "usage_usec 12000\nuser_usec 8000\nsystem_usec 4000\nnr_periods 50\nnr_throttled 12\nthrottled_usec 3020\n"
        raw["memory.current"] = "2048\n"
        raw["memory.peak"] = "4096\n"
        raw["memory.events"] = raw["memory.events"].replace("oom 0", "oom 1").replace("oom_kill 0", "oom_kill 1")
        after = parse_cgroup_snapshot(raw)
        delta = resource_delta(before, after)
        self.assertEqual(delta["cpuMilliseconds"], 11)
        self.assertEqual(delta["throttledMilliseconds"], 3)
        self.assertEqual(delta["throttledPeriods"], 10)
        self.assertEqual(delta["periods"], 40)
        self.assertEqual(delta["memoryPeakLifetimeAfterBytes"], 4096)
        self.assertIn("not interval-only", delta["memoryPeakScope"])
        self.assertTrue(delta["oomObserved"])
        self.assertFalse(delta["performanceAcceptance"])

    def test_changed_policy_counter_reset_or_missing_delta_not_silently_accepted(self):
        before = parse_cgroup_snapshot(raw_snapshot())
        for change in ({"cpu.max": "100000 50000\n"}, {"memory.peak": "100\n"},
                       {"cpu.stat": raw_snapshot()["cpu.stat"].replace("usage_usec 1000", "usage_usec 999")},
                       {"cpu.stat": raw_snapshot()["cpu.stat"] + "nr_bursts 0\n"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                resource_delta(before, parse_cgroup_snapshot({**raw_snapshot(), **change}))
        altered = copy.deepcopy(before)
        altered["cpuEquivalents"] = 99
        self.assertEqual(resource_delta(altered, before)["cpuMilliseconds"], 0, "reparse raw proof, not claimed fields")


class AttemptSummaryTests(unittest.TestCase):
    def test_overload_network_error_and_longest_tail_remain_in_denominator(self):
        rows = [sample() for _ in range(997)] + [
            sample(MS=200, Status=429, Err="capacity", Mode=""),
            sample(MS=300, Status=0, Err="connection reset", Mode=""), sample(MS=9999),
        ]
        summary = summarize_attempts(rows)
        self.assertEqual(summary["attempts"], 1000)
        self.assertEqual(summary["successes"], 998)
        self.assertEqual(summary["errorsOrRejections"], 2)
        self.assertEqual(summary["excludedAttempts"], 0)
        self.assertEqual(summary["statusCounts"], {"200": 998, "429": 1, "0": 1})
        self.assertEqual(summary["rawErrorCounts"], {"capacity": 1, "connection reset": 1})
        self.assertEqual(summary["allAttemptLatencyMs"]["p999"], 300)
        self.assertEqual(summary["allAttemptLatencyMs"]["max"], 9999)
        self.assertEqual(summary["successfulLatencyMs"]["p999"], 9999)
        self.assertEqual(summary["successfulLatencyMs"]["max"], 9999)
        self.assertFalse(summary["zeroErrorGatePassed"])
        self.assertFalse(summary["performanceAcceptance"])

    def test_smoke_or_all_success_never_implies_performance_acceptance(self):
        summary = summarize_attempts([sample()])
        self.assertTrue(summary["zeroErrorGatePassed"])
        self.assertFalse(summary["performanceAcceptance"])
        for change in ({"Mode": "legacy"}, {"Fallback": "slow"}, {"Err": "invalid JSON completion"}):
            summary = summarize_attempts([sample(**change)])
            self.assertEqual(summary["successes"], 0)
            self.assertEqual(summary["successfulLatencyMs"]["count"], 0)
            self.assertIsNone(summary["successfulLatencyMs"]["p99"])

    def test_missing_samples_or_invalid_numbers_never_hide_measurement_gaps(self):
        for rows in ([], None, {}, [sample(MS=float("nan"))], [sample(MS=float("inf"))],
                     [sample(MS=-1)], [sample(Status=True)], [sample(Status=600)], [sample(Err=None)],
                     [sample(TTFB=-1)], [sample(MS=True)]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                summarize_attempts(rows)


if __name__ == "__main__":
    unittest.main()
