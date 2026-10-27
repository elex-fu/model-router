"""Pure checks only; importing this file starts no service or workload."""
import copy
import unittest

from async_receipt_performance_pilot import receipt_append_calls, scene_plan, scene_worker_override, verify_phase_metrics


class PilotTests(unittest.TestCase):
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
