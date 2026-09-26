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

    def test_paired_checksum_corruption_fails_cross_runtime_parity(self) -> None:
        with self.assertRaisesRegex(SystemExit, "checksum differs across runtimes"):
            spike.validate_cross_runtime_checksums(
                performance_samples(corrupt_runtime="gsharp-aot")
            )

    def test_duplicate_performance_row_fails_exact_row_gate(self) -> None:
        with self.assertRaisesRegex(SystemExit, "duplicate perf row: slice-view"):
            spike.parse_perf(performance_output(duplicate="slice-view"))

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


if __name__ == "__main__":
    unittest.main()
