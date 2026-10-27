import copy
import unittest

from async_receipt_cpu_profile import frame_category, summarize_cpu_profile


def profile():
    frames = [("proof", "file:///repo/dist/proof.js"), ("(garbage collector)", ""),
              ("(idle)", ""), ("write", "node:internal/stream_base_commons"),
              ("(program)", ""), ("decode", "file:///repo/node_modules/redis/parser.js")]
    return {"startTime": 100, "endTime": 220,
            "nodes": [{"id": i + 1, "callFrame": {"functionName": name, "url": url, "lineNumber": 1, "columnNumber": 2}}
                      for i, (name, url) in enumerate(frames)],
            "samples": [1, 1, 2, 3, 4, 5, 6], "timeDeltas": [10, 20, 5, 40, 15, 10, 10]}


class CpuProfileTests(unittest.TestCase):
    def test_weighted_leaf_attribution_keeps_native_unknown_and_idle_separate(self):
        value = summarize_cpu_profile(profile())
        self.assertEqual(value["sample_weight_us"], 110)
        self.assertEqual(value["nonidle_sample_weight_us"], 70)
        self.assertEqual(value["duration_minus_sample_weight_us"], 10)
        self.assertEqual(value["categories"]["v8_gc"]["sample_weight_us"], 5)
        self.assertEqual(value["categories"]["node_builtin_boundary"]["sample_weight_us"], 15)
        proof = next(row for row in value["top_leaf_functions"] if row["function"] == "proof")
        self.assertEqual(proof["samples"], 2)
        self.assertEqual(proof["self_sample_weight_us"], 30)
        self.assertAlmostEqual(proof["percent_of_nonidle_sampled_time"], 100 * 30 / 70)
        self.assertEqual(frame_category({"functionName": "TLSWrap", "url": ""}), "v8_native_or_unattributed")

    def test_invalid_profiles_never_fabricate_zero_samples(self):
        for key, value in [("samples", []), ("timeDeltas", [1]), ("endTime", 100)]:
            bad = copy.deepcopy(profile()); bad[key] = value
            with self.assertRaises(AssertionError): summarize_cpu_profile(bad)
        bad = profile(); bad["timeDeltas"][0] = -1
        with self.assertRaises(AssertionError): summarize_cpu_profile(bad)
        bad = profile(); bad["samples"][0] = 999
        with self.assertRaises(KeyError): summarize_cpu_profile(bad)


if __name__ == "__main__": unittest.main()
