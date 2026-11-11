#!/usr/bin/env python3
"""Recover per-app wall times from a finished self-migration validation shard.

Issue #3721. ``build/generate-selfmig-shard-matrix.py`` can only balance the
gate's shards if it knows what each app actually costs, and the only place that
is knowable is the shard that just ran one. ``cs2gs validate`` processes its
apps sequentially and writes each app's triage directory as it finishes, so the
newest file under app N's directory marks the moment app N ended — and the gap
back to app N-1 is app N's wall time. That is measured on the runner, before
upload; the numbers are serialized here because artifact archives do not carry
mtimes through ``actions/upload-artifact``.

The first app is measured against ``--started``, the epoch second the shard
script captured immediately before invoking ``cs2gs validate``.

Output is ``{"<app id>": <seconds>, ...}`` on stdout, which the gate job merges
across shards into the run artifact's ``selfmig-shard-costs.json``. Apps that
produced no directory are simply absent — the matrix generator prices unknown
apps itself, and inventing a zero for them would be the one wrong answer.

Usage:
  derive-selfmig-app-durations.py --runs <shard runs dir> \\
      --manifests <migrate manifest run dir> --started <epoch seconds>
"""

import argparse
import json
import math
import os
from pathlib import Path


VALIDATION_STAGES = ("compile", "ilverify", "test-parity")


def newest_mtime(directory: Path) -> float:
    """The last moment anything was written anywhere under ``directory``."""
    newest = directory.stat().st_mtime
    for root, _, files in os.walk(directory):
        for name in files:
            try:
                newest = max(newest, os.stat(os.path.join(root, name)).st_mtime)
            except OSError:
                continue
    return newest


def completed_apps(runs_root: Path) -> set[str] | None:
    """Apps that completed every validation stage in the shard's run.json."""
    run_paths = sorted(runs_root.glob("*/run.json"))
    if not run_paths:
        return None
    try:
        run = json.loads(run_paths[-1].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    apps = run.get("apps") if isinstance(run, dict) else None
    if not isinstance(apps, list):
        return set()
    completed: set[str] = set()
    for app in apps:
        if not isinstance(app, dict) or not isinstance(app.get("appId"), str):
            continue
        if app.get("succeeded") is not True or app.get("unverified") is True:
            continue
        stages = app.get("stages")
        if not isinstance(stages, list):
            continue
        if [s.get("stage") if isinstance(s, dict) else None for s in stages] != list(VALIDATION_STAGES):
            continue
        if all(s.get("status") == "passed" for s in stages):
            completed.add(app["appId"])
    return completed


def app_ids_by_directory(manifest_dir: Path) -> dict[str, str]:
    """Maps artifact directory name to app id, from the migrate manifests.

    The shard writes its per-app directories under the same
    ``MigrationPipeline.ArtifactDirectoryName`` scheme the migrate pass used,
    so the manifests are an exact key without re-deriving the name hash.
    """
    names: dict[str, str] = {}
    for manifest_path in sorted(manifest_dir.glob("*/validation-context.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        app_id = manifest.get("appId")
        if app_id:
            names[manifest_path.parent.name] = app_id
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", required=True, help="the shard's artifacts root")
    parser.add_argument("--manifests", required=True, help="the migrate pass's manifest run directory")
    parser.add_argument("--started", type=float, required=True, help="epoch seconds before validate began")
    args = parser.parse_args()

    runs_root = Path(args.runs)
    names = app_ids_by_directory(Path(args.manifests))

    finished: list[tuple[float, str]] = []
    for app_dir in runs_root.glob("*/*/"):
        app_id = names.get(app_dir.name)
        if app_id:
            finished.append((newest_mtime(app_dir), app_id))

    completed = completed_apps(runs_root)
    durations: dict[str, float] = {}
    previous = args.started
    for moment, app_id in sorted(finished):
        # Clamp: a directory whose newest file predates the previous app's would
        # otherwise book a negative cost. Advance `previous` even for failed or
        # dependency-blocked apps so later apps on the shard do not inherit their
        # wall time, but record only positive complete-stage durations (#5884).
        duration = round(max(moment - previous, 0.0), 1)
        previous = max(previous, moment)
        if math.isfinite(duration) and duration > 0.0 and (completed is None or app_id in completed):
            durations[app_id] = duration

    print(json.dumps(durations, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
