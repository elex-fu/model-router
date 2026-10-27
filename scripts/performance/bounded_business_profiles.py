"""Shared diagnostic profiles; changing admission does not grow queue/PG budgets."""
import json
from pathlib import Path


CONTRACT_PATH = Path(__file__).with_name("bounded-business-profiles.json")
CONTRACT = json.loads(CONTRACT_PATH.read_text())
MAXIMUM = CONTRACT["maximum"]
PROFILE_NAMES = tuple(CONTRACT["profiles"])
SERIAL_PROFILES = ("serial-json", "serial-sse")


def get_profile(name="c32"):
    if name not in CONTRACT["profiles"]:
        raise ValueError("BOUNDED_BUSINESS_UNKNOWN_PROFILE")
    value = CONTRACT["profiles"][name]
    positive = [MAXIMUM, *CONTRACT["fixedTotals"].values(), value["httpInFlight"], value["concurrency"]]
    if not all(type(number) is int and number > 0 for number in positive):
        raise ValueError("BOUNDED_BUSINESS_INVALID_PROFILE_BUDGET")
    limits = [value["timedSeconds"], value["timedRequests"]]
    if sum(number is not None for number in limits) != 1 or not all(
            number is None or (type(number) is int and number > 0) for number in limits):
        raise ValueError("BOUNDED_BUSINESS_INVALID_PROFILE_CLIENT_BOUND")
    if type(value.get("stream", False)) is not bool:
        raise ValueError("BOUNDED_BUSINESS_INVALID_PROFILE_PROTOCOL")
    return dict(value)


def profile_stream(name="c32"):
    return get_profile(name).get("stream", False)


def aggregate_budgets(name="c32"):
    selected = get_profile(name)
    return {**CONTRACT["fixedTotals"], "httpInFlight": selected["httpInFlight"],
            "automaticCreditTarget": 2 * MAXIMUM * selected["httpInFlight"]}


def expected_budgets(workers, profile="c32"):
    if type(workers) is not int or workers not in (1, 2):
        raise ValueError("BOUNDED_BUSINESS_EXPECT_ONE_OR_TWO_WORKERS")
    if profile in SERIAL_PROFILES and workers != 1:
        raise ValueError("BOUNDED_BUSINESS_SERIAL_REQUIRES_ONE_WORKER")
    totals = aggregate_budgets(profile)
    if any(value % workers for value in totals.values()):
        raise ValueError("BOUNDED_BUSINESS_INDIVISIBLE_BUDGET")
    return {key: value // workers for key, value in totals.items()}


def scene_parameters(profile, scene):
    selected = get_profile(profile)
    if profile in SERIAL_PROFILES and scene != "timed":
        raise ValueError("BOUNDED_BUSINESS_SERIAL_TIMED_ONLY")
    if scene not in ("qualification", "timed"):
        raise ValueError("BOUNDED_BUSINESS_UNKNOWN_SCENE")
    return {"count": 256 if scene == "qualification" else selected["timedRequests"] or 1000000,
            "concurrency": selected["concurrency"],
            "duration": 0 if scene == "qualification" else selected["timedSeconds"] or 0}
