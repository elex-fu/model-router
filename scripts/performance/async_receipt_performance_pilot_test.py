"""Pure checks only; importing this file starts no service or workload."""
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from async_receipt_performance_pilot import (
    OBSERVER_COST_PLAN, queue_metrics_snapshot, receipt_append_calls,
    router_environment, scene_metrics_enabled, scene_plan, scene_worker_override,
    unavailable_queue_telemetry, verify_phase_metrics, verify_tpm_reconciled,
    verify_lease_reconciliation,
)


class PilotTests(unittest.TestCase):
    def test_all_retained_lease_records_reconciled_or_original_bucket_expired(self):
        census = {"records": 5, "settled_actual": 4, "expired_pending": 1, "unresolved": 0}
        self.assertTrue(verify_lease_reconciliation(census, 10)["verified"])
        with self.assertRaises(AssertionError):
            verify_lease_reconciliation(dict(census, unresolved=1), 10)
        with self.assertRaises(AssertionError):
            verify_lease_reconciliation(dict(census, expired_pending=0), 10)
        with self.assertRaises(AssertionError):
            verify_lease_reconciliation(dict(census, records=0, settled_actual=0, expired_pending=0), 10)
        with self.assertRaises(AssertionError):
            verify_lease_reconciliation(census, 4)

    def test_observer_cost_plan_is_minimal_matched_on_off_workers8(self):
        plan = scene_plan(OBSERVER_COST_PLAN)
        self.assertEqual(plan, [
            ("observer-on-c32-workers8", "memory-queue", 1000000, 32, False, 60),
            ("observer-off-c32-workers8", "memory-queue", 1000000, 32, False, 60)])
        self.assertEqual([scene_worker_override(OBSERVER_COST_PLAN, row[0]) for row in plan], [8, 8])
        self.assertEqual([scene_metrics_enabled(OBSERVER_COST_PLAN, row[0]) for row in plan], [True, False])
        for old in ("pilot-six", "phase-workers2-30s", "workers4-8-c32-60s"):
            self.assertTrue(all(scene_metrics_enabled(old, row[0]) for row in scene_plan(old)))
        with self.assertRaises(KeyError):
            scene_metrics_enabled(OBSERVER_COST_PLAN, "observer-unknown")

    def test_on_off_environment_changes_only_metrics_flag_and_removes_stale_queue_caps(self):
        original = {"MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES": "10000",
                    "MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES": "100000000",
                    "PAIR_TRANCHE_MINOR_UNITS": "auto", "PAIR_PREPARED": "off",
                    "PAIR_CONCURRENCY_CAP": "64", "UNCHANGED": "keep"}
        on = router_environment(original, "memory-queue", 8, True)
        off = router_environment(original, "memory-queue", 8, False)
        self.assertEqual({key for key in on if on[key] != off[key]}, {"PAIR_ASYNC_METRICS"})
        self.assertEqual(off["PAIR_ASYNC_METRICS"], "0")
        self.assertEqual(on["PAIR_ASYNC_FAULTS"], off["PAIR_ASYNC_FAULTS"])
        self.assertEqual(off["PAIR_ASYNC_FAULTS"], "0")
        self.assertEqual({key: value for key, value in off.items() if key.startswith("MODEL_ROUTER_FAST_RECEIPT_")},
                         {"MODEL_ROUTER_FAST_RECEIPT_MODE": "memory-queue", "MODEL_ROUTER_FAST_RECEIPT_WORKERS": "8"})
        self.assertEqual(off["PAIR_TRANCHE_MINOR_UNITS"], "auto")
        self.assertEqual(off["PAIR_CONCURRENCY_CAP"], "64")
        self.assertIn("MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES", original)

    def test_off_metrics_are_unknown_and_send_no_signals_or_file_probes(self):
        # No out/info fields: even accessing a snapshot path would fail.
        fixture = SimpleNamespace(metrics_enabled=False)
        with patch("async_receipt_performance_pilot.os.kill") as kill:
            for reset in (False, True):
                self.assertEqual(queue_metrics_snapshot(fixture, reset), unavailable_queue_telemetry())
            kill.assert_not_called()
        value = unavailable_queue_telemetry()
        self.assertFalse(value["available"])
        for key in ("observations", "counterDeltas", "observedPeaks", "receiptAckLag", "queue_empty_verified"):
            self.assertIsNone(value[key])
        self.assertFalse(value["phaseMetrics"]["available"])
        self.assertIsNone(value["phaseMetrics"]["groups"])

    def test_tpm_drain_requires_actual_usage_each_retained_bucket_and_all_slots_empty(self):
        base = {"live_slots": 0, "reserved_requests": 5, "reserved_token_units": 75,
                "buckets": {"0": [2, 30], "1": [3, 45]}}
        counters = {scope: copy.deepcopy(base) for scope in ("tenant", "project", "key", "account")}
        proof = verify_tpm_reconciled(counters, 10)
        self.assertTrue(proof["verified"])
        for scope in counters:
            bad = copy.deepcopy(counters); bad[scope]["live_slots"] = 1
            with self.assertRaises(AssertionError): verify_tpm_reconciled(bad, 10)
        for scope in ("tenant", "project", "key"):
            bad = copy.deepcopy(counters); bad[scope]["reserved_token_units"] = 5 * 262208
            with self.assertRaises(AssertionError): verify_tpm_reconciled(bad, 10)
            bad = copy.deepcopy(counters); bad[scope]["buckets"] = {"0": [2, 31], "1": [3, 44]}
            with self.assertRaises(AssertionError): verify_tpm_reconciled(bad, 10)
            bad = copy.deepcopy(counters); bad[scope].update(reserved_requests=0, reserved_token_units=0, buckets={})
            with self.assertRaises(AssertionError): verify_tpm_reconciled(bad, 10)
        with self.assertRaises(AssertionError): verify_tpm_reconciled(counters, 4)

    def test_tpm_uses_redis_time_original_bucket_expiry_not_lifetime_success_total(self):
        base = {"live_slots": 0, "reserved_requests": 5, "reserved_token_units": 2 * 262208 + 45,
                "buckets": {"100": [2, 2 * 262208], "140": [3, 45]}}
        counters = {scope: copy.deepcopy(base) for scope in ("tenant", "project", "key", "account")}
        proof = verify_tpm_reconciled(counters, 10, 200000)
        self.assertEqual(proof["bucket_proof"]["key"],
                         {"live_requests": 3, "live_actual_tokens": 45, "retained_but_expired_buckets": 1})
        with self.assertRaises(AssertionError): verify_tpm_reconciled(counters, 10, 160000)
        with self.assertRaises(AssertionError): verify_tpm_reconciled(counters, 10, 201000)

    def test_fixed_scope_preserves_original_six_and_adds_only_one_diagnostic(self):
        self.assertEqual(len(scene_plan("pilot-six")), 6)
        self.assertEqual(scene_plan("pilot-six")[-1], ("sustained-c32", "memory-queue", 1000000, 32, False, 60))
        self.assertEqual(scene_plan("phase-workers2-30s"), [("phase-c32-workers2", "memory-queue", 1000000, 32, False, 30)])
        with self.assertRaises(ValueError):
            scene_plan("workers8")

    def test_receipt_classifier_supports_pgss_comment_removal_without_counting_other_sql(self):
        rows = [
            {"query": "/* fast-journal:append-receipt */ WITH receipt AS (", "calls": 1},
            {"query": "WITH receipt AS (\n INSERT INTO saas_fast_gateway_receipts (intent_id)", "calls": 7},
            {"query": "SELECT * FROM saas_fast_gateway_receipts", "calls": 100},
            {"query": "WITH receipt AS ( SELECT count(*) FROM saas_fast_gateway_receipts)", "calls": 100},
        ]
        self.assertEqual(receipt_append_calls(rows), 8)

    def test_worker_comparison_is_exactly_three_scenes_with_only_both_phase_worker_override(self):
        plan = scene_plan("workers4-8-c32-60s")
        self.assertEqual(plan, [
            ("sustained-c32", "durable", 1000000, 32, False, 60),
            ("sustained-c32-workers4", "memory-queue", 1000000, 32, False, 60),
            ("sustained-c32-workers8", "memory-queue", 1000000, 32, False, 60)])
        self.assertEqual([scene_worker_override("workers4-8-c32-60s", row[0]) for row in plan], [None, 4, 8])
        self.assertIsNone(scene_worker_override("pilot-six", "sustained-c32"))
        self.assertIsNone(scene_worker_override("phase-workers2-30s", "phase-c32-workers2"))
        with self.assertRaises(KeyError):
            scene_worker_override("workers4-8-c32-60s", "sustained-c32-workers16")

    def test_settled_attempt_conservation_and_missing_observation_rejects(self):
        expected = {"receiptQueueWait": 5, "receiptAwait": 5,
                    "reconciliationQueueWait": 3, "reconciliationAwait": 3, "residence": 3}
        telemetry = {"counterDeltas": {"durable": 3, "retries": 1, "conflicts": 1,
                     "completed": 3, "reconciliationRetries": 1},
                     "phaseMetrics": {"available": True, "completedWithoutReconciliationDelta": 1,
                     "groups": {phase: {"counterCountDelta": count, "observedCount": count,
                         "buckets": [0, count], "missedTransitions": 0, "counterResets": 0,
                         "counterSumMsDelta": 7.1, "observedSumMs": 7.1}
                         for phase, count in expected.items()}}}
        result = verify_phase_metrics(telemetry)
        self.assertEqual(result["settled_receipt_attempts"], 5)
        self.assertEqual(result["settled_reconciliation_attempts"], 3)
        bad = copy.deepcopy(telemetry)
        bad["phaseMetrics"]["groups"]["receiptAwait"]["missedTransitions"] = 1
        with self.assertRaises(AssertionError):
            verify_phase_metrics(bad)
        bad = copy.deepcopy(telemetry); bad["phaseMetrics"]["available"] = False
        with self.assertRaises(AssertionError):
            verify_phase_metrics(bad)


if __name__ == "__main__":
    unittest.main()
