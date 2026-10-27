"""Read-only allowlisted CI visibility; never prints arbitrary error text or keys."""
import argparse
import json
from pathlib import Path
import re

FINANCE_KEYS = ('intents', 'receipts', 'succeeded', 'completed', 'unresolved', 'charge', 'posted',
                'wallet', 'backing', 'available', 'allocated', 'cap', 'active_allocations',
                'active_slots', 'gateway_sessions', 'gateway_role_limit', 'business_owners')
KNOWN_LABELS = FINANCE_KEYS + ('AssertionError', 'RuntimeError', 'TimeoutError', 'ValueError',
                'exact native owners', 'exact fresh activation history', 'exact retained activation claims',
                'exact manifest policy', 'QUOTA_REQUIRED_EVIDENCE_MISSING', 'QUOTA_HELPER_FAILED',
                'QUOTA_DOCKER_BUILD_FAILED', 'QUOTA_COHORT_110_MINUTE_DEADLINE')


def read(path):
    try:
        if path.stat().st_size > 131072:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def labels(failures):
    return sorted({label for label in KNOWN_LABELS
                   if any(isinstance(value, str) and label in value for value in failures)})


def summaries(root):
    result = []
    for path in sorted(root.glob('*/outcome.json'))[:16]:
        arm = path.parent.name
        if not re.fullmatch(r'c(?:32|200)-(?:json|sse)-[1-4]-(?:single|bounded)', arm):
            continue
        outcome = read(path)
        failures = outcome.get('failures', [])
        if not isinstance(failures, list):
            failures = []
        result.append({'arm': arm, 'validDiagnostic': outcome.get('validDiagnostic') is True,
                       'failureCount': len(failures),
                       'failureLabels': labels(failures) or (['other; see artifact'] if failures else [])})
        for name in ('warm-audit.json', 'drain-audit.json', 'stopped-audit.json'):
            audit = read(path.parent / name)
            facts, usage = audit.get('finance'), audit.get('usage')
            safe = {key: facts[key] for key in FINANCE_KEYS if isinstance(facts, dict)
                    and isinstance(facts.get(key), str) and re.fullmatch(r'-?[0-9]{1,64}', facts[key])}
            result.append({'arm': arm, 'audit': name, 'available': bool(audit), 'finance': safe,
                           'actualTpmExact': isinstance(usage, dict) and usage.get('exact') is True})
    if not result:
        failure = read(root / 'cohort-failure.json')
        result.append({'armsAvailable': False, 'failureLabels': labels([failure.get('errorType'), failure.get('message')]),
                       'note': 'Inspect correctness/build/cohort failure artifact; no performance acceptance.'})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    for item in summaries(args.evidence):
        print(json.dumps(item, sort_keys=True))


if __name__ == '__main__':
    main()
