#!/usr/bin/env python3
"""Regression tests for the self-migration per-app stage-floor ratchet."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "check_selfmig_stage_floor",
    REPO / "build" / "check-selfmig-stage-floor.py",
)
assert SPEC and SPEC.loader
ratchet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ratchet)


def stages(*statuses: str) -> list[dict]:
    return [
        {"stage": stage, "status": status}
        for stage, status in zip(ratchet.STAGE_ORDER, statuses)
    ]


def app(app_id: str, *statuses: str, succeeded: bool = False, unverified: bool = False) -> dict:
    return {
        "appId": app_id,
        "succeeded": succeeded,
        "unverified": unverified,
        "stages": stages(*statuses),
    }


class StageFloorTests(unittest.TestCase):
    def evaluate(self, floor: str, current: dict) -> tuple[int, str]:
        status, lines = ratchet.evaluate(
            {"greenApps": [], "stageFloor": {current["appId"]: floor}},
            {"apps": [current]},
        )
        return status, "\n".join(lines)

    def test_failed_floor_stage_counts_as_reached(self) -> None:
        status, output = self.evaluate(
            "compile",
            app("red", "passed", "failed", "skipped", "skipped"),
        )
        self.assertEqual(0, status)
        self.assertNotIn("GATE:", output)

    def test_red_app_cannot_regress(self) -> None:
        status, output = self.evaluate(
            "test-parity",
            app("red", "passed", "failed", "skipped", "skipped"),
        )
        self.assertEqual(1, status)
        self.assertIn("regressed below stage floor 'test-parity': reached 'compile'", output)

    def test_red_app_advancement_is_explicit_and_bankable(self) -> None:
        status, output = self.evaluate(
            "compile",
            app("red", "passed", "passed", "passed", "failed"),
        )
        self.assertEqual(0, status)
        self.assertIn("stage floor advanced", output)
        self.assertIn("red: compile -> test-parity", output)

    def test_red_app_becoming_green_is_explicit_and_bankable(self) -> None:
        status, output = self.evaluate(
            "test-parity",
            app("red", "passed", "passed", "passed", "passed", succeeded=True),
        )
        self.assertEqual(0, status)
        self.assertIn("move them to greenApps", output)
        self.assertIn("red: test-parity -> green", output)

    def test_skipped_and_not_applicable_stages_are_not_reached(self) -> None:
        for status_name in ("skipped", "not-applicable"):
            with self.subTest(status=status_name):
                status, output = self.evaluate(
                    "compile",
                    app(
                        "red",
                        "passed",
                        status_name,
                        "skipped",
                        "skipped",
                        succeeded=True,
                        unverified=True,
                    ),
                )
                self.assertEqual(1, status)
                self.assertIn("reached 'translate'", output)

    def test_skipped_stage_does_not_stop_later_stages(self) -> None:
        status, output = self.evaluate(
            "compile",
            app("red", "passed", "skipped", "passed", "failed"),
        )
        self.assertEqual(0, status)
        self.assertIn("red: compile -> test-parity", output)

    def test_missing_stage_row_fails_closed(self) -> None:
        current = app("red", "passed", "failed", "skipped", "skipped")
        current["stages"].pop()
        status, output = self.evaluate("compile", current)
        self.assertEqual(1, status)
        self.assertIn("invalid stage evidence", output)

    def test_failed_stage_cannot_hide_behind_succeeded_flag(self) -> None:
        status, output = self.evaluate(
            "compile",
            app("red", "passed", "failed", "skipped", "skipped", succeeded=True),
        )
        self.assertEqual(1, status)
        self.assertIn("statuses inconsistent with succeeded=true", output)

    def test_missing_floor_app_fails_closed(self) -> None:
        status, lines = ratchet.evaluate(
            {"greenApps": [], "stageFloor": {"removed": "compile"}},
            {"apps": []},
        )
        self.assertEqual(1, status)
        self.assertIn("missing from the run", "\n".join(lines))

    def test_new_red_app_absent_from_baseline_fails_closed(self) -> None:
        status, lines = ratchet.evaluate(
            {"greenApps": [], "stageFloor": {}},
            {"apps": [app("new", "passed", "failed", "skipped", "skipped")]},
        )
        output = "\n".join(lines)
        self.assertEqual(1, status)
        self.assertIn("new: compile", output)
        self.assertIn("GATE: corpus app 'new' (reached 'compile') is absent from the baseline", output)
        self.assertIn("GATE: discovered corpus app list (1 apps) differs from baseline (0 tracked apps).", output)

    def test_new_green_app_absent_from_baseline_fails_closed(self) -> None:
        status, lines = ratchet.evaluate(
            {"greenApps": [], "stageFloor": {}},
            {"apps": [app("new-green", "passed", "passed", "passed", "passed", succeeded=True)]},
        )
        output = "\n".join(lines)
        self.assertEqual(1, status)
        self.assertIn("GATE: corpus app 'new-green' (green) is absent from the baseline", output)
        self.assertIn("GATE: discovered corpus app list (1 apps) differs from baseline (0 tracked apps).", output)

    def test_checked_in_baseline_matches_pinned_csharp_corpus(self) -> None:
        manifest = json.loads((REPO / "tools" / "cs2gs" / "external" / "gsharp-csharp.json").read_text(encoding="utf-8"))
        commit = manifest["commit"]
        has_commit = subprocess.run(
            ["git", "-C", str(REPO), "cat-file", "-e", f"{commit}^{{commit}}"],
            capture_output=True,
        ).returncode == 0
        self.assertTrue(
            has_commit,
            f"Pinned corpus commit {commit} ({manifest['branch']}) is not available locally; "
            f"fetch {manifest['branch']} from {manifest['repository']} before running this check.",
        )
        corpus_apps = ratchet.expected_apps(REPO, commit)
        baseline = json.loads((REPO / "tools" / "cs2gs" / "selfmig-baseline.json").read_text(encoding="utf-8"))
        green_apps = baseline.get("greenApps", [])
        stage_floor = baseline.get("stageFloor", {})
        tracked = set(green_apps) | set(stage_floor)
        self.assertEqual(len(green_apps) + len(stage_floor), len(tracked))
        self.assertEqual(corpus_apps, tracked)

    def test_green_and_stage_floor_overlap_is_invalid(self) -> None:
        status, lines = ratchet.evaluate(
            {"greenApps": ["app"], "stageFloor": {"app": "compile"}},
            {"apps": [app("app", "passed", "passed", "passed", "passed", succeeded=True)]},
        )
        self.assertEqual(1, status)
        self.assertIn("both greenApps and stageFloor", "\n".join(lines))

    def test_unverified_green_app_fails_the_identity_ratchet(self) -> None:
        current = app(
            "green",
            "passed",
            "skipped",
            "passed",
            "passed",
            succeeded=True,
            unverified=True,
        )
        status, lines = ratchet.evaluate(
            {"greenApps": ["green"], "stageFloor": {}},
            {"apps": [current]},
        )
        self.assertEqual(1, status)
        self.assertIn("listed in greenApps but is not fully green", "\n".join(lines))

    def test_missing_green_app_fails_closed(self) -> None:
        status, lines = ratchet.evaluate(
            {"greenApps": ["missing"], "stageFloor": {}},
            {"apps": []},
        )
        self.assertEqual(1, status)
        self.assertIn("greenApps app 'missing' is missing from the run", "\n".join(lines))


if __name__ == "__main__":
    unittest.main()
