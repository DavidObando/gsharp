#!/usr/bin/env python3
"""Accept a cs2gs migrate run for stage-2 certification.

`cs2gs migrate` exits 1 when any app fails any stage. The certification only
needs a tree that translated, compiled and passed IL verification everywhere;
test parity is re-established by the controller's own stage-2 test run, so only
`test-parity` failures are tolerated (and listed).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REQUIRED = ("translate", "compile", "ilverify")


def check(summary: Any) -> list[str]:
    """Return the apps whose only failure is test parity; raise on anything else."""
    if not isinstance(summary, dict) or not isinstance(summary.get("apps"), list) \
            or not summary["apps"]:
        raise ValueError("migration summary has no apps")
    parity_only = []
    for app in summary["apps"]:
        stages = {row.get("stage"): row.get("status") for row in app.get("stages", [])}
        for stage in REQUIRED:
            if stages.get(stage) != "passed":
                raise ValueError(
                    f"{app.get('appId')}: {stage} is {stages.get(stage)!r}, not 'passed'")
        parity = stages.get("test-parity")
        if parity == "failed":
            parity_only.append(str(app.get("appId")))
        elif parity != "passed":
            raise ValueError(
                f"{app.get('appId')}: test-parity is {parity!r}; only 'passed' or 'failed' is accepted")
    return parity_only


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: verify-migration-run.py <summary.json>", file=sys.stderr)
        return 2
    try:
        parity = check(json.loads(Path(argv[0]).read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        print(f"verify-migration-run: {error}", file=sys.stderr)
        return 1
    for app in parity:
        print(f"verify-migration-run: note: test-parity not passed for {app}")
    print("verify-migration-run: every app translated, compiled and passed ILVerify")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
