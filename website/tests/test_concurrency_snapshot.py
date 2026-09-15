import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "scripts/update_concurrency.py"
spec = importlib.util.spec_from_file_location("snapshot", path)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 1, "html_url": "https://github.com/example/repo/actions/runs/1",
                    "path": ".github/workflows/concurrency-bench.yml",
                    "head_sha": "a" * 40, "head_branch": "main", "conclusion": "success"}
        self.artifact = {"id": 2, "expires_at": "2026-02-01T00:00:00Z"}
        self.registry = {"schemaVersion": 1, "scenarios": [
            {"name": "paired", "gsharp": "paired", "go": "go-paired", "what": "Same operation."},
            {"name": "unpaired", "gsharp": "unpaired", "go": None, "what": "No equivalent Go row."},
        ]}
        value = {"median_ns": 100.0, "ci95_ns": [90.0, 110.0], "runs": 3, "samples": 18}
        self.payload = {
            "schemaVersion": 2,
            "gsharp": {"paired": value, "unpaired": value},
            "gsharp_aot": {"paired": value, "unpaired": value},
            "go": {"go-paired": {"median_ns": 50.0, "ci95_ns": [45.0, 55.0], "runs": 3, "samples": 18}},
            "comparisonKey": "comparison", "aggregationKey": "aggregate",
            "sourceEnvironments": [
                {"start": {"timestampUtc": f"2026-01-01T00:00:0{i}+00:00"},
                 "end": {"timestampUtc": f"2026-01-01T00:00:0{i+1}+00:00"}} for i in range(3)
            ],
            "fingerprint": {
                "build": {"gitCommit": "a" * 40, "gitDirty": False, "gscInformationalVersion": "test"},
                "comparable": False, "incomparabilityReasons": ["unknown power identity"],
                "sourceRunIds": ["one", "two", "three"],
                "comparison": {
                    "wholeRuns": 3, "scenario": "all", "modes": ["gsharp", "gsharp_aot", "go"],
                    "intervalMethod": "range-of-run-medians", "launches": 6,
                    "launchOrder": "rotating-interleaved", "jitMode": "tiered-pgo-steady-state",
                    "jitEnvironment": {}, "benchmarkDefinitionSha256": "definition", "toolchains": {},
                    "host": {"hardwareClass": "test", "cpuModel": "test", "logicalCpuCount": 4,
                             "system": "Linux", "machine": "x86_64", "release": "test"},
                },
            },
        }

    def normalize(self, payload=None):
        return snapshot.normalize(payload or self.payload, self.registry, self.run, self.artifact,
                                  b"test-only payload", "2026-01-01T01:00:00Z")

    def test_report_only_provenance_and_pairing_are_preserved(self):
        result = self.normalize()
        self.assertFalse(result["measurement"]["comparable"])
        self.assertEqual(result["measurement"]["intervalMethod"], "range-of-run-medians")
        self.assertEqual(result["scenarios"][0]["jitOverGo"], 2)
        self.assertIsNone(result["scenarios"][1]["go"])
        self.assertIsNone(result["scenarios"][1]["jitOverGo"])
        self.assertEqual(result["source"]["commit"], self.run["head_sha"])

    def test_wrong_commit_is_rejected(self):
        data = copy.deepcopy(self.payload)
        data["fingerprint"]["build"]["gitCommit"] = "b" * 40
        with self.assertRaises(ValueError):
            self.normalize(data)

    def test_partial_or_single_run_is_rejected(self):
        data = copy.deepcopy(self.payload)
        data["fingerprint"]["comparison"]["wholeRuns"] = 1
        with self.assertRaises(ValueError):
            self.normalize(data)

    def test_missing_paired_go_result_is_not_zero(self):
        data = copy.deepcopy(self.payload)
        data["go"] = {}
        with self.assertRaises(ValueError):
            self.normalize(data)

    def test_wrong_workflow_and_sample_counts_are_rejected(self):
        self.run["path"] = ".github/workflows/other.yml"
        with self.assertRaises(ValueError):
            self.normalize()
        self.run["path"] = ".github/workflows/concurrency-bench.yml"
        data = copy.deepcopy(self.payload)
        data["gsharp"]["paired"]["samples"] = 1
        with self.assertRaises(ValueError):
            self.normalize(data)

    def test_invalid_measurements_are_rejected(self):
        for invalid in [-1, float("nan"), float("inf"), True]:
            data = copy.deepcopy(self.payload)
            data["gsharp"]["paired"]["median_ns"] = invalid
            with self.assertRaises(ValueError):
                self.normalize(data)

    def test_absence_is_explicit(self):
        result = snapshot.unavailable("No artifact", "2026-01-01T00:00:00Z")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["scenarios"], [])
        self.assertIsNone(result["measurement"])


if __name__ == "__main__":
    unittest.main()
