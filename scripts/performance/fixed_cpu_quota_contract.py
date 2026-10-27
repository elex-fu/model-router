"""Pure, fail-closed contracts for the opt-in app-container CPU diagnostic.

No Docker calls, processes, services, cgroup writes, or benchmark run on import.
The resource boundary is the *entire* app cgroup: the primary, all business
children and their native threads. Separate PG/Redis/mock/driver containers are
not part of these numbers. A resource proof is not performance acceptance.
"""
from collections import Counter
import math
from pathlib import Path


PROFILE_NAMES = ("c32", "c200")
PROTOCOL_NAMES = ("json", "sse")
ABBA = ("single", "bounded", "bounded", "single")
CPU_EQUIVALENTS = 2
MEMORY_LIMIT_BYTES = 2 * 1024 ** 3
MAXIMUM_MINOR_UNITS = 524480
CHARGE_MINOR_UNITS = 35
DRIVER_DEADLINE_SECONDS = 120
FIXED_TOTALS = {
    "databasePoolMax": 16,
    "receiptEntries": 256,
    "receiptBytes": 2 * 1024 ** 2,
    "receiptPerTenant": 64,
    "receiptWorkers": 8,
    "reconciliationWorkers": 8,
    "creditStripes": 8,
}
CGROUP_FILES = (
    "cgroup.controllers", "cpu.max", "cpu.stat", "memory.max", "memory.current",
    "memory.peak", "memory.events", "cgroup.procs", "cgroup.threads",
)
CPU_STAT_REQUIRED = (
    "usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec",
)
MEMORY_EVENTS_REQUIRED = ("low", "high", "max", "oom", "oom_kill")


def _integer(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"QUOTA_INVALID_{label}")
    return value


def _natural(text, label, *, minimum=0):
    if not isinstance(text, str) or not text.strip().isascii() or not text.strip().isdigit():
        raise ValueError(f"QUOTA_INVALID_{label}")
    return _integer(int(text.strip()), label, minimum=minimum)


def profile_contract(name):
    """Independent fixed totals, so a caller cannot mutate a subsequent arm."""
    if name not in PROFILE_NAMES:
        raise ValueError("QUOTA_UNKNOWN_PROFILE")
    http, concurrency = (64, 32) if name == "c32" else (256, 200)
    return {
        "profile": name,
        **FIXED_TOTALS,
        "httpInFlight": http,
        "concurrency": concurrency,
        "creditCapMinorUnits": 2 * MAXIMUM_MINOR_UNITS * http,
        "maximumMinorUnits": MAXIMUM_MINOR_UNITS,
        "chargeMinorUnits": CHARGE_MINOR_UNITS,
        "cpuEquivalents": CPU_EQUIVALENTS,
        "memoryLimitBytes": MEMORY_LIMIT_BYTES,
        "timedSeconds": 60 if name == "c32" else None,
        "timedRequests": None if name == "c32" else 10000,
        "maxAttempts": None if name == "c32" else 10000,
    }


def _selection(values, allowed, label):
    if isinstance(values, str):
        values = (values,)
    else:
        values = tuple(values)
    if not values or len(values) != len(set(values)) or any(value not in allowed for value in values):
        raise ValueError(f"QUOTA_INVALID_{label}")
    return values


def cohort_plan(profiles=PROFILE_NAMES, protocols=PROTOCOL_NAMES):
    """One fixed-workload ABBA block; neither duration nor count is tunable."""
    profiles = _selection(profiles, PROFILE_NAMES, "PROFILES")
    protocols = _selection(protocols, PROTOCOL_NAMES, "PROTOCOLS")
    return [
        {
            "profile": profile, "protocol": protocol, "arm": arm,
            "position": position,
            "timedSeconds": 60 if profile == "c32" else None,
            "timedRequests": None if profile == "c32" else 10000,
            "maxAttempts": None if profile == "c32" else 10000,
            "warmup": {
                "bootstrap": {"protocol": "json", "requests": 10, "concurrency": 1},
                "matched": {"protocol": protocol, "requests": 128, "concurrency": 32},
                "financialDrain": True, "actualTpmDrain": True, "nativeQueueZero": True,
                "quietMilliseconds": 1000,
            },
            "label": f"{profile}-{protocol}-{position}-{arm}",
            "contract": profile_contract(profile),
        }
        for profile in profiles for protocol in protocols for position, arm in enumerate(ABBA, 1)
    ]


def validate_workload_result(entry, raw):
    """Prove the full fixed workload ran, separately from success/error gates.

    Every attempt, including 429s and transport failures, stays in the count.
    This does not validate the preceding warm/drain/quiet proofs: those must be
    observed by the runner. A shortened/deadline-stopped arm is not a
    completed workload, even if every retained request succeeded.
    """
    if not isinstance(entry, dict) or not isinstance(raw, dict):
        raise ValueError("QUOTA_INVALID_WORKLOAD_RESULT")
    contract = profile_contract(entry.get("profile"))
    if entry.get("protocol") not in PROTOCOL_NAMES:
        raise ValueError("QUOTA_INVALID_WORKLOAD_PROTOCOL")
    for key in ("timedSeconds", "timedRequests", "maxAttempts"):
        if key not in entry or entry[key] != contract[key] or type(entry[key]) is not type(contract[key]):
            raise ValueError("QUOTA_WORKLOAD_PLAN_CHANGED")
    if type(raw.get("stream")) is not bool or raw["stream"] != (entry["protocol"] == "sse"):
        raise ValueError("QUOTA_WORKLOAD_PROTOCOL_MISMATCH")
    if type(raw.get("concurrency")) is not int or raw["concurrency"] != contract["concurrency"]:
        raise ValueError("QUOTA_WORKLOAD_CONCURRENCY_MISMATCH")
    if raw.get("request_limit") != (contract["timedRequests"] or 0) or type(raw.get("request_limit")) is not int:
        raise ValueError("QUOTA_WORKLOAD_REQUEST_LIMIT_MISMATCH")
    if raw.get("admission_duration_s") != (contract["timedSeconds"] or 0):
        raise ValueError("QUOTA_WORKLOAD_ADMISSION_DURATION_MISMATCH")
    attempts = _integer(raw.get("requests"), "WORKLOAD_ATTEMPTS", minimum=1)
    if not isinstance(raw.get("samples"), list) or len(raw["samples"]) != attempts:
        raise ValueError("QUOTA_WORKLOAD_SAMPLE_COUNT_MISMATCH")
    duration = raw.get("duration_s")
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("QUOTA_INVALID_WORKLOAD_DURATION")
    if duration >= DRIVER_DEADLINE_SECONDS or raw.get("deadline_exceeded") is not False:
        raise ValueError("QUOTA_WORKLOAD_DRIVER_DEADLINE_REACHED")
    if contract["timedSeconds"] is not None:
        if duration < contract["timedSeconds"]:
            raise ValueError("QUOTA_WORKLOAD_DURATION_SHORTENED")
    elif attempts != contract["timedRequests"]:
        raise ValueError("QUOTA_WORKLOAD_FIXED_COUNT_INCOMPLETE")
    return {
        "profile": entry["profile"], "protocol": entry["protocol"],
        "attempts": attempts, "durationSeconds": duration,
        "timedSeconds": contract["timedSeconds"], "timedRequests": contract["timedRequests"],
        "maxAttempts": contract["maxAttempts"], "workloadComplete": True,
        "excludedAttempts": 0, "performanceAcceptance": False,
    }


def _key_values(text, label, required):
    if not isinstance(text, str):
        raise ValueError(f"QUOTA_INVALID_{label}")
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != 2 or fields[0] in result:
            raise ValueError(f"QUOTA_INVALID_{label}")
        result[fields[0]] = _natural(fields[1], label)
    if any(name not in result for name in required):
        raise ValueError(f"QUOTA_MISSING_{label}_COUNTER")
    return result


def _ids(text, label):
    if not isinstance(text, str):
        raise ValueError(f"QUOTA_INVALID_{label}")
    # Kernel task censuses are separate, racy reads; retain raw bytes, but do not
    # infer process lifetime, worker count or completeness from a single census.
    return sorted({_natural(line, label, minimum=1) for line in text.splitlines()})


def parse_cgroup_snapshot(raw):
    """Parse actual cgroup-v2 files; unlimited/affinity-only setups fail closed.

    Each read is an observation, not proof that no operator changed the policy
    between observations. The runner separately preserves Docker configuration.
    cgroup.controllers can be empty in a v2 leaf namespace; its existence, not
    delegated descendant controllers, identifies the unified hierarchy.
    """
    if not isinstance(raw, dict) or any(name not in raw for name in CGROUP_FILES):
        raise ValueError("QUOTA_MISSING_CGROUP_V2_FILE")
    if any(not isinstance(raw[name], str) for name in CGROUP_FILES):
        raise ValueError("QUOTA_INVALID_CGROUP_FILE")
    fields = raw["cpu.max"].split()
    if len(fields) != 2:
        raise ValueError("QUOTA_INVALID_CPU_MAX")
    quota = _natural(fields[0], "CPU_QUOTA", minimum=1)
    period = _natural(fields[1], "CPU_PERIOD", minimum=1)
    if quota != CPU_EQUIVALENTS * period:
        raise ValueError("QUOTA_REQUIRES_EXACTLY_TWO_CPUS")
    memory_limit = _natural(raw["memory.max"], "MEMORY_MAX", minimum=1)
    if memory_limit != MEMORY_LIMIT_BYTES:
        raise ValueError("QUOTA_REQUIRES_EXACTLY_TWO_GIB")
    return {
        "raw": {name: raw[name] for name in CGROUP_FILES},
        "cgroupVersion": 2,
        "cpuQuota": quota,
        "cpuPeriod": period,
        "cpuEquivalents": CPU_EQUIVALENTS,
        "memoryLimitBytes": memory_limit,
        "cpuStat": _key_values(raw["cpu.stat"], "CPU_STAT", CPU_STAT_REQUIRED),
        "memoryCurrentBytes": _natural(raw["memory.current"], "MEMORY_CURRENT"),
        "memoryPeakBytes": _natural(raw["memory.peak"], "MEMORY_PEAK"),
        "memoryEvents": _key_values(raw["memory.events"], "MEMORY_EVENTS", MEMORY_EVENTS_REQUIRED),
        "processIds": _ids(raw["cgroup.procs"], "PROCESS_IDS"),
        "threadIds": _ids(raw["cgroup.threads"], "THREAD_IDS"),
        "scope": "whole app cgroup, including primary, all business children and native threads",
    }


def read_cgroup_snapshot(root=Path("/sys/fs/cgroup")):
    root = Path(root)
    try:
        raw = {name: (root / name).read_text(encoding="ascii") for name in CGROUP_FILES}
    except (OSError, UnicodeError) as error:
        raise ValueError("QUOTA_CGROUP_V2_READ_FAILED") from error
    return parse_cgroup_snapshot(raw)


def resource_delta(before, after):
    """Inclusive app-cgroup deltas; never subtract guessed observer overhead.

    Snapshot/execution overhead inside the measured interval remains included.
    memory.peak is lifetime-to-observation, not an invented interval-only peak.
    """
    before = parse_cgroup_snapshot(before["raw"])
    after = parse_cgroup_snapshot(after["raw"])
    if any(before[key] != after[key] for key in ("cpuQuota", "cpuPeriod", "memoryLimitBytes")):
        raise ValueError("QUOTA_POLICY_CHANGED_DURING_INTERVAL")

    def differences(key):
        first, last = before[key], after[key]
        if first.keys() != last.keys():
            raise ValueError("QUOTA_COUNTER_SET_CHANGED_DURING_INTERVAL")
        values = {name: last[name] - first[name] for name in first}
        if any(value < 0 for value in values.values()):
            raise ValueError("QUOTA_COUNTER_RESET_DURING_INTERVAL")
        return values

    cpu = differences("cpuStat")
    memory_events = differences("memoryEvents")
    if after["memoryPeakBytes"] < before["memoryPeakBytes"]:
        raise ValueError("QUOTA_MEMORY_PEAK_RESET_DURING_INTERVAL")
    return {
        "scope": before["scope"],
        "cpuStatDelta": cpu,
        "cpuMilliseconds": cpu["usage_usec"] / 1000,
        "throttledMilliseconds": cpu["throttled_usec"] / 1000,
        "throttledPeriods": cpu["nr_throttled"],
        "periods": cpu["nr_periods"],
        "memoryCurrentBeforeBytes": before["memoryCurrentBytes"],
        "memoryCurrentAfterBytes": after["memoryCurrentBytes"],
        "memoryPeakLifetimeBeforeBytes": before["memoryPeakBytes"],
        "memoryPeakLifetimeAfterBytes": after["memoryPeakBytes"],
        "memoryPeakScope": "container lifetime, including startup and warmup; not interval-only",
        "memoryEventsDelta": memory_events,
        "oomObserved": bool(memory_events["oom"] or memory_events["oom_kill"]),
        "performanceAcceptance": False,
    }


def _tails(values):
    """Nearest-rank empirical quantiles, including maximum and p999."""
    values = sorted(values)
    if not values:
        return {"count": 0, "p50": None, "p95": None, "p99": None, "p999": None, "max": None}
    return {
        "count": len(values),
        **{name: values[max(0, math.ceil(len(values) * quantile) - 1)]
           for name, quantile in (("p50", .50), ("p95", .95), ("p99", .99), ("p999", .999))},
        "max": values[-1],
    }


def summarize_attempts(rows):
    """Summarize every supplied native Go client sample, without tail clipping.

    The caller must retain the original sample artifact. Errors and overloads
    stay in the denominator and all-attempt latency distribution. Successful
    latency is reported separately; a 200/fallback/wrong-mode is not a success.
    """
    if not isinstance(rows, list) or not rows:
        raise ValueError("QUOTA_ATTEMPT_SAMPLES_REQUIRED")
    all_latency, success_latency, all_ttfb, success_ttfb = [], [], [], []
    statuses, errors, modes, fallbacks = Counter(), Counter(), Counter(), Counter()
    contract_failures = 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("QUOTA_INVALID_ATTEMPT")
        status = _integer(row.get("Status"), "ATTEMPT_STATUS")
        if status > 599:
            raise ValueError("QUOTA_INVALID_ATTEMPT_STATUS")
        for key in ("Err", "Mode", "Fallback"):
            if not isinstance(row.get(key), str):
                raise ValueError("QUOTA_INVALID_ATTEMPT_TEXT")
        latency = row.get("MS")
        if type(latency) not in (int, float) or not math.isfinite(latency) or latency < 0:
            raise ValueError("QUOTA_INVALID_ATTEMPT_LATENCY")
        statuses[str(status)] += 1
        modes[row["Mode"]] += 1
        if row["Err"]:
            errors[row["Err"]] += 1
        if row["Fallback"]:
            fallbacks[row["Fallback"]] += 1
        contract_ok = row["Mode"] == "fast-reserved-max" and row["Fallback"] == ""
        success = status == 200 and row["Err"] == "" and contract_ok
        contract_failures += int(status == 200 and not contract_ok)
        all_latency.append(latency)
        if success:
            success_latency.append(latency)
        if "TTFB" in row:
            ttfb = row["TTFB"]
            if type(ttfb) not in (int, float) or not math.isfinite(ttfb) or ttfb < 0:
                raise ValueError("QUOTA_INVALID_ATTEMPT_TTFB")
            all_ttfb.append(ttfb)
            if success:
                success_ttfb.append(ttfb)
    successes = len(success_latency)
    return {
        "attempts": len(rows), "successes": successes, "errorsOrRejections": len(rows) - successes,
        "excludedAttempts": 0, "statusCounts": dict(statuses), "rawErrorCounts": dict(errors),
        "executionModeCounts": dict(modes), "fallbackCounts": dict(fallbacks),
        "contractFailures": contract_failures,
        "allAttemptLatencyMs": _tails(all_latency), "successfulLatencyMs": _tails(success_latency),
        "allAttemptTtfbMs": _tails(all_ttfb), "successfulTtfbMs": _tails(success_ttfb),
        "quantileMethod": "nearest-rank empirical",
        "zeroErrorGatePassed": successes == len(rows), "performanceAcceptance": False,
    }
