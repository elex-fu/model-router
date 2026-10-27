"""Pure summaries only; no services, Docker, network or private output."""
import json
from pathlib import Path
import tempfile
import unittest
from fixed_cpu_quota_log_summary import summaries


class SafeSummaryTests(unittest.TestCase):
    def test_allowlisted_failure_and_finance_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / 'c32-json-2-bounded'
            arm.mkdir()
            (arm / 'outcome.json').write_text(json.dumps({'validDiagnostic': False,
                'failures': ['AssertionError active_slots api_key=DO_NOT_PRINT https://user:SECRET@example.com']}))
            (arm / 'stopped-audit.json').write_text(json.dumps({'finance': {
                'active_slots': '2', 'gateway_sessions': '0', 'backing': '0', 'wallet': 'SECRET',
                'api_key': 'DO_NOT_PRINT'}, 'usage': {'exact': True}, 'env': 'SECRET'}))
            result = summaries(root)
            text = json.dumps(result)
            self.assertNotIn('SECRET', text)
            self.assertNotIn('DO_NOT_PRINT', text)
            self.assertNotIn('example.com', text)
            self.assertIn('active_slots', result[0]['failureLabels'])
            self.assertEqual(result[-1]['finance'], {'active_slots': '2', 'gateway_sessions': '0', 'backing': '0'})
            self.assertTrue(result[-1]['actualTpmExact'])

    def test_missing_malformed_null_and_large_evidence_remain_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(summaries(root)[0]['armsAvailable'])
            arm = root / 'c200-sse-4-single'; arm.mkdir()
            (arm / 'outcome.json').write_text('{broken')
            (arm / 'warm-audit.json').write_text(json.dumps({'finance': None, 'usage': None}))
            (arm / 'drain-audit.json').write_text('X' * 131073)
            result = summaries(root)
            self.assertFalse(result[0]['validDiagnostic'])
            self.assertEqual(result[1]['finance'], {})
            self.assertFalse(result[1]['actualTpmExact'])
            self.assertFalse(result[2]['available'])

    def test_unrecognized_arm_paths_and_exception_details_are_not_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / 'SECRET'; arm.mkdir()
            (arm / 'outcome.json').write_text(json.dumps({'failures': ['SECRET']}))
            (root / 'cohort-failure.json').write_text(json.dumps({'errorType': 'RuntimeError', 'message': 'SECRET'}))
            text = json.dumps(summaries(root))
            self.assertNotIn('SECRET', text)
            self.assertIn('RuntimeError', text)


if __name__ == '__main__':
    unittest.main()
