#!/usr/bin/env python3
"""Accept a cs2gs migrate run for stage-2 certification.

`cs2gs migrate` exits 1 when any app fails any stage. The certification only
needs a tree that translated, compiled and passed IL verification everywhere.
Test parity is re-established by the controller's own stage-2 test run: the
integrated script stops migration after ILVerify (`--stopped-after-ilverify`
requires every parity row to be `skipped`); a full run tolerates only
`test-parity` failures (listed).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REQUIRED = ("translate", "compile", "ilverify")
KNOWN_STAGES = frozenset({*REQUIRED, "test-parity"})


def check(summary: Any, stopped_after_ilverify: bool = False,
          required_apps: tuple[str, ...] = (), minimum_apps: int = 1) -> list[str]:
    """Return the apps whose only failure is test parity; raise on anything else."""
    if not isinstance(summary, dict) or not isinstance(summary.get("apps"), list) \
            or not summary["apps"]:
        raise ValueError("migration summary has no apps")
    parity_only = []
    present = {app.get("appId") for app in summary["apps"]}
    if len(present) != len(summary["apps"]) or len(present) < minimum_apps:
        raise ValueError(
            f"migration summary has {len(summary['apps'])} apps ({len(present)} unique), "
            f"expected at least {minimum_apps}")
    missing = sorted(set(required_apps) - present)
    if missing:
        raise ValueError(f"migration summary lacks required apps: {missing[:5]}")
    for app in summary["apps"]:
        stages: dict[Any, Any] = {}
        for row in app.get("stages", []):
            name = row.get("stage") if isinstance(row, dict) else None
            if name not in KNOWN_STAGES:
                raise ValueError(f"{app.get('appId')}: unknown stage {name!r}")
            if name in stages:
                raise ValueError(f"{app.get('appId')}: duplicate stage {name!r}")
            stages[name] = row.get("status")
        for stage in REQUIRED:
            if stages.get(stage) != "passed":
                raise ValueError(
                    f"{app.get('appId')}: {stage} is {stages.get(stage)!r}, not 'passed'")
        parity = stages.get("test-parity")
        if stopped_after_ilverify:
            # `cs2gs migrate --stop-after ilverify` never runs parity: every app
            # must report it as skipped, and nothing else.
            if parity != "skipped":
                raise ValueError(
                    f"{app.get('appId')}: test-parity is {parity!r}, expected 'skipped' "
                    "for a run stopped after ilverify")
        elif parity == "failed":
            parity_only.append(str(app.get("appId")))
        elif parity != "passed":
            raise ValueError(
                f"{app.get('appId')}: test-parity is {parity!r}; only 'passed' or 'failed' is accepted")
    return parity_only


def main(argv: list[str]) -> int:
    stopped = False
    required: list[str] = []
    minimum = 1
    paths: list[str] = []
    items = iter(argv)
    for item in items:
        if item == "--stopped-after-ilverify":
            stopped = True
        elif item == "--require-app":
            required.append(next(items, ""))
        elif item == "--min-apps":
            value = next(items, "")
            if not value.isdigit():
                print("verify-migration-run: --min-apps needs a number", file=sys.stderr)
                return 2
            minimum = int(value)
        else:
            paths.append(item)
    if len(paths) != 1 or "" in required:
        print("usage: verify-migration-run.py [--stopped-after-ilverify] [--min-apps N] "
              "[--require-app ID]... <summary.json>", file=sys.stderr)
        return 2
    try:
        parity = check(json.loads(Path(paths[0]).read_text(encoding="utf-8")),
                       stopped, tuple(required), minimum)
    except (OSError, ValueError) as error:
        print(f"verify-migration-run: {error}", file=sys.stderr)
        return 1
    for app in parity:
        print(f"verify-migration-run: note: test-parity not passed for {app}")
    print("verify-migration-run: every app translated, compiled and passed ILVerify")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
