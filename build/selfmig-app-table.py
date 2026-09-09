#!/usr/bin/env python3
"""Renders the self-migration gate's third job-summary table: one row per app.

Issue #3501 Track C. The gate table (build/selfmig-common.sh) reports the
CORPUS totals against the ratcheted ceilings, and the readability-counters
table (build/cs2gs-counters.sh) reports a synthetic-identifier breakdown --
neither says, for a SINGLE app, what stage it reached or why it's red. A
reader currently has to go pull the run.merged.json artifact to answer that.
This script renders the missing table: every app in the corpus, its stage
progress, how that compares to its tools/cs2gs/selfmig-baseline.json entry,
and (for red apps) the failure category.

"What stage did app X reach" is computed by importing reached_stage() from
check-selfmig-stage-floor.py (loaded by file path -- the same technique
build/test-check-selfmig-stage-floor.py already uses to unit-test it) rather
than re-deriving the STAGE_ORDER / attempted-vs-unreached-status split here a
second time. That function already handles the fixed stage order, the
passed-and-failed-count-as-attempted distinction, and malformed-row
detection; a SECOND, independently-written copy of that logic could disagree
with the first, and if it ever did, the gate's own stage-floor health check
and this table would tell a reader two different stories about the same run.
That would be a correctness bug in the gate, not a cosmetic one.

Purely informational, like the counters table: this script only prints
markdown to stdout and never signals gate status. Its caller
(selfmig_apply_baseline in build/selfmig-common.sh) appends stdout to
$GITHUB_STEP_SUMMARY only when this process exits 0, and swallows a nonzero
exit -- a malformed input degrades this table to "absent", never to "gate
failure". The pass/fail decision stays entirely with the gate table above it
and with check-selfmig-stage-floor.py's own exit code.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

# Glyphs for the compact per-stage indicator column, one letter per stage in
# STAGE_ORDER. Deliberately plain ASCII, not check-mark/cross Unicode: this
# table sits next to two existing tables that use plain GFM (no emoji), and a
# single-letter code reads fine at 56-rows-in-a-table density where a wider
# symbol would not. Keys must cover exactly VALID_STATUSES from the imported
# module -- see _load_stage_floor_module's caller, which only indexes this
# dict after confirming (via reached_stage returning no error) that every
# status in the row is one of these four.
STAGE_GLYPH = {
    "passed": "P",
    "failed": "F",
    "skipped": "S",
    "not-applicable": "N",
}
MALFORMED_GLYPH = "?"


def _load_stage_floor_module():
    """Loads check-selfmig-stage-floor.py by file path (not package import --
    build/ is a script directory, not a Python package), exactly as
    build/test-check-selfmig-stage-floor.py already does to unit-test the
    same function. This is the "share the logic" half of the contract
    described in the module docstring above: reached_stage() runs from ONE
    place, this file and the stage-floor checker both call into it."""
    module_path = Path(__file__).resolve().parent / "check-selfmig-stage-floor.py"
    spec = importlib.util.spec_from_file_location("check_selfmig_stage_floor", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def jq_truthy(value: object) -> bool:
    """Mirrors jq's `select(.succeeded)` truthiness (only false and null are
    falsy) rather than Python's bool(), so this table's idea of "green" can
    never quietly diverge from the identical `select(.succeeded)` query
    selfmig_apply_baseline() runs a few lines below this table's call site to
    compute newly-green/regressed apps. In practice `.succeeded` is always a
    JSON boolean here, so the two coincide; matching jq's rule exactly (not
    Python's) is what keeps that true even if a malformed row ever slipped
    through."""
    return value is not None and value is not False


def stage_glyphs(app: dict, stage_order: tuple[str, ...], error: str | None) -> str:
    if error is not None:
        return MALFORMED_GLYPH * len(stage_order)
    # reached_stage() already confirmed (error is None) that `stages` is a
    # list of exactly len(stage_order) rows in STAGE_ORDER with a status in
    # VALID_STATUSES, so this lookup cannot miss.
    return "".join(STAGE_GLYPH[stage["status"]] for stage in app["stages"])


def floor_cell(
    *,
    succeeded: bool,
    banked_green: bool,
    reached: str | None,
    error: str | None,
    floor: str | None,
    stage_order: tuple[str, ...],
) -> str:
    if succeeded:
        return "green -- banked" if banked_green else "green -- NEW (not banked)"

    if error is not None:
        if floor is not None:
            return f"malformed stage data (floor on file: `{floor}`)"
        return "malformed stage data"

    if floor is None:
        return "no floor entry (untracked)"

    reached_ordinal = stage_order.index(reached) if reached in stage_order else -1
    floor_ordinal = stage_order.index(floor) if floor in stage_order else -1
    if reached_ordinal == floor_ordinal:
        return f"at floor (`{floor}`)"
    if reached_ordinal > floor_ordinal:
        return f"advanced past floor (`{floor}` -> `{reached or 'none'}`)"
    # Should never render if the gate itself passed -- check-selfmig-stage-
    # floor.py fails the gate on exactly this condition. Shown plainly rather
    # than hidden, per the task: a reader looking at a FAILED gate run should
    # be able to see this at a glance, not have to go re-derive it from the
    # raw artifact.
    return f"BELOW FLOOR (`{floor}` -> `{reached or 'none'}`)"


def render(stage_floor_module, baseline: dict, run: dict) -> str:
    stage_order = stage_floor_module.STAGE_ORDER
    green_apps = set(baseline.get("greenApps") or [])
    floors = baseline.get("stageFloor") or {}
    if not isinstance(floors, dict):
        floors = {}

    apps = run.get("apps")
    if not isinstance(apps, list):
        apps = []

    rows = []
    red_count = 0
    green_count = 0
    for app in apps:
        if not isinstance(app, dict):
            continue
        app_id = app.get("appId")
        if not isinstance(app_id, str):
            continue

        reached, error = stage_floor_module.reached_stage(app)
        succeeded = jq_truthy(app.get("succeeded"))
        if succeeded:
            green_count += 1
        else:
            red_count += 1

        glyphs = stage_glyphs(app, stage_order, error)
        reached_display = "malformed" if error is not None else (reached or "none")
        floor = floors.get(app_id) if isinstance(floors.get(app_id), str) else None
        status_cell = floor_cell(
            succeeded=succeeded,
            banked_green=app_id in green_apps,
            reached=reached,
            error=error,
            floor=floor,
            stage_order=stage_order,
        )
        failure_category = app.get("failureCategory")
        category_display = f"`{failure_category}`" if isinstance(failure_category, str) and failure_category else "--"

        reached_ordinal = stage_order.index(reached) if reached in stage_order else -1
        if succeeded:
            # Newly-green (not yet banked) apps surface before already-banked
            # ones: that is the actionable case (bank it), the same priority
            # the `newly` log lines a few lines below this table give it.
            sort_key = (1, 0 if app_id not in green_apps else 1, app_id)
        else:
            # Apps stuck furthest back surface first -- that is the tail a
            # human reading this table is most likely here to check on.
            sort_key = (0, reached_ordinal, app_id)

        rows.append((sort_key, app_id, glyphs, reached_display, status_cell, category_display))

    rows.sort(key=lambda row: row[0])

    lines = [
        "### cs2gs self-migration: per-app status",
        "",
        f"Every app in the corpus ({len(rows)} total: {red_count} red, {green_count} green) -- "
        "informational only, like the readability counters above; the gate's pass/fail verdict is "
        "the first table on this page. Stage reached is computed with the SAME `reached_stage()` "
        "check-selfmig-stage-floor.py enforces the per-app ratchet with, so this table and that "
        "check can never disagree about what stage an app reached.",
        "",
        "Stages column, in order `translate` `compile` `ilverify` `test-parity`: "
        "`P`=passed `F`=failed `S`=skipped `N`=not-applicable `?`=malformed/missing stage row.",
        "",
        "| app | stages | reached | vs. baseline | failure category |",
        "|---|---|---|---|---|",
    ]
    for _, app_id, glyphs, reached_display, status_cell, category_display in rows:
        lines.append(f"| `{app_id}` | `{glyphs}` | `{reached_display}` | {status_cell} | {category_display} |")
    lines.append("")
    return "\n".join(lines)


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
        stage_floor_module = _load_stage_floor_module()
        baseline = load_json(args.baseline)
        run = load_json(args.run)
        print(render(stage_floor_module, baseline, run))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, json.JSONDecodeError) as error:
        # See the module docstring: this table degrades to ABSENT on bad
        # input, never to a gate failure. The caller only appends stdout when
        # this process exits 0, so returning 1 here (with the reason on
        # stderr, for a human debugging a missing table in the log) is the
        # whole mechanism.
        print(f"selfmig-app-table: skipping the per-app table ({error}).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
