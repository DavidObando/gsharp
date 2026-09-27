#!/usr/bin/env python3
"""Gate tests for the ADR-0191 prerequisite spike runner."""

from __future__ import annotations

import importlib.util
import statistics
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "run_go2gs_prerequisite_spike",
    REPO / "build" / "run-go2gs-prerequisite-spike.py",
)
assert SPEC and SPEC.loader
spike = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(spike)


def semantic_output(*, mutation: str | None = None) -> str:
    lines = [f"semantic {name} ok" for name in spike.EXPECTED_SEMANTIC_ROWS]
    if mutation is not None:
        lines[0] = f"semantic {spike.EXPECTED_SEMANTIC_ROWS[0]} {mutation}"
    return "\n".join(["runtime test", *lines])


def performance_samples(*, launches: int = 1, corrupt_runtime: str | None = None):
    samples = {}
    for runtime in ("go", "gsharp-jit", "gsharp-aot"):
        samples[runtime] = []
        for _ in range(launches):
            rows = {}
            for name in spike.EXPECTED_ROWS:
                rows[name] = {
                    "elapsed_ticks": 1,
                    "timer_frequency": 1,
                    "operations": 1,
                    "allocated_bytes": 0,
                    "allocation_count": 0,
                    "ns_per_op": 1.0,
                    "bytes_per_op": 0.0,
                    "checksum": (
                        2 if runtime == corrupt_runtime and name == "slice-view" else 1
                    ),
                }
            samples[runtime].append(rows)
    return samples


def performance_output(*, duplicate: str | None = None) -> str:
    rows = [f"perf {name} 1 1 1 0 0 1" for name in spike.EXPECTED_ROWS]
    if duplicate is not None:
        rows.append(f"perf {duplicate} 1 1 1 0 0 1")
    return "\n".join(rows)


def make_asymmetric_timing_failure(
    samples,
    measured: str,
    control: str,
) -> None:
    for sample, measured_ns, control_ns in zip(
        samples["gsharp-jit"],
        (2.0, 120.0, 101.0),
        (1.0, 100.0, 1000.0),
        strict=True,
    ):
        sample[measured]["ns_per_op"] = measured_ns
        sample[control]["ns_per_op"] = control_ns


class Go2GsPrerequisiteSpikeTests(unittest.TestCase):
    def test_milestone_runs_require_five_launches(self) -> None:
        with self.assertRaisesRegex(ValueError, "milestone.*at least 5"):
            spike.validate_launch_count(3, no_aot=False)
        spike.validate_launch_count(3, no_aot=True)
        spike.validate_launch_count(5, no_aot=False)

    def test_empty_semantics_fail_the_non_empty_gate(self) -> None:
        with self.assertRaisesRegex(SystemExit, "must be non-empty"):
            spike.semantic_lines("runtime test\n", "go")

    def test_aot_only_semantic_drift_fails_cross_runtime_parity(self) -> None:
        with self.assertRaisesRegex(SystemExit, "gsharp-aot versus go"):
            spike.validate_semantics(
                {
                    "go": semantic_output(),
                    "gsharp-jit": semantic_output(),
                    "gsharp-aot": semantic_output(mutation="aot-drift"),
                }
            )

    def test_benchmark_launch_semantic_drift_fails_parity(self) -> None:
        expected = spike.semantic_lines(semantic_output(), "go")
        retained = []

        with self.assertRaisesRegex(SystemExit, "benchmark launch 1"):
            spike.retain_benchmark_launch(
                retained,
                semantic_output(mutation="launch-drift") + "\nperf malformed",
                "gsharp-jit",
                expected,
                1,
            )
        self.assertEqual(retained, [])

    def test_benchmark_launch_row_error_includes_launch_context(self) -> None:
        expected = spike.semantic_lines(semantic_output(), "go")

        with self.assertRaisesRegex(
            SystemExit,
            "gsharp-aot benchmark launch 4",
        ):
            spike.retain_benchmark_launch(
                [],
                "runtime test\nsemantic ",
                "gsharp-aot",
                expected,
                4,
            )

    def test_paired_checksum_corruption_fails_cross_runtime_parity(self) -> None:
        with self.assertRaisesRegex(SystemExit, "checksum differs across runtimes"):
            spike.validate_cross_runtime_checksums(
                performance_samples(corrupt_runtime="gsharp-aot")
            )

    def test_duplicate_performance_row_fails_exact_row_gate(self) -> None:
        with self.assertRaisesRegex(SystemExit, "duplicate perf row: slice-view"):
            spike.parse_perf(performance_output(duplicate="slice-view"))

    def test_malformed_performance_row_fails_exact_row_gate(self) -> None:
        with self.assertRaisesRegex(SystemExit, "malformed perf row: perf malformed"):
            spike.parse_perf(performance_output() + "\nperf malformed")

    def test_allocation_gate_checks_every_launch_not_only_the_median(self) -> None:
        samples = performance_samples(launches=5)
        samples["gsharp-jit"][0]["slice-view"]["allocated_bytes"] = 40
        samples["gsharp-jit"][1]["slice-view"]["allocated_bytes"] = 40

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "steady_state_allocated_bytes_zero"
            ]
        )

    def test_adapter_call_timing_gate_uses_paired_launch_ratio(self) -> None:
        samples = performance_samples(launches=3)
        make_asymmetric_timing_failure(
            samples,
            "adapt-reference",
            "nominal-reference",
        )

        status = spike.performance_gate_status(samples)

        self.assertLessEqual(
            statistics.median(
                sample["adapt-reference"]["ns_per_op"]
                for sample in samples["gsharp-jit"]
            )
            / statistics.median(
                sample["nominal-reference"]["ns_per_op"]
                for sample in samples["gsharp-jit"]
            ),
            1.10,
        )
        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "adapter_call_time_at_most_1_10x_named_control"
            ]
        )

    def test_adapter_construction_timing_gate_uses_paired_launch_ratio(self) -> None:
        samples = performance_samples(launches=3)
        make_asymmetric_timing_failure(
            samples,
            "adapt-create",
            "nominal-create",
        )

        status = spike.performance_gate_status(samples)

        self.assertLessEqual(
            statistics.median(
                sample["adapt-create"]["ns_per_op"]
                for sample in samples["gsharp-jit"]
            )
            / statistics.median(
                sample["nominal-create"]["ns_per_op"]
                for sample in samples["gsharp-jit"]
            ),
            1.10,
        )
        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "adapter_construction_time_at_most_1_10x_named_control"
            ]
        )

    def test_adapter_construction_allocation_must_match_control(self) -> None:
        samples = performance_samples()
        samples["gsharp-jit"][0]["adapt-create"]["allocated_bytes"] = 24

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "adapter_construction_allocation_matches_named_control_each_launch"
            ]
        )

    def test_adapter_construction_allocation_requires_matching_operation_counts(self) -> None:
        samples = performance_samples()
        sample = samples["gsharp-jit"][0]
        sample["adapt-create"]["allocated_bytes"] = 24
        sample["nominal-create"]["allocated_bytes"] = 24
        sample["nominal-create"]["operations"] = 2

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "adapter_construction_allocation_matches_named_control_each_launch"
            ]
        )

    def test_managed_handle_allocation_must_stay_within_40_bytes_per_operation(self) -> None:
        samples = performance_samples()
        samples["gsharp-jit"][0]["managed-retained"]["allocated_bytes"] = 41

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "managed_handle_allocation_at_most_40_bytes_per_operation_each_launch"
            ]
        )

    def test_warmed_managed_identity_must_allocate_zero(self) -> None:
        samples = performance_samples()
        samples["gsharp-aot"][0]["managed-warmed-identity"]["allocated_bytes"] = 1

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-aot"]["checks"][
                "managed_warmed_identity_allocated_bytes_zero"
            ]
        )

    def test_shared_root_rich_allocation_must_match_named_control(self) -> None:
        samples = performance_samples()
        samples["gsharp-aot"][0]["rich-create-multi"]["allocated_bytes"] = 40
        samples["gsharp-aot"][0]["manual-rich-create-multi"]["allocated_bytes"] = 39

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-aot"]["checks"][
                "rich_shared_root_allocation_matches_named_controls_each_launch"
            ]
        )

    def test_allocation_gates_ignore_sub_byte_per_operation_measurement_overhead(self) -> None:
        samples = performance_samples()
        for runtime in ("gsharp-jit", "gsharp-aot"):
            sample = samples[runtime][0]
            for name in spike.MANAGED_HANDLE_ALLOCATION_ROWS:
                sample[name]["operations"] = 2_000_000
                sample[name]["allocated_bytes"] = 80_000_080
            sample["managed-warmed-identity"]["operations"] = 2_000_000
            sample["managed-warmed-identity"]["allocated_bytes"] = 40
            for measured, control in spike.RICH_SHARED_ROOT_ALLOCATION_PAIRS:
                sample[measured]["operations"] = 2_000_000
                sample[control]["operations"] = 2_000_000
                sample[measured]["allocated_bytes"] = 48_000_048
                sample[control]["allocated_bytes"] = 48_000_040

        status = spike.performance_gate_status(samples)

        self.assertTrue(status["native_control_gate_passed"])

    def test_fractional_managed_allocation_over_budget_fails(self) -> None:
        samples = performance_samples()
        sample = samples["gsharp-jit"][0]["managed-retained"]
        sample["operations"] = 2
        sample["allocated_bytes"] = 81

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "managed_handle_allocation_at_most_40_bytes_per_operation_each_launch"
            ]
        )

    def test_fractional_warmed_identity_allocation_fails(self) -> None:
        samples = performance_samples()
        sample = samples["gsharp-aot"][0]["managed-warmed-identity"]
        sample["operations"] = 3
        sample["allocated_bytes"] = 1

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-aot"]["checks"][
                "managed_warmed_identity_allocated_bytes_zero"
            ]
        )

    def test_fractional_rich_control_allocation_difference_fails(self) -> None:
        samples = performance_samples()
        sample = samples["gsharp-jit"][0]
        sample["rich-create"]["operations"] = 2
        sample["manual-rich-create"]["operations"] = 2
        sample["rich-create"]["allocated_bytes"] = 81
        sample["manual-rich-create"]["allocated_bytes"] = 80

        status = spike.performance_gate_status(samples)

        self.assertFalse(
            status["runtimes"]["gsharp-jit"]["checks"][
                "rich_shared_root_allocation_matches_named_controls_each_launch"
            ]
        )


if __name__ == "__main__":
    unittest.main()
