#!/usr/bin/env python3
"""Gate tests for the ADR-0191 prerequisite spike runner."""

from __future__ import annotations

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
