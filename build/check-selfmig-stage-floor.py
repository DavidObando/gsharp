#!/usr/bin/env python3
"""Apply the per-app self-migration stage-floor ratchet."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

STAGE_ORDER = ("translate", "compile", "ilverify", "test-parity")
ATTEMPTED_STATUSES = {"passed", "failed"}
UNREACHED_STATUSES = {"skipped", "not-applicable"}
VALID_STATUSES = ATTEMPTED_STATUSES | UNREACHED_STATUSES


def reached_stage(app: dict) -> tuple[str | None, str | None]:
    """Return the furthest attempted stage, or an error for a malformed row."""
    stages = app.get("stages")
    if not isinstance(stages, list):
        return None, "stages must be an array"

    names = [stage.get("stage") if isinstance(stage, dict) else None for stage in stages]
    if names != list(STAGE_ORDER):
        return None, (
            "stage rows must appear exactly once in fixed order "
            + " -> ".join(STAGE_ORDER)
        )

    reached = None
    stopped = False
    for stage_name, stage in zip(STAGE_ORDER, stages):
        status = stage.get("status")
        if status not in VALID_STATUSES:
            return None, f"stage '{stage_name}' has unknown status {status!r}"
        if status in ATTEMPTED_STATUSES:
            if stopped:
                return None, f"stage '{stage_name}' was attempted after the pipeline stopped"
            reached = stage_name
            if status == "failed":
                stopped = True
        else:
            stopped = True

    return reached, None


def evaluate(baseline: dict, run: dict) -> tuple[int, list[str]]:
    """Return the gate status and deterministic diagnostic lines."""
    errors: list[str] = []
    advanced: list[str] = []
    promoted: list[str] = []
    untracked: list[str] = []

    floors = baseline.get("stageFloor", {})
    if not isinstance(floors, dict):
        return 1, ["GATE: stageFloor must be a JSON object keyed by app id."]

    green_apps = baseline.get("greenApps", [])
    if not isinstance(green_apps, list) or any(not isinstance(app, str) for app in green_apps):
        return 1, ["GATE: greenApps must be an array of app-id strings."]
    green_set = set(green_apps)

    for app_id, floor in sorted(floors.items()):
        if not isinstance(app_id, str) or not isinstance(floor, str):
            errors.append("GATE: every stageFloor entry must map an app-id string to a stage string.")
            continue
        if floor not in STAGE_ORDER:
            errors.append(
                f"GATE: stageFloor app '{app_id}' names unknown stage '{floor}'; "
                f"expected one of {', '.join(STAGE_ORDER)}."
            )
        if app_id in green_set:
            errors.append(
                f"GATE: app '{app_id}' appears in both greenApps and stageFloor; "
                "green apps belong only in greenApps."
            )

    apps = run.get("apps")
    if not isinstance(apps, list):
        return 1, errors + ["GATE: run.json apps must be an array."]

    by_id: dict[str, dict] = {}
    for app in apps:
        if not isinstance(app, dict) or not isinstance(app.get("appId"), str):
            errors.append("GATE: every run app must be an object with a string appId.")
            continue
        app_id = app["appId"]
        if app_id in by_id:
            errors.append(f"GATE: run.json contains duplicate app row '{app_id}'.")
            continue
        by_id[app_id] = app

    reached: dict[str, str | None] = {}
    green: dict[str, bool] = {}
    for app_id, app in sorted(by_id.items()):
        current, error = reached_stage(app)
        if error:
            errors.append(f"GATE: app '{app_id}' has invalid stage evidence: {error}.")
            continue

        succeeded = app.get("succeeded")
        unverified = app.get("unverified")
        if not isinstance(succeeded, bool) or not isinstance(unverified, bool):
            errors.append(
                f"GATE: app '{app_id}' must carry boolean succeeded and unverified fields."
            )
            continue

        statuses = [stage["status"] for stage in app["stages"]]
        if "failed" in statuses:
            consistent = not succeeded and not unverified
        elif any(status in UNREACHED_STATUSES for status in statuses):
            consistent = succeeded and unverified
        else:
            consistent = succeeded and not unverified
        if not consistent:
            errors.append(
                f"GATE: app '{app_id}' has stage statuses inconsistent with "
                f"succeeded={str(succeeded).lower()}, unverified={str(unverified).lower()}."
            )
            continue

        reached[app_id] = current
        green[app_id] = succeeded and not unverified

    for app_id, floor in sorted(floors.items()):
        if floor not in STAGE_ORDER or app_id in green_set:
            continue
        app = by_id.get(app_id)
        if app is None:
            errors.append(
                f"GATE: stageFloor app '{app_id}' is missing from the run; "
                "remove it only as an explicit corpus re-baseline."
            )
            continue
        if app_id not in reached:
            continue

        if green[app_id]:
            promoted.append(f"  + {app_id}: {floor} -> green")
            continue

        current = reached[app_id]
        current_ordinal = STAGE_ORDER.index(current) if current is not None else -1
        floor_ordinal = STAGE_ORDER.index(floor)
        if current_ordinal < floor_ordinal:
            errors.append(
                f"GATE: app '{app_id}' regressed below stage floor '{floor}': "
                f"reached '{current or 'none'}'."
            )
        elif current_ordinal > floor_ordinal:
            advanced.append(f"  + {app_id}: {floor} -> {current}")

    tracked = set(floors) | green_set
    for app_id in sorted(by_id):
        if app_id not in reached or green[app_id] or app_id in tracked:
            continue
        untracked.append(f"  ? {app_id}: {reached[app_id] or 'none'}")

    lines: list[str] = []
    if advanced:
        lines.append("self-migration: stage floor advanced (update stageFloor to bank it):")
        lines.extend(advanced)
    if promoted:
        lines.append(
            "self-migration: stage-floor app(s) are now green "
            "(move them to greenApps to bank it):"
        )
        lines.extend(promoted)
    if untracked:
        lines.append(
            "self-migration: red app(s) have no stageFloor entry "
            "(add their reached stage to bank it):"
        )
        lines.extend(untracked)
    lines.extend(errors)
    return (1 if errors else 0), lines


def load_json(path: str) -> dict:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--run", required=True)
    args = parser.parse_args()

    try:
        status, lines = evaluate(load_json(args.baseline), load_json(args.run))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"GATE: could not evaluate stageFloor: {error}", file=sys.stderr)
        return 1

    for line in lines:
        print(line, file=sys.stderr if line.startswith("GATE:") else sys.stdout)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
