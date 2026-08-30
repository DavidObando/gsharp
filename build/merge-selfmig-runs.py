#!/usr/bin/env python3
"""Merge a translate-only migrate run.json with N validation shard run.jsons.

Issue #3668. The sharded self-migration gate splits one whole run into a single
whole-repository translate pass plus N per-app validation shards. This script
puts the pieces back together so the gate sees exactly the per-app verdicts a
single whole run would have produced:

  * the ``translate`` stage result always comes from the migrate pass (it is the
    only pass that ran it, and it must stay whole-repository so the linked
    source cross-check keeps working);
  * stages ``compile``/``ilverify``/``test-parity`` come from the shard that
    owned the app;
  * an app that failed translate was never handed to a shard, so its later
    stages are filled in as ``skipped`` — the same shape the whole run's
    short-circuit produces;
  * ``succeeded`` is the conjunction, ``unverified`` is recomputed with the
    whole run's rule (nothing failed, but something was skipped);
  * an app that translated but that no shard reported on is a sharding bug, not
    a green app: the merge fails loudly rather than silently shrinking the
    denominator or inflating the green count.
"""

import argparse
import json
import sys

TRANSLATE = "translate"
VALIDATION_STAGES = ("compile", "ilverify", "test-parity")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def stage_status(app: dict, name: str) -> str | None:
    for stage in app.get("stages", []):
        if stage.get("stage") == name:
            return stage.get("status")
    return None


def merge_app(migrate_app: dict, shard_app: dict | None) -> dict:
    stages = [s for s in migrate_app.get("stages", []) if s.get("stage") == TRANSLATE]
    translated = stage_status(migrate_app, TRANSLATE) == "passed"

    merged = {
        "appId": migrate_app["appId"],
        "succeeded": bool(migrate_app.get("succeeded", False)),
        "unverified": False,
        "failureCategory": migrate_app.get("failureCategory"),
        "stages": stages,
        "artifacts": list(migrate_app.get("artifacts", [])),
        "fingerprints": list(migrate_app.get("fingerprints", [])),
    }

    if not translated:
        # The whole run short-circuits after a failed stage; mirror that shape
        # so downstream report tooling sees the familiar four-stage row.
        merged["stages"] = stages + [
            {"stage": name, "status": "skipped", "artifactCount": 0}
            for name in VALIDATION_STAGES
        ]
        return merged

    if shard_app is None:
        raise SystemExit(
            f"merge-selfmig-runs: app '{migrate_app['appId']}' translated but no shard "
            "reported a result for it. Every translated app must be assigned to exactly "
            "one shard; a missing shard result would silently shrink the gate."
        )

    merged["stages"] = stages + list(shard_app.get("stages", []))
    merged["succeeded"] = bool(shard_app.get("succeeded", False))
    merged["artifacts"] += list(shard_app.get("artifacts", []))
    merged["fingerprints"] += list(shard_app.get("fingerprints", []))
    if not merged["succeeded"]:
        merged["failureCategory"] = shard_app.get("failureCategory")
    else:
        merged["failureCategory"] = None
    merged["unverified"] = merged["succeeded"] and any(
        stage.get("status") == "skipped" for stage in merged["stages"]
    )
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrate", required=True, help="the translate-only run.json")
    parser.add_argument("--out", required=True, help="the merged run.json to write")
    parser.add_argument("shards", nargs="+", help="one run.json per validation shard")
    args = parser.parse_args()

    migrate = load(args.migrate)

    shard_apps: dict[str, dict] = {}
    for path in args.shards:
        for app in load(path).get("apps", []):
            app_id = app["appId"]
            if app_id in shard_apps:
                raise SystemExit(
                    f"merge-selfmig-runs: app '{app_id}' was validated by more than one "
                    "shard; shard assignments must partition the app set."
                )
            shard_apps[app_id] = app

    merged_apps = [
        merge_app(app, shard_apps.pop(app["appId"], None)) for app in migrate.get("apps", [])
    ]

    if shard_apps:
        raise SystemExit(
            "merge-selfmig-runs: shards reported apps the migrate pass never saw: "
            + ", ".join(sorted(shard_apps))
        )

    merged = {
        "runId": migrate.get("runId"),
        "timestamp": migrate.get("timestamp"),
        "gscVersion": migrate.get("gscVersion"),
        "gscPath": migrate.get("gscPath"),
        # The migrate pass's own verdict still gates: it also covers the
        # repository-wide orphan-mirror and mirror-completeness checks, which
        # no shard can see.
        "succeeded": bool(migrate.get("succeeded", False))
        and all(app["succeeded"] for app in merged_apps),
        "unverified": False,
        "apps": merged_apps,
    }
    merged["unverified"] = merged["succeeded"] and any(
        app["unverified"] for app in merged_apps
    )

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, indent=2)
        handle.write("\n")

    green = sum(1 for app in merged_apps if app["succeeded"])
    print(
        f"merge-selfmig-runs: {len(merged_apps)} apps merged from "
        f"{len(args.shards)} shard(s); {green} green.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
