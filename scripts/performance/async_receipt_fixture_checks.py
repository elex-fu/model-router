"""Small, reusable assertions for the owned actual-HTTP async receipt fixture.

Importing this module starts no services. The caller must supply an already
started, frozen native fixture and explicit mode, and own cleanup/quiet guards.
These instrumented functional probes are never performance samples.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time


def assert_conservation(census):
    for key in ("allocation_conservation_errors", "receipt_release_integrity_errors",
                "negative_remaining_liability_count", "ledger_balance_errors"):
        assert census[key] == 0, (key, census[key])
    assert census["allocation_backing_minor_units"] == (
        census["allocation_available_minor_units"] + census["allocation_unresolved_liability_minor_units"]
    ), "backing must equal available plus remaining liability H"


def assert_receipt_not_written(before, held, maximum=524480, count=1):
    assert_conservation(held)
    assert held["intent_count"] - before["intent_count"] == count
    for key in ("receipt_count", "receipt_release_count", "settlement_ledger_count",
                "settlement_ledger_minor_units", "wallet_posted_minor_units", "pending_jobs",
                "blocked_jobs", "completed_jobs"):
        assert held[key] == before[key], (key, before[key], held[key])
    assert held["unresolved_intents"] - before["unresolved_intents"] == count
    assert held["allocation_unresolved_max_minor_units"] - before["allocation_unresolved_max_minor_units"] == count * maximum
    assert held["allocation_unresolved_liability_minor_units"] - before["allocation_unresolved_liability_minor_units"] == count * maximum
    assert held["allocation_backing_minor_units"] == before["allocation_backing_minor_units"]
    assert before["allocation_available_minor_units"] - held["allocation_available_minor_units"] == count * maximum


def assert_receipt_durable_worker_paused(before, held, maximum=524480, charge=35, count=1):
    assert_conservation(held)
    for key in ("intent_count", "receipt_count", "receipt_release_count", "pending_jobs", "unresolved_intents"):
        assert held[key] - before[key] == count, (key, before[key], held[key])
    for key in ("completed_jobs", "settlement_ledger_count", "settlement_ledger_minor_units", "wallet_posted_minor_units"):
        assert held[key] == before[key], (key, before[key], held[key])
    assert held["allocation_unresolved_max_minor_units"] - before["allocation_unresolved_max_minor_units"] == count * maximum
    assert held["allocation_unresolved_liability_minor_units"] - before["allocation_unresolved_liability_minor_units"] == count * charge
    assert held["receipt_released_minor_units"] - before["receipt_released_minor_units"] == count * (maximum - charge)
    assert held["allocation_backing_minor_units"] == before["allocation_backing_minor_units"]


def assert_completed_http(result, stream):
    assert result["status"] == 200 and result["complete"] and result["mode"] == "fast-reserved-max", result
    if stream:
        assert "data: [DONE]" in result["body"], "SSE terminal must actually be observed"
    else:
        assert json.loads(result["body"])["choices"], "complete JSON result required"


def wait_until(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError("ASYNC_RECEIPT_FIXTURE_BOUNDARY_TIMEOUT")
        time.sleep(.01)


def receipt_before_sql_case(evaluation, marker_directory, *, mode, stream=False, capture_redis=None):
    """Prove EOF/receipt ordering using the committed pre-SQL fault observer.

    Does not start/restart a gateway or set its mode. The caller must assert the
    effective production configuration before invoking this function.
    """
    assert mode in ("durable", "memory-queue")
    directory = Path(marker_directory)
    hold = directory / "receipt-before-sql.hold"
    waiting = directory / "receipt-before-sql.waiting"
    assert not hold.exists(), "never take over an existing fault"
    waiting.unlink(missing_ok=True)
    before = evaluation.census()
    assert_conservation(before)
    assert before["pending_jobs"] == before["blocked_jobs"] == before["unresolved_intents"] == 0, "start from full drain"
    before_mock = evaluation.metrics()
    before_redis = capture_redis(evaluation) if capture_redis else None
    hold.write_text("hold\n")
    pool = ThreadPoolExecutor(max_workers=1)
    result = None
    try:
        pending = pool.submit(evaluation.request, stream=stream)
        wait_until(waiting.exists)
        if mode == "memory-queue":
            result = pending.result(timeout=3)
            assert_completed_http(result, stream)
        else:
            # External read-to-EOF future must remain incomplete, not merely
            # Node's response finish or headers event.
            time.sleep(.15)
            assert not pending.done(), "durable control completed before receipt SQL"
        held = evaluation.census()
        assert_receipt_not_written(before, held)
        held_redis = None
        if capture_redis and mode == "memory-queue":
            def slots_released():
                state = capture_redis(evaluation)
                return state if all(state[scope]["live_slots"] == 0 for scope in ("tenant", "project", "key", "account")) else None
            held_redis = wait_until(slots_released, timeout=3)
            for scope in ("tenant", "project", "key"):
                assert held_redis[scope]["reserved_requests"] - before_redis[scope]["reserved_requests"] == 1
                assert held_redis[scope]["reserved_token_units"] - before_redis[scope]["reserved_token_units"] == 262208
        proof = {
            "not_performance_acceptance": True, "mode": mode, "stream": stream,
            "fault": "receipt SQL held before invocation; real result not fabricated",
            "external_EOF_while_receipt_SQL_held": result is not None,
            "before": before, "held": held, "held_redis": held_redis,
            "mock_send_delta_while_held": evaluation.metrics()["received"] - before_mock["received"],
        }
        assert proof["mock_send_delta_while_held"] == 1
        evaluation.save(f"{mode}-{'sse' if stream else 'json'}-receipt-pre-sql-held", proof)
    finally:
        hold.unlink(missing_ok=True)
        pool.shutdown(wait=True, cancel_futures=False)
    result = pending.result(timeout=10)
    assert_completed_http(result, stream)
    evaluation.total += 1
    evaluation.drain(f"{mode}-{'sse' if stream else 'json'}-receipt-resumed", evaluation.total)
    assert evaluation.metrics()["received"] - before_mock["received"] == 1
    return proof
