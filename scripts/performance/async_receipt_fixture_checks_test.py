"""Pure assertion tests; no HTTP/PostgreSQL/Redis services are started."""
import unittest
from async_receipt_fixture_checks import (
    assert_completed_http, assert_receipt_not_written, assert_receipt_durable_worker_paused,
)


def census():
    return {
        "allocation_conservation_errors": 0, "receipt_release_integrity_errors": 0,
        "negative_remaining_liability_count": 0, "ledger_balance_errors": 0,
        "allocation_backing_minor_units": 67133440, "allocation_available_minor_units": 67133440,
        "allocation_unresolved_liability_minor_units": 0, "allocation_unresolved_max_minor_units": 0,
        "intent_count": 0, "receipt_count": 0, "receipt_release_count": 0,
        "settlement_ledger_count": 0, "settlement_ledger_minor_units": 0,
        "wallet_posted_minor_units": 100000000000, "pending_jobs": 0,
        "blocked_jobs": 0, "completed_jobs": 0, "unresolved_intents": 0,
        "receipt_released_minor_units": 0,
    }


class ReceiptAssertionTests(unittest.TestCase):
    def test_undurable_receipt_keeps_full_M(self):
        before = census(); held = dict(before, intent_count=1, unresolved_intents=1,
            allocation_unresolved_max_minor_units=524480, allocation_unresolved_liability_minor_units=524480,
            allocation_available_minor_units=67133440 - 524480)
        assert_receipt_not_written(before, held)
        for key in ("receipt_count", "receipt_release_count", "settlement_ledger_count"):
            with self.assertRaises(AssertionError): assert_receipt_not_written(before, dict(held, **{key: 1}))
        # Even an arithmetically balanced premature compaction is forbidden.
        with self.assertRaises(AssertionError):
            assert_receipt_not_written(before, dict(held, allocation_unresolved_liability_minor_units=35,
                allocation_available_minor_units=67133440 - 35))

    def test_durable_receipt_pending_ledger_keeps_actual_charge(self):
        before = census(); held = dict(before, intent_count=1, receipt_count=1, receipt_release_count=1,
            pending_jobs=1, unresolved_intents=1, allocation_unresolved_max_minor_units=524480,
            allocation_unresolved_liability_minor_units=35, allocation_available_minor_units=67133440 - 35,
            receipt_released_minor_units=524445)
        assert_receipt_durable_worker_paused(before, held)
        with self.assertRaises(AssertionError):
            assert_receipt_durable_worker_paused(before, dict(held, wallet_posted_minor_units=99999999965))

    def test_actual_protocol_completion_not_status_alone(self):
        good = {"status": 200, "complete": True, "mode": "fast-reserved-max", "body": '{"choices":[{}]}'}
        assert_completed_http(good, False)
        with self.assertRaises(AssertionError): assert_completed_http(dict(good, complete=False), False)
        with self.assertRaises(AssertionError): assert_completed_http(dict(good, body="data: partial\n\n"), True)
        assert_completed_http(dict(good, body="data: [DONE]\n\n"), True)


if __name__ == "__main__": unittest.main()
