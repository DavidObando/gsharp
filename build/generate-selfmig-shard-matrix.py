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

Issue #3721: shards are packed longest-processing-time-first (LPT greedy, which
is within 4/3 of optimal for makespan) over **observed per-app durations**, not
over a structural proxy. The proxy the first cut used — emitted G# file count
plus a flat test-project surcharge — mis-ranks by an order of magnitude, because
what an app actually costs is decided by how FAR down the stage list it gets: an
app that fails at compile stops in a couple of minutes no matter how large it
is, while one that reaches test-parity runs a whole migrated xUnit suite. Run
33433830972 packed six shards at 9m/13m/24m/51m/58m/68m under the proxy, and
the imbalance grows as the migration succeeds, because every app we fix moves
from the cheap bucket into the expensive one.

The durations come from ``build/selfmig-shard-costs.json``, refreshed by the
gate job (see ``--costs`` and ``build/derive-selfmig-app-durations.py``). The
generator NEVER hard-fails on a missing or stale map: an app with no recorded
duration is priced at the 75th percentile of the apps that do have one (a new
or newly-fixed app is far more likely to be expensive than free, and pricing it
high only costs us an early placement), and if there is no map at all the old
structural proxy is used for every app. Both fallbacks keep producing a valid
partition of the translated apps, which is the one property that must hold.
"""

import argparse
import json
from pathlib import Path

# A test project additionally restores, builds and runs xUnit under `dotnet
# test`; empirically that dwarfs the per-file compile cost, so it is modelled as
# a flat surcharge in "file-equivalents". Only used when no duration map is
# available at all.
TEST_PROJECT_SURCHARGE = 400

# Where an unpriced app is placed in the distribution of priced ones. High
# enough that a newly-green app is scheduled early rather than landing last on
# an already-full shard, low enough that a corpus addition does not get a shard
# to itself.
UNKNOWN_APP_PERCENTILE = 0.75

DEFAULT_COSTS = Path(__file__).resolve().parent / "selfmig-shard-costs.json"


def structural_weight(run_dir: Path, artifact_dir_name: str) -> float:
    """The pre-#3721 proxy: emitted file count plus a test-project surcharge."""
    manifest_path = run_dir / artifact_dir_name / "validation-context.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 1.0

    weight = float(len(manifest.get("emittedFiles", [])))
    if manifest.get("isTestProject"):
        weight += TEST_PROJECT_SURCHARGE
    return max(weight, 1.0)


def load_costs(path: Path) -> dict[str, float]:
    """Reads a per-app duration map, or returns {} when there is not one.

    Tolerates every way the file can be absent or malformed — a stale artifact,
    a truncated download, a hand-edit — because a scheduling hint must never be
    able to fail the gate it schedules.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    apps = document.get("apps") if isinstance(document, dict) else None
    if not isinstance(apps, dict):
        return {}

    costs: dict[str, float] = {}
    for app_id, seconds in apps.items():
        if isinstance(app_id, str) and isinstance(seconds, (int, float)) and seconds >= 0:
            costs[app_id] = float(seconds)
    return costs


def percentile(values: list[float], fraction: float) -> float:
    """Linear-interpolated percentile; ``values`` must be non-empty."""
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


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


def translated_apps(run: dict) -> list[str]:
    apps = []
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
        apps.append(app_id)
    return apps


def weigh(app_ids: list[str], costs: dict[str, float], structural) -> list[tuple[str, float]]:
    """Prices every app in seconds, in whichever currency is available."""
    known = [costs[app_id] for app_id in app_ids if app_id in costs]
    if not known:
        return [(app_id, structural(app_id)) for app_id in app_ids]

    unknown_cost = percentile(known, UNKNOWN_APP_PERCENTILE)
    return [(app_id, costs.get(app_id, unknown_cost)) for app_id in app_ids]


def pack(weighted: list[tuple[str, float]], shard_count: int) -> list[list[str]]:
    """Longest-processing-time-first greedy bin packing (makespan <= 4/3 OPT).

    Ties break on app id so the same corpus always produces the same matrix;
    a shard assignment that shuffled run to run would make a flaky app look
    like it belonged to a shard rather than to itself.
    """
    buckets: list[list[str]] = [[] for _ in range(shard_count)]
    loads = [0.0] * shard_count
    for app_id, weight in sorted(weighted, key=lambda item: (-item[1], item[0])):
        target = loads.index(min(loads))
        buckets[target].append(app_id)
        loads[target] += weight
    return buckets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, help="the migrate pass's run directory")
    parser.add_argument("--shards", type=int, default=6, help="number of validation shards")
    parser.add_argument(
        "--costs",
        default=str(DEFAULT_COSTS),
        help="per-app duration map (default: build/selfmig-shard-costs.json)",
    )
    parser.add_argument(
        "--plan",
        action="store_true",
        help="print the human-readable packing instead of the matrix JSON",
    )
    args = parser.parse_args()

    if args.shards < 1:
        raise SystemExit("generate-selfmig-shard-matrix: --shards must be >= 1.")

    run_dir = Path(args.run_dir)
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    names = artifact_dir_names(run_dir)

    app_ids = translated_apps(run)
    costs = load_costs(Path(args.costs))
    weighted = weigh(
        app_ids,
        costs,
        lambda app_id: structural_weight(run_dir, names.get(app_id, "")),
    )
    by_weight = dict(weighted)

    shard_count = min(args.shards, max(len(app_ids), 1))
    buckets = pack(weighted, shard_count)

    if args.plan:
        unit = "s" if costs else " file-equivalents"
        source = args.costs if costs else "structural proxy (no duration map)"
        print(f"cost source: {source}")
        print(f"apps: {len(app_ids)} ({len(costs.keys() & set(app_ids))} priced from observation)")
        for index, apps in enumerate(buckets):
            load = sum(by_weight[app_id] for app_id in apps)
            print(f"  shard {index + 1}: {load:9.1f}{unit}  {len(apps)} app(s)")
            for app_id in sorted(apps, key=lambda a: -by_weight[a]):
                print(f"      {by_weight[app_id]:9.1f}  {app_id}")
        loads = [sum(by_weight[a] for a in apps) for apps in buckets if apps]
        print(f"predicted critical path: {max(loads):.1f}{unit} "
              f"(perfect split would be {sum(loads) / len(loads):.1f}{unit})")
        return 0

    include = [
        {"name": str(index + 1), "apps": " ".join(sorted(apps))}
        for index, apps in enumerate(buckets)
        if apps
    ]
    print(json.dumps({"include": include}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
