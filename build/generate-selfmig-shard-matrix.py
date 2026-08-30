#!/usr/bin/env python3
"""Assign the self-migration gate's translated apps to N validation shards.

Issue #3668. The gate's cost is dominated by stages 2-4 (SDK compile, ILVerify,
``dotnet test`` parity), which are independent per app; translation stays one
whole-repository pass. This emits the GitHub Actions matrix the ``validate`` job
consumes, in the same shape ``build/generate-ci-test-matrix.py`` produces for
the unit-test shards.

Only apps that PASSED translate are assigned: an app that failed translate cost
seconds in the migrate job and already has its verdict, so scheduling it would
just move an empty result around.

Shards are balanced by estimated cost rather than round-robin, because the
distribution is extremely skewed — a test project pays for a full ``dotnet
test`` run while a small library pays for one compile. The estimate uses the
emitted G# file count from each app's ``validation-context.json`` plus a flat
test-project surcharge, and packs greedily longest-first (LPT), which keeps the
slowest shard close to optimal.
"""

import argparse
import json
from pathlib import Path

# A test project additionally restores, builds and runs xUnit under `dotnet
# test`; empirically that dwarfs the per-file compile cost, so it is modelled as
# a flat surcharge in "file-equivalents".
TEST_PROJECT_SURCHARGE = 400


def app_weight(run_dir: Path, artifact_dir_name: str) -> int:
    manifest_path = run_dir / artifact_dir_name / "validation-context.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 1

    weight = len(manifest.get("emittedFiles", []))
    if manifest.get("isTestProject"):
        weight += TEST_PROJECT_SURCHARGE
    return max(weight, 1)


def artifact_dir_names(run_dir: Path) -> dict[str, str]:
    """Maps app id to the artifact directory the migrate pass wrote for it.

    The name is ``<sanitized-id>-<8 hex of sha256(id)>`` (see
    ``MigrationPipeline.ArtifactDirectoryName``); rather than recompute the
    hash here, read each manifest's own ``appId`` so the two never drift.
    """
    names: dict[str, str] = {}
    for manifest_path in sorted(run_dir.glob("*/validation-context.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        app_id = manifest.get("appId")
        if app_id:
            names[app_id] = manifest_path.parent.name
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, help="the migrate pass's run directory")
    parser.add_argument("--shards", type=int, default=6, help="number of validation shards")
    args = parser.parse_args()

    if args.shards < 1:
        raise SystemExit("generate-selfmig-shard-matrix: --shards must be >= 1.")

    run_dir = Path(args.run_dir)
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    names = artifact_dir_names(run_dir)

    translated = []
    for app in run.get("apps", []):
        app_id = app["appId"]
        passed = any(
            stage.get("stage") == "translate" and stage.get("status") == "passed"
            for stage in app.get("stages", [])
        )
        if not passed:
            continue
        if " " in app_id:
            raise SystemExit(
                f"generate-selfmig-shard-matrix: app id '{app_id}' contains a space; "
                "shard app lists are space-separated."
            )
        translated.append((app_id, app_weight(run_dir, names.get(app_id, ""))))

    shard_count = min(args.shards, max(len(translated), 1))
    buckets: list[list[str]] = [[] for _ in range(shard_count)]
    loads = [0] * shard_count
    for app_id, weight in sorted(translated, key=lambda item: (-item[1], item[0])):
        target = loads.index(min(loads))
        buckets[target].append(app_id)
        loads[target] += weight

    include = [
        {"name": str(index + 1), "apps": " ".join(sorted(apps))}
        for index, apps in enumerate(buckets)
        if apps
    ]
    print(json.dumps({"include": include}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
