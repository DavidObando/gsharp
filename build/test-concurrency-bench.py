#!/usr/bin/env python3
"""Deterministic tests for the ADR-0174 benchmark methodology."""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRATCH = REPO / "out" / "test-concurrency-bench"
SPEC = importlib.util.spec_from_file_location(
    "run_concurrency_bench",
    REPO / "build" / "run-concurrency-bench.py",
)
assert SPEC and SPEC.loader
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)
DASHBOARD_SPEC = importlib.util.spec_from_file_location(
    "generate_quality_dashboard",
    REPO / "build" / "generate-quality-dashboard.py",
)
assert DASHBOARD_SPEC and DASHBOARD_SPEC.loader
dashboard = importlib.util.module_from_spec(DASHBOARD_SPEC)
DASHBOARD_SPEC.loader.exec_module(dashboard)


class ConcurrencyBenchTests(unittest.TestCase):
    def setUp(self) -> None:
        shutil.rmtree(SCRATCH, ignore_errors=True)
        SCRATCH.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(SCRATCH, ignore_errors=True)

    def test_runtime_configuration_replaces_ambient_jit_overrides(self) -> None:
        original = {
            "PATH": "/bin",
            "DOTNET_TIEREDCOMPILATION": "0",
            "COMPlus_TC_CallCountingDelayMs": "999",
            "COMPlus_JitStress": "2",
            "COMPLUS_READYTORUN": "0",
            "DOTNET_ALTJIT": "clrjit_unstable",
            "GSHARP_BENCH_SCENARIO": "closed-recv",
        }

        configured, removed = bench.clean_runtime_environment(original, pinned=True)

        self.assertEqual("/bin", configured["PATH"])
        self.assertEqual(bench.PINNED_TIER_ENV, {
            key: configured[key] for key in bench.PINNED_TIER_ENV
        })
        self.assertNotIn("COMPlus_TC_CallCountingDelayMs", configured)
        self.assertNotIn("COMPlus_JitStress", configured)
        self.assertNotIn("GSHARP_BENCH_SCENARIO", configured)
        self.assertEqual("0", removed["DOTNET_TIEREDCOMPILATION"])
        self.assertEqual("999", removed["COMPlus_TC_CallCountingDelayMs"])
        self.assertEqual("2", removed["COMPlus_JitStress"])
        self.assertEqual("0", removed["COMPLUS_READYTORUN"])
        self.assertEqual("clrjit_unstable", removed["DOTNET_ALTJIT"])
        self.assertEqual("0", original["DOTNET_TIEREDCOMPILATION"])

    def test_raw_launch_samples_survive_summary_and_aggregation(self) -> None:
        first = bench.summarize({"select-ready": [151.0, 152.0, 153.0]})
        second = bench.summarize({"select-ready": [154.0, 155.0, 156.0]})

        combined = bench.aggregate([first, second])["select-ready"]

        self.assertEqual([151.0, 152.0, 153.0, 154.0, 155.0, 156.0], combined["launch_samples_ns"])
        self.assertEqual([152.0, 155.0], combined["run_medians_ns"])
        self.assertEqual(6, combined["samples"])
        self.assertEqual(2, combined["runs"])

    def test_fingerprint_separates_comparison_methodology_from_build_identity(self) -> None:
        environment = {
            "cpuAffinity": [0, 1],
            "power": {"governors": ["performance"], "scalingDrivers": ["intel_pstate"]},
        }
        hashes = {
            "gsc": "gsc-hash",
            "Bench.dll": "bench-hash",
            "Gsharp.Extensions.dll": "extensions-hash",
            "Gsharp.Runtime.Channels.dll": "runtime-hash",
            "Bench": "aot-hash",
            "BenchAot.csproj": "aot-project-hash",
            "baseline": "go-hash",
        }

        with (
            mock.patch.object(bench, "definition_hash", return_value="definition"),
            mock.patch.object(bench, "warmup_configuration", return_value={"rounds": 120, "ops": 4000}),
            mock.patch.object(bench, "hardware_class", return_value="test-host"),
            mock.patch.object(bench, "cpu_model", return_value="Test CPU"),
            mock.patch.object(bench.platform, "system", return_value="Linux"),
            mock.patch.object(bench.platform, "release", return_value="test-kernel"),
            mock.patch.object(bench.platform, "machine", return_value="x86_64"),
            mock.patch.object(bench.os, "cpu_count", return_value=2),
            mock.patch.object(bench, "command_output", side_effect=["10.0.400", "go1.27"]),
            mock.patch.object(bench, "git_value", side_effect=["", "commit"]),
            mock.patch.object(bench, "gsc_informational_version", return_value="0.4.test"),
            mock.patch.object(bench, "sha256", side_effect=lambda path: hashes.get(path.name)),
        ):
            fingerprint = bench.make_fingerprint(
                gsc=Path("gsc"),
                extensions=Path("Gsharp.Extensions.dll"),
                assembly=Path("Bench.dll"),
                aot_binary=Path("Bench"),
                go_binary=Path("baseline"),
                launches=7,
                scenario="select-ready",
                modes=["gsharp", "gsharp_aot", "go"],
                runtime_versions={
                    "gsharp": ["10.0.11"],
                    "gsharp_aot": ["10.0.11"],
                    "go": ["go1.27"],
                },
                processor_counts={"gsharp": [2], "gsharp_aot": [2], "go": [2]},
                runtime_environment={
                    **bench.PINNED_TIER_ENV,
                    "COMPLUS_GCSERVER": "1",
                },
                removed_runtime_settings={"COMPlus_JitStress": "2"},
                start_environment=environment,
                end_environment=environment,
            )

        self.assertTrue(fingerprint["comparable"])
        self.assertEqual("tiered-pgo-steady-state", fingerprint["comparison"]["jitMode"])
        self.assertEqual(["10.0.11"], fingerprint["comparison"]["toolchains"]["dotnetRuntime"])
        self.assertEqual(["10.0.11"], fingerprint["comparison"]["toolchains"]["nativeAotRuntime"])
        self.assertEqual(["go1.27"], fingerprint["comparison"]["toolchains"]["go"])
        self.assertEqual(3, fingerprint["comparison"]["goWarmupRounds"])
        self.assertEqual("0.4.test", fingerprint["build"]["gscInformationalVersion"])
        self.assertEqual("bench-hash", fingerprint["build"]["artifacts"]["Bench.dll"])
        self.assertEqual("aot-hash", fingerprint["build"]["artifacts"]["NativeAOT"])
        self.assertEqual("aot-project-hash", fingerprint["comparison"]["aotProjectSha256"])
        self.assertFalse(fingerprint["build"]["gitDirty"])
        self.assertEqual("1", fingerprint["comparison"]["runtimeEnvironment"]["COMPLUS_GCSERVER"])
        self.assertNotEqual(fingerprint["comparisonKey"], fingerprint["aggregationKey"])
        self.assertTrue(fingerprint["runId"])
        self.assertEqual(1, fingerprint["comparison"]["wholeRuns"])
        self.assertEqual("bootstrap-launch-median", fingerprint["comparison"]["intervalMethod"])

        second_fingerprint = json.loads(json.dumps(fingerprint))
        second_fingerprint["runId"] = "second-run"
        aggregated = bench.aggregate_fingerprint([fingerprint, second_fingerprint])
        self.assertEqual(2, aggregated["comparison"]["wholeRuns"])
        self.assertEqual("range-of-run-medians", aggregated["comparison"]["intervalMethod"])
        self.assertNotEqual(fingerprint["comparisonKey"], aggregated["comparisonKey"])
        self.assertEqual([fingerprint["runId"], "second-run"], aggregated["sourceRunIds"])

        second_fingerprint["comparable"] = False
        second_fingerprint["incomparabilityReasons"] = ["power state changed"]
        mixed = bench.aggregate_fingerprint([fingerprint, second_fingerprint])
        self.assertFalse(mixed["comparable"])
        self.assertEqual(["power state changed"], mixed["incomparabilityReasons"])

        preserved = {
            "select-ready": {
                "median_ns": 72.0,
                "ci95_ns": [70.0, 74.0],
                "samples": 21,
                "runs": 3,
                "run_medians_ns": [70.0, 72.0, 74.0],
            }
        }
        self.assertIs(preserved, bench.combine_loaded_runs([preserved]))

    def test_json_aggregation_rejects_different_build_or_methodology_keys(self) -> None:
        common = {
            "hardwareClass": "test-host",
            "gsharp": {
                "select-ready": {
                    "median_ns": 152.0,
                    "ci95_ns": [151.0, 153.0],
                    "samples": 3,
                    "launch_samples_ns": [151.0, 152.0, 153.0],
                }
            },
        }
        second_run = json.loads(json.dumps(common))
        second_run["gsharp"]["select-ready"]["median_ns"] = 153.0
        first = SCRATCH / "first.json"
        second = SCRATCH / "second.json"
        first.write_text(json.dumps({**common, "aggregationKey": "same"}))
        second.write_text(json.dumps({**second_run, "aggregationKey": "same"}))

        gsharp, _, _, hardware, _ = bench.load_runs([str(first), str(second)])
        self.assertEqual("test-host", hardware)
        self.assertEqual(2, len(gsharp))
        with self.assertRaisesRegex(SystemExit, "duplicate --from-json path"):
            bench.load_runs([str(first), str(first)])
        second.write_text(first.read_text())
        with self.assertRaisesRegex(SystemExit, "duplicate benchmark evidence"):
            bench.load_runs([str(first), str(second)])

        second.write_text(json.dumps({**second_run, "aggregationKey": "different"}))
        with self.assertRaisesRegex(SystemExit, "incomparable benchmark runs"):
            bench.load_runs([str(first), str(second)])

        first.write_text(json.dumps(common))
        second.write_text(json.dumps(common))
        bench.load_runs([str(first)])
        with self.assertRaisesRegex(SystemExit, "no aggregationKey"):
            bench.load_runs([str(first), str(second)])

        incomparable = {
            **common,
            "aggregationKey": "same",
            "fingerprint": {
                "runId": "incomparable-1",
                "comparable": False,
                "incomparabilityReasons": ["power state changed"],
            },
        }
        first.write_text(json.dumps(incomparable))
        second_incomparable = {
            **second_run,
            "aggregationKey": "same",
            "fingerprint": {
                "runId": "incomparable-2",
                "comparable": False,
                "incomparabilityReasons": ["power state changed"],
            },
        }
        second.write_text(json.dumps(second_incomparable))
        bench.load_runs([str(first)])
        with self.assertRaisesRegex(SystemExit, "power state changed"):
            bench.load_runs([str(first), str(second)])
        gsharp, _, _, _, metadata = bench.load_runs(
            [str(first), str(second)],
            allow_incomparable=True,
        )
        self.assertEqual(2, len(gsharp))
        self.assertEqual(2, len(metadata["sourceFingerprints"]))

        aggregate_payload = {
            **common,
            "aggregationKey": "aggregate",
            "fingerprint": {
                "comparison": {"wholeRuns": 2},
                "comparable": True,
            },
            "sourceFingerprints": [{"id": 1}, {"id": 2}],
            "sourceEnvironments": [{"id": 1}, {"id": 2}],
            "sourceLaunchOrders": [[["gsharp"]], [["gsharp"]]],
        }
        first.write_text(json.dumps(aggregate_payload))
        _, _, _, _, metadata = bench.load_runs([str(first)])
        self.assertEqual([{"id": 1}, {"id": 2}], metadata["sourceFingerprints"])
        self.assertEqual([{"id": 1}, {"id": 2}], metadata["environments"])
        self.assertEqual([[["gsharp"]], [["gsharp"]]], metadata["launchOrders"])
        self.assertEqual(2, metadata["effectiveFingerprints"][0]["comparison"]["wholeRuns"])

        direct_fingerprint = {
            "runId": "same-run",
            "comparison": {"wholeRuns": 1},
            "comparable": True,
        }
        first.write_text(json.dumps({
            **common,
            "aggregationKey": "same",
            "fingerprint": direct_fingerprint,
        }))
        second.write_text(json.dumps({
            **second_run,
            "aggregationKey": "same",
            "fingerprint": direct_fingerprint,
            "sourceFingerprints": [direct_fingerprint],
        }))
        with self.assertRaisesRegex(SystemExit, "duplicate source run evidence"):
            bench.load_runs([str(first), str(second)])

    def test_baseline_without_comparison_key_is_report_only(self) -> None:
        result = {"median_ns": 200.0, "ci95_ns": [190.0, 210.0], "samples": 3}
        baseline = {
            "hardwareClass": "test-host",
            "scenarios": {
                "select-ready": {
                    "ceiling_ns": 100.0,
                    "ci95_ns": [90.0, 100.0],
                }
            },
        }
        output = io.StringIO()

        with redirect_stdout(output):
            failures = bench.check(
                baseline,
                {"select-ready": result},
                {},
                [{"name": "select-ready"}],
                "test-host",
                "new-key",
            )

        self.assertEqual(0, failures)
        self.assertIn("baseline has no comparison fingerprint", output.getvalue())
        self.assertIn("report-only", output.getvalue())

    def test_baseline_update_requires_all_scenarios_and_modes(self) -> None:
        full = {"comparison": {
            "scenario": "all",
            "modes": ["gsharp", "gsharp_aot", "go"],
            "wholeRuns": 3,
            "intervalMethod": "range-of-run-medians",
        }}
        partial = {"comparison": {
            "scenario": "select-ready",
            "modes": ["gsharp"],
            "wholeRuns": 1,
            "intervalMethod": "bootstrap-launch-median",
        }}

        self.assertTrue(bench.complete_baseline_fingerprint(full))
        self.assertFalse(bench.complete_baseline_fingerprint(partial))
        scenarios = [{"name": "paired", "go": "go-paired"}, {"name": "jit-only", "go": None}]
        with mock.patch.object(bench, "load_scenarios", return_value=scenarios):
            self.assertTrue(bench.complete_baseline_results(
                {"paired": {}, "jit-only": {}},
                {"paired": {}, "jit-only": {}},
                {"go-paired": {}},
            ))
            self.assertFalse(bench.complete_baseline_results(
                {"paired": {}, "jit-only": {}},
                {"paired": {}},
                {"go-paired": {}},
            ))
        self.assertEqual("jit=unknown (legacy evidence)", bench.methodology_label(None))
        self.assertEqual("jit=tiered-pgo delay=0", bench.methodology_label({"comparison": {}}))

    def test_missing_power_or_changing_processor_count_marks_run_incomparable(self) -> None:
        start = {
            "cpuAffinity": [0, 1],
            "power": {"governors": [], "scalingDrivers": [], "powerSource": None},
        }

        reasons = bench.incomparability_reasons(
            start,
            start,
            {"gsharp": ["10.0.11", "10.0.12"]},
            {"gsharp": [2, 4]},
            "unknown-cpu",
        )

        self.assertIn("the host exposes no observable power-state identity", reasons)
        self.assertIn("the host exposes no identifiable CPU model", reasons)
        self.assertTrue(any("different runtime versions" in reason for reason in reasons))
        self.assertTrue(any("different processor counts" in reason for reason in reasons))

        with (
            mock.patch.object(bench.os, "getloadavg", side_effect=AttributeError, create=True),
            mock.patch.object(bench, "power_state", return_value=start["power"]),
        ):
            self.assertIsNone(bench.environment_sample()["loadAverage"])

        arm = """
            processor       : 0
            CPU implementer : 0x41
            CPU architecture: 8
            CPU part        : 0xd0c
        """
        self.assertEqual(
            "Neoverse N1",
            bench.parse_linux_cpu_model(arm, "Architecture: aarch64\nModel name: Neoverse N1"),
        )
        self.assertEqual(
            "cpu implementer=0x41 cpu architecture=8 cpu part=0xd0c",
            bench.parse_linux_cpu_model(arm, None),
        )

    def test_git_state_distinguishes_clean_from_unavailable(self) -> None:
        clean = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(bench.subprocess, "run", return_value=clean):
            self.assertEqual("", bench.git_value("status", "--porcelain"))

        with mock.patch.object(bench.subprocess, "run", side_effect=OSError):
            self.assertIsNone(bench.git_value("status", "--porcelain"))

    def test_each_launch_must_emit_its_expected_rows(self) -> None:
        spec = {"name": "gsharp", "expectedRows": {"buf64", "select-ready"}}
        bench.validate_rows(spec, {"buf64": 1.0, "select-ready": 2.0})

        with self.assertRaisesRegex(SystemExit, "missing=\\['select-ready'\\]"):
            bench.validate_rows(spec, {"buf64": 1.0})

        header = bench.GO_RUNTIME_ROW.match("go=go1.27.0 numcpu=18 gomaxprocs=6")
        self.assertIsNotNone(header)
        self.assertEqual("6", header["cores"])
        development = bench.GO_RUNTIME_ROW.match(
            "go=devel go1.28-abcdef Mon Sep 7 numcpu=18 gomaxprocs=6"
        )
        self.assertEqual("devel go1.28-abcdef Mon Sep 7", development["version"])

        with self.assertRaisesRegex(SystemExit, "divisible by the 2 measured modes"):
            bench.measure_modes([{"name": "a"}, {"name": "b"}], 3)

    def test_dashboard_accepts_additive_result_schema(self) -> None:
        results = SCRATCH / "results.json"
        results.write_text(json.dumps({
            "schemaVersion": 2,
            "hardwareClass": "test-host",
            "comparisonKey": "key",
            "fingerprint": {"comparison": {}, "build": {}},
            "gsharp": {
                "select-ready": {
                    "median_ns": 72.0,
                    "ci95_ns": [70.0, 74.0],
                    "samples": 3,
                    "launch_samples_ns": [70.0, 72.0, 74.0],
                }
            },
            "gsharp_aot": {},
            "go": {},
        }))

        metrics = dashboard.concurrency_metrics(results)

        self.assertEqual("test-host", metrics["hardwareClass"])
        row = next(row for row in metrics["scenarios"] if row["name"] == "select-ready")
        self.assertEqual(72.0, row["medianNs"])


if __name__ == "__main__":
    unittest.main()
