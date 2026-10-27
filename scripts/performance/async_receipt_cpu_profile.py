"""Pure V8 CPU-profile summary; raw profiles remain the primary evidence.

Time deltas weight observed leaf samples, not HTTP durations or exact CPU time.
Node builtin/native attribution remains intentionally qualified: V8 sampling
does not provide a complete native C/C++ stack or isolate the timed load phase.
"""
import math


def frame_category(frame):
    name = frame.get("functionName", "")
    url = frame.get("url", "")
    if name == "(idle)": return "idle"
    if name == "(garbage collector)": return "v8_gc"
    if name in ("(program)", "(root)") or not url: return "v8_native_or_unattributed"
    if url.startswith("node:"): return "node_builtin_boundary"
    if "/node_modules/" in url: return "dependency_javascript"
    if "/dist/" in url or "/src/" in url: return "application_javascript"
    return "other_javascript"


def summarize_cpu_profile(profile):
    nodes = {node["id"]: node for node in profile["nodes"]}
    assert len(nodes) == len(profile["nodes"]), "ASYNC_CPU_DUPLICATE_NODE_IDS"
    samples = profile["samples"]; deltas = profile["timeDeltas"]
    assert samples and len(samples) == len(deltas), "ASYNC_CPU_SAMPLE_DELTAS_REQUIRED"
    duration = profile["endTime"] - profile["startTime"]
    assert math.isfinite(duration) and duration > 0, "ASYNC_CPU_PROFILE_DURATION_INVALID"
    categories = {}; functions = {}
    for node_id, delta in zip(samples, deltas):
        assert isinstance(delta, (int, float)) and math.isfinite(delta) and delta >= 0, "ASYNC_CPU_SAMPLE_DELTA_INVALID"
        frame = nodes[node_id]["callFrame"]
        category = frame_category(frame)
        group = categories.setdefault(category, {"samples": 0, "sample_weight_us": 0})
        group["samples"] += 1; group["sample_weight_us"] += delta
        identity = tuple(frame.get(key, "") for key in ("functionName", "url", "lineNumber", "columnNumber"))
        function = functions.setdefault(identity, {"function": identity[0], "url": identity[1],
            "zero_based_line": identity[2], "zero_based_column": identity[3], "category": category,
            "samples": 0, "self_sample_weight_us": 0})
        function["samples"] += 1; function["self_sample_weight_us"] += delta
    weight = sum(deltas)
    assert weight > 0, "ASYNC_CPU_SAMPLE_WEIGHT_REQUIRED"
    nonidle = weight - categories.get("idle", {}).get("sample_weight_us", 0)
    for group in categories.values():
        group["percent_of_sampled_time"] = 100 * group["sample_weight_us"] / weight
    for function in functions.values():
        function["percent_of_sampled_time"] = 100 * function["self_sample_weight_us"] / weight
        function["percent_of_nonidle_sampled_time"] = (100 * function["self_sample_weight_us"] / nonidle
            if nonidle and function["category"] != "idle" else None)
    return {"schema_version": 1, "sample_count": len(samples), "node_count": len(nodes),
        "profile_duration_us": duration, "sample_weight_us": weight,
        "nonidle_sample_weight_us": nonidle, "duration_minus_sample_weight_us": duration - weight,
        "categories": categories,
        "top_leaf_functions": sorted(functions.values(), key=lambda row: row["self_sample_weight_us"], reverse=True)[:40],
        "qualifications": [
            "Whole-process sample attribution; startup, warmup, timing, drain and shutdown are not separated.",
            "Time-delta weighted leaf samples are statistical attribution, not exact CPU accounting or exclusive per-request cost.",
            "V8 GC pseudo-frame is separately visible. Empty-url/program frames remain native/V8/unattributed, not fabricated JavaScript cost.",
            "node: frames identify builtin boundaries; native C/C++/TLS/crypto/kernel work may be charged to callers or absent. No complete native-stack attribution.",
            "Sampling perturbation, timer/event-loop scheduling, inlining and compiler optimization can bias attribution; no unprofiled throughput comparison.",
        ]}
