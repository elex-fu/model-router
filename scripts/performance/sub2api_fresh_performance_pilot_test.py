"""Pure fixture/accounting/lifecycle tests; no services, workloads or binaries."""
import copy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import sub2api_fresh_performance_pilot as pilot


def census(count=138):
    cost = pilot.FEE * count
    return {"usage_rows": count, "dedup_rows": count, "usage_cost": str(cost),
            "balance": str(Decimal("1000000") - cost), "quota_used": str(cost),
            "window_5h": str(cost), "input_tokens": count * 10, "output_tokens": count * 5}


def raw(count=2):
    return {"requests": count, "success": count, "status_counts": {"200": count}, "errors": {},
            "fallback_reasons": {}, "stream": False,
            "samples": [{"Status": 200, "Err": "", "Bytes": 123, "Mode": "", "Fallback": "",
                         "MS": 12, "TTFB": 11} for _ in range(count)],
            "started_at_unix_ns": "1000000000", "completed_at_unix_ns": "61000000000", "duration_s": 60}


def metrics(count=0):
    return {"received": count, "completed": count, "json": count, "sse": 0,
            "unexpected_paths": 0, "bad_requests": 0, "write_errors": 0, "in_flight": 0,
            "inference_connections": 2, "inference_tls_full": 2, "inference_tls_resumed": 0, "delay_ms": 5}


def process():
    return {"available": True, "pid": 42, "start_ticks": "7", "ticks_per_second": 100,
            "user_ticks": 10, "system_ticks": 20, "monotonic_ns": 1000000000,
            "resident_bytes": 10000}


class ProfileTests(unittest.TestCase):
    def test_default_c32_profile_is_unchanged(self):
        self.assertEqual(pilot.profile_config(), {"count": 1000000, "concurrency": 32, "duration": 60, "cap": 64})
        self.assertEqual(pilot.profile_config(), pilot.profile_config("c32"))
        self.assertEqual(pilot.WARM_SUCCESSES, 138)

    def test_c200_is_finite_10000_with_256_seed_caps(self):
        self.assertEqual(pilot.profile_config("c200"), {"count": 10000, "concurrency": 200, "duration": 0, "cap": 256})
        self.assertTrue(all(pilot.financial_checks(census(10138), 10138).values()))

    def test_profiles_are_only_the_two_supported_cases_and_return_independent_values(self):
        for name in ("serial", "c201", "", None):
            with self.assertRaisesRegex(AssertionError, "PROFILE"):
                pilot.profile_config(name)
        changed = pilot.profile_config("c200")
        changed["cap"] = 64
        self.assertEqual(pilot.profile_config("c200")["cap"], 256)

    def test_c32_keeps_original_duration_and_concurrency_gate(self):
        profile = pilot.profile_config()
        value = {"requests": 10000, "concurrency": 32, "duration_s": 60.1}
        pilot.verify_profile(value, profile)
        for change in ({"concurrency": 200}, {"duration_s": 59.9}, {"duration_s": 120.1}, {"duration_s": float("nan")}):
            with self.assertRaises(AssertionError):
                pilot.verify_profile({**value, **change}, profile)

    def test_c200_requires_every_planned_attempt_without_sustained_duration_gate(self):
        profile = pilot.profile_config("c200")
        value = {"requests": 10000, "concurrency": 200, "duration_s": 20}
        pilot.verify_profile(value, profile)
        for change in ({"requests": 9999}, {"requests": 10001}, {"concurrency": 32}, {"duration_s": 0}, {"duration_s": float("inf")}):
            with self.assertRaises(AssertionError):
                pilot.verify_profile({**value, **change}, profile)

    def test_c200_all_attempts_and_cold_tail_survive_even_when_http_gate_fails(self):
        value = raw(10000)
        value["samples"][0]["MS"] = 15000
        self.assertEqual(pilot.verify_raw(value)["attempts"], 10000)
        value["success"] -= 1
        value["status_counts"] = {"200": 9999, "429": 1}
        value["samples"][0]["Status"] = 429
        distribution = pilot.distribution([row["MS"] for row in value["samples"]])
        self.assertEqual(distribution["count"], 10000)
        self.assertEqual(distribution["max"], 15000)
        with self.assertRaisesRegex(AssertionError, "HTTP_FAILURE"):
            pilot.verify_raw(value)


class PinAndSafetyTests(unittest.TestCase):
    def test_pins_are_complete_sha256_and_sub_revision_is_fixed(self):
        self.assertEqual(pilot.SUB_COMMIT, "ba81c7fd758e425d67f856d601147ef0c5263d3f")
        for digest in [pilot.SUB_SHA256, pilot.CLIENT_SHA256, pilot.MOCK_SHA256, pilot.TEMPLATE_SHA256, pilot.PRICING_SHA256,
                       *pilot.HARNESS_SHA256.values()]:
            self.assertRegex(digest, r"^[a-f0-9]{64}$")

    def test_hash_reads_bytes_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "binary"
            file.write_bytes(b"existing pinned bytes")
            expected = hashlib.sha256(file.read_bytes()).hexdigest()
            self.assertEqual(pilot.verify_hash(file, expected), expected)
            file.write_bytes(b"changed")
            with self.assertRaisesRegex(AssertionError, "PIN_MISMATCH"):
                pilot.verify_hash(file, expected)

    def test_sub_environment_strips_configuration_and_runtime_injections(self):
        original = {"TZ": "UTC", "PATH": "/tools", "DATA_DIR": "/fixture", "SSL_CERT_FILE": "/ca",
                    "HOME": "/home", "DATABASE_MAX_OPEN_CONNS": "999", "GOMAXPROCS": "1",
                    "LD_PRELOAD": "inject.so", "GODEBUG": "trace", "NODE_OPTIONS": "--cpu-prof"}
        clean = pilot.sub_environment(original)
        self.assertEqual(set(clean), {"TZ", "PATH", "DATA_DIR", "SSL_CERT_FILE", "HOME"})
        self.assertEqual(original["DATABASE_MAX_OPEN_CONNS"], "999")
        for key in ("TZ", "DATA_DIR", "SSL_CERT_FILE"):
            with self.assertRaises(AssertionError):
                pilot.sub_environment({k: v for k, v in original.items() if k != key})

    def test_without_execute_cannot_hash_import_fixture_or_start_services(self):
        with patch.object(pilot, "revision") as revision, patch.object(pilot, "verify_hash") as verify:
            with self.assertRaises(SystemExit) as error:
                pilot.main(["--harness", "/unavailable", "--source", "/source", "--expected-source", "abc",
                            "--sub-source", "/sub", "--client", "/client", "--generation", "1",
                            "--label", "sub2api-fresh-pilot-test"])
            self.assertEqual(error.exception.code, 2)
            revision.assert_not_called()
            verify.assert_not_called()

    def test_shared_environment_rejects_runtime_sql_and_recovery_overrides(self):
        self.assertTrue(pilot.verify_shared_environment({"PATH": "/tools"})["verified"])
        for key in pilot.SHARED_ENV_FORBIDDEN:
            for value in ("", "override"):
                with self.assertRaisesRegex(AssertionError, "SHARED_ENV_OVERRIDE"):
                    pilot.verify_shared_environment({key: value})

    def test_revision_requires_exact_commit_and_clean_tracked_source(self):
        with patch.object(pilot.subprocess, "check_output", side_effect=["abc\n", ""]):
            self.assertEqual(pilot.revision("/repo", "abc"), "abc")
        for responses in (["wrong", ""], ["abc", " M source"]):
            with patch.object(pilot.subprocess, "check_output", side_effect=responses):
                with self.assertRaisesRegex(AssertionError, "SOURCE_PIN"):
                    pilot.revision("/repo", "abc")

    def test_busy_port_fails_before_services_and_closes_all_probes(self):
        probes = [Mock(), Mock()]
        probes[1].bind.side_effect = OSError("port already owned")
        with patch.object(pilot.socket, "socket", side_effect=probes):
            with self.assertRaises(OSError):
                pilot.require_free_ports((15462, 16399))
        for probe in probes:
            probe.close.assert_called_once()
        probes = [Mock(), Mock()]
        with patch.object(pilot.socket, "socket", side_effect=probes):
            self.assertTrue(pilot.require_free_ports((15462, 16399))["verified"])
        for probe in probes:
            probe.close.assert_called_once()


class AccountingTests(unittest.TestCase):
    def test_decimal_fee_and_all_eight_financial_invariants(self):
        for count in (138, 1000, 48217):
            exact = census(count)
            self.assertTrue(all(pilot.financial_checks(exact, count).values()))
            for key in exact:
                changed = copy.deepcopy(exact)
                changed[key] = str(Decimal(str(exact[key])) + Decimal("0.00000001")) if isinstance(exact[key], str) else exact[key] + 1
                self.assertFalse(all(pilot.financial_checks(changed, count).values()), key)

    def test_raw_samples_and_statuses_must_all_prove_success(self):
        self.assertEqual(pilot.verify_raw(raw(), 2)["successes"], 2)
        changes = [lambda d: d.update(success=1), lambda d: d.update(status_counts={"200": 1, "429": 1}),
                   lambda d: d.update(errors={"timeout": 1}), lambda d: d.update(stream=True),
                   lambda d: d["samples"].pop(), lambda d: d["samples"][0].update(Err="truncated"),
                   lambda d: d["samples"][0].update(Bytes=0), lambda d: d["samples"][0].update(Mode="fast-reserved-max"),
                   lambda d: d["samples"][0].update(Fallback="legacy"), lambda d: d["samples"][0].update(MS=float("nan"))]
        for change in changes:
            value = raw()
            change(value)
            with self.assertRaises(AssertionError):
                pilot.verify_raw(value, 2)
        with self.assertRaises(AssertionError):
            pilot.verify_raw(raw(), 10)

    def test_all_attempt_quantiles_use_every_sample_and_empty_is_unknown(self):
        result = pilot.distribution([1, 2, 10, 500])
        self.assertEqual(result["count"], 4)
        self.assertEqual(result["p50"], 2)
        self.assertEqual(result["max"], 500)
        self.assertIsNone(pilot.distribution([])["p99"])
        for value in (-1, float("inf"), float("nan")):
            with self.assertRaises(AssertionError):
                pilot.distribution([value])

    def test_mock_requires_exact_raw_requests_and_no_failures_or_leftovers(self):
        self.assertTrue(pilot.verify_mock(metrics(138), metrics(140), 2)["verified"])
        for key in ("received", "completed", "json", "sse", "unexpected_paths", "bad_requests", "write_errors", "in_flight", "delay_ms"):
            after = metrics(140)
            after[key] += 1
            with self.assertRaises(AssertionError):
                pilot.verify_mock(metrics(138), after, 2)
        after = metrics(140)
        after["inference_connections"] = 1
        with self.assertRaises(AssertionError):
            pilot.verify_mock(metrics(138), after, 2)


class MeasurementTests(unittest.TestCase):
    def test_quiet_probe_failure_cannot_silently_end_guard_and_pass(self):
        self.assertEqual(pilot.quiet_sample(lambda _: {"valid": True}, None), {"valid": True})
        failed = pilot.quiet_sample(Mock(side_effect=ValueError("invalid marker")), None)
        self.assertFalse(failed["valid"])
        self.assertEqual(failed["error_category"], "ValueError")

    def test_cpu_includes_all_sub_threads_and_checks_pid_start_identity(self):
        before, after = process(), process()
        after.update(user_ticks=30, system_ticks=40, monotonic_ns=3000000000)
        result = pilot.resources(before, after, 10)
        self.assertEqual(result["cpu_total_ms"], 400)
        self.assertEqual(result["average_process_cpu_cores"], .2)
        self.assertEqual(result["cpu_ms_per_success"], 40)
        for key, bad in (("pid", 43), ("start_ticks", "8"), ("ticks_per_second", 1000),
                         ("available", False), ("monotonic_ns", 0), ("user_ticks", -100)):
            changed = {**after, key: bad}
            with self.assertRaises(AssertionError):
                pilot.resources(before, changed, 10)

    def test_drain_clock_is_distinct_and_drift_is_not_hidden(self):
        self.assertEqual(pilot.clock_proof(raw(), 62000000000, 1, 1)["financial_seconds"], 61)
        self.assertTrue(pilot.clock_proof(raw(), 62000000000, 1, 1)["stable_within_1ms"])
        self.assertFalse(pilot.clock_proof(raw(), 62000000000, 1, 2000000)["stable_within_1ms"])
        with self.assertRaises(AssertionError):
            pilot.clock_proof(raw(), 60000000000, 1, 1)

    def test_no_node_reference_cannot_invent_cpu_or_ratio(self):
        result = pilot.node_reference(None)
        self.assertFalse(result["available"])
        self.assertNotIn("ratio", result)

    def test_node_reference_requires_both_businesses_plus_primary_and_exact_evidence(self):
        value = {"diagnostic_only": True, "financial_drain_ok": True, "zero_denials": True,
                 "source_commit": "independent", "business_workers": 2, "warm_successes": 138,
                 "process_resources": {"valid": True, "business": [{}, {}], "primary": {"valid": True},
                                       "scope": "both businesses plus primary", "combined_cpu_ms": 110,
                                       "business_cpu_ms": 100, "primary_cpu_ms": 10}}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "summary.json"
            file.write_text(json.dumps(value))
            self.assertTrue(pilot.node_reference(file)["available"])
            self.assertNotIn("ratio", pilot.node_reference(file))
            for change in (lambda d: d.update(business_workers=1),
                           lambda d: d.update(financial_drain_ok=False),
                           lambda d: d["process_resources"].update(combined_cpu_ms=100),
                           lambda d: d["process_resources"]["primary"].update(valid=False)):
                changed = copy.deepcopy(value)
                change(changed)
                file.write_text(json.dumps(changed))
                with self.assertRaises(AssertionError):
                    pilot.node_reference(file)


class CleanupTests(unittest.TestCase):
    def test_cleanup_attempts_every_child_and_log_even_after_wait_or_close_error(self):
        children = [Mock(pid=1, returncode=0), Mock(pid=2, returncode=None)]
        children[0].poll.return_value = 0
        children[1].poll.return_value = None
        logs = [Mock(), Mock()]
        logs[0].close.side_effect = OSError("close")
        stopped = []

        def stop(child):
            stopped.append(child.pid)
            if child.pid == 2:
                raise subprocess.TimeoutExpired("sub", 5)

        proof = pilot.cleanup_children(children, logs, [], stop)
        self.assertEqual(stopped, [2, 1])
        for log in logs:
            log.close.assert_called_once()
        self.assertFalse(proof["all_exited"])
        self.assertFalse(proof["all_graceful"])
        self.assertEqual(len(proof["errors"]), 2)

    def test_stop_only_owned_handle_and_forced_exit_never_looks_graceful(self):
        child = Mock(pid=42, returncode=0)
        child.poll.return_value = None
        forced = []
        self.assertEqual(pilot.stop_owned(child, forced), 0)
        child.terminate.assert_called_once()
        child.kill.assert_not_called()
        self.assertEqual(forced, [])
        child = Mock(pid=43, returncode=-9)
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired("sub", 45), None]
        pilot.stop_owned(child, forced)
        self.assertEqual(forced, [43])
        child.kill.assert_called_once()

    def test_already_exited_process_is_not_signalled(self):
        child = Mock(returncode=0)
        child.poll.return_value = 0
        pilot.stop_owned(child, [])
        child.terminate.assert_not_called()

    def test_passing_result_is_only_after_cleanup_and_matching_release(self):
        calls = []
        pilot.finalize({"passed": True}, lambda: calls.append("cleanup") or {"all_exited": True, "all_graceful": True},
                       lambda: calls.append("release"), lambda value: calls.append(value))
        self.assertEqual(calls, ["cleanup", "release", {"passed": True}])

    def test_failed_cleanup_or_release_never_saves_pass(self):
        for proof in ({"all_exited": False, "all_graceful": False}, {"all_exited": True, "all_graceful": False}):
            saved, released = [], []
            with self.assertRaises(AssertionError):
                pilot.finalize({"passed": True}, lambda: proof, lambda: released.append(True), saved.append)
            self.assertFalse(saved[-1]["passed"])
            self.assertEqual(bool(released), proof["all_exited"])
        saved = []
        with self.assertRaises(RuntimeError):
            pilot.finalize({"passed": True}, lambda: {"all_exited": True, "all_graceful": True},
                           Mock(side_effect=RuntimeError("newer generation")), saved.append)
        self.assertFalse(saved[-1]["passed"])


if __name__ == "__main__":
    unittest.main()
