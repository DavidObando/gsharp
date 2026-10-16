#!/usr/bin/env python3
"""Per-app accounting for the cs2gs apps nightly (issues #4856, #4917, #4919).

Every leg of .github/workflows/cs2gs-apps-nightly.yml (gsharp-csharp, oahu,
code-exploder) runs `cs2gs migrate` (or the sharded equivalent) and leaves a
run.json behind. Two subcommands turn that into what the gate job reads:

  stats   Reads a run.json-shaped file (`apps[].succeeded`,
          `apps[].stages[].{stage,status}`) and writes the leg's stats.json:
          green/total (green = succeeded and not unverified, the cs2gs CLI's
          own verdict rule), the floor the leg is judged against, per-stage status
          counts, the red apps with their failure category, and any extra
          `key=value` numbers the caller measured (readability counters, the
          baseline verdict). The shape is shared by `cs2gs migrate`'s
          runs/<id>/run.json (and summary.json) and by the sharded gate's
          run.merged.json, so one writer serves all three legs.

              cs2gs-apps-leg.py stats (--run FILE | --runs-dir DIR) --out FILE
                                      [--floor N] [--extra KEY=VALUE ...]

          --runs-dir picks the newest DIR/*/run.json. A missing or malformed
          run is an error (exit 2) and writes nothing: no stats is reported
          red by `result`, never as a pass.

  result  Writes result-<app>.json for the gate job. FAIL-SAFE: the leg is
          green only when ALL of these hold, otherwise it is red with a note
          saying which one failed:
            * the leg's exit code is 0;
            * stats.json exists and parses to an object with integer
              green/total and total > 0;
            * green >= floor (floor defaults to total, so a leg without a
              baseline must be fully green). This catches a leg script that
              forgets to propagate cs2gs's exit code;
            * the run itself did not fail with every app green
              (`runLevelFailure`: an orphan or mirror-completeness failure);
            * the baseline verdict, when recorded, is not "failed".

              cs2gs-apps-leg.py result --app APP --exit-code N --stats FILE
                                       --out FILE [--log FILE] [--note TEXT]
                                       [--run-url URL] [--incomplete]

          --incomplete (a job the leg depends on was cancelled) makes the
          status "incomplete": the run is not green, but no migration failure
          is claimed, so the gate files no issue for it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

GATE = "cs2gs-apps-nightly"
# The four cs2gs stages, in run order. A stage the run does not mention is
# simply absent from the counts.
STAGES = ("translate", "compile", "ilverify", "test-parity")
STATUSES = ("passed", "failed", "skipped", "not-applicable")
LOG_TAIL_CHARS = 8000


def newest_run(runs_dir: Path) -> Path:
    runs = sorted(runs_dir.glob("*/run.json"))
    if not runs:
        raise ValueError(f"no */run.json under {runs_dir}")
    return runs[-1]


def reached(app: dict) -> str:
    """The furthest stage the app attempted (passed or failed), or 'none'."""
    last = "none"
    for stage in app.get("stages") or []:
        if isinstance(stage, dict) and stage.get("status") in ("passed", "failed"):
            last = str(stage.get("stage"))
    return last


def is_green(app: dict) -> bool:
    """Fully green: succeeded AND verified. An app that succeeded only because
    a stage was skipped is `unverified` (Cs2Gs.Pipeline RunResult) and is not
    green, the same rule the cs2gs CLI's verdict applies
    (tools/cs2gs/Cs2Gs.Cli/Program.gs: `a.Succeeded && !a.Unverified`)."""
    return app.get("succeeded") is True and app.get("unverified") is not True


def red_reason(app: dict) -> str:
    if app.get("succeeded") is True:
        return "unverified"
    return app.get("failureCategory") or "unknown"


def compute_stats(run: dict, floor: int | None, extras: dict[str, object]) -> dict:
    apps = run.get("apps")
    if not isinstance(apps, list) or not all(isinstance(a, dict) for a in apps):
        raise ValueError("run has no apps[] list of objects")
    green = sum(1 for a in apps if is_green(a))
    total = len(apps)
    stats: dict[str, object] = {"green": green, "total": total, "red": total - green,
                                "floor": total if floor is None else floor}
    for name in STAGES:
        for status in STATUSES:
            n = sum(1 for a in apps for s in (a.get("stages") or [])
                    if isinstance(s, dict) and s.get("stage") == name and s.get("status") == status)
            if n:
                stats[f"{name}_{status}"] = n
    # The run-level verdict. cs2gs fails a RUN without failing any app when a
    # repository-wide check fails after every app passed: an orphan C# file with
    # no translated mirror, or an incomplete mirror (MigrationPipeline: those
    # checks run only while the run is still green). That is exactly the case
    # per-app counts cannot see, so record it explicitly. A run that failed
    # because some app failed is NOT flagged: those apps are counted red and the
    # floor decides, as the baseline intends. merge-selfmig-runs.py keeps the
    # translate pass's run verdict in the merged run, so this works there too.
    stats["runLevelFailure"] = run.get("succeeded") is False and all(a.get("succeeded") is True for a in apps)
    stats.update(extras)
    stats["redApps"] = sorted(
        f"{a.get('appId', '?')} ({red_reason(a)}, reached {reached(a)})"
        for a in apps if not is_green(a))
    return stats


def parse_extra(pairs: list[str]) -> dict[str, object]:
    extras: dict[str, object] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            raise ValueError(f"--extra expects KEY=VALUE, got {pair!r}")
        try:
            extras[key] = int(value)
        except ValueError:
            extras[key] = value
    return extras


def cmd_stats(a: argparse.Namespace) -> int:
    try:
        run_path = a.run if a.run else newest_run(a.runs_dir)
        run = json.loads(run_path.read_text(encoding="utf-8"))
        if not isinstance(run, dict):
            raise ValueError("run.json is not an object")
        stats = compute_stats(run, a.floor, parse_extra(a.extra))
    except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
        print(f"cs2gs-apps-leg stats: {exc}", file=sys.stderr)
        return 2
    stats["source"] = str(run_path)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    print(f"cs2gs-apps-leg stats: {stats['green']}/{stats['total']} green (floor {stats['floor']}) -> {a.out}")
    return 0


def load_stats(path: Path) -> tuple[dict | None, str]:
    """Returns (stats, problem). A non-empty problem means the stats are unusable."""
    if not path.is_file():
        return None, "no stats.json: per-app accounting was not produced"
    try:
        stats = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"unreadable stats.json ({exc.__class__.__name__})"
    if not isinstance(stats, dict):
        return None, "stats.json is not an object"
    green, total, floor = stats.get("green"), stats.get("total"), stats.get("floor", stats.get("total"))
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (green, total, floor)):
        return stats, "stats.json has no integer green/total/floor"
    if total <= 0:
        return stats, "stats.json counts no apps"
    if not isinstance(stats.get("runLevelFailure", False), bool):
        return stats, "stats.json has a non-boolean runLevelFailure"
    return stats, ""


def leg_result(app: str, code: int, stats_path: Path, log: str, note: str, run_url: str,
               incomplete: bool = False) -> dict:
    stats, problem = load_stats(stats_path)
    notes = [note] if note else []
    if problem:
        notes.append(problem)
    else:
        if stats["green"] < stats.get("floor", stats["total"]):
            notes.append("below the floor")
        if stats.get("runLevelFailure") is True:
            notes.append("the run itself failed (a repository-wide orphan or mirror check; see the log)")
        if stats.get("baseline") == "failed":
            notes.append("the baseline gate failed (see the GATE: lines in the log)")
    status = "green" if code == 0 and not notes else "red"
    if incomplete:
        # A job this leg depends on was cancelled: whatever the stats say, the
        # run did not finish, so it is neither a pass nor a migration failure.
        # The gate reports it red-for-the-run and files no issue for it.
        status = "incomplete"
    headline = f"leg exited {code}"
    if stats and not problem:
        headline += f"; {stats['green']}/{stats['total']} apps green (floor {stats.get('floor', stats['total'])})"
    summary = "; ".join([headline, *notes])
    return {"app": app, "gate": GATE, "status": status, "summary": summary, "stats": stats,
            "log_tail": log[-LOG_TAIL_CHARS:], "run_url": run_url}


def cmd_result(a: argparse.Namespace) -> int:
    log = ""
    if a.log and a.log.is_file():
        log = a.log.read_text(encoding="utf-8", errors="replace")
    result = leg_result(a.app, a.exit_code, a.stats, log, a.note, a.run_url, a.incomplete)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result), encoding="utf-8")
    print(f"cs2gs-apps-leg result: {a.app} is {result['status']}: {result['summary']}")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stats")
    src = s.add_mutually_exclusive_group(required=True)
    src.add_argument("--run", type=Path)
    src.add_argument("--runs-dir", type=Path)
    s.add_argument("--out", type=Path, required=True)
    s.add_argument("--floor", type=int)
    s.add_argument("--extra", action="append", default=[])
    r = sub.add_parser("result")
    r.add_argument("--app", required=True)
    r.add_argument("--exit-code", type=int, required=True)
    r.add_argument("--stats", type=Path, required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--log", type=Path)
    r.add_argument("--note", default="")
    r.add_argument("--run-url", default="(see the workflow run)")
    r.add_argument("--incomplete", action="store_true",
                   help="a job the leg depends on was cancelled: report the leg incomplete, not green or red")
    a = ap.parse_args(argv)
    return cmd_stats(a) if a.cmd == "stats" else cmd_result(a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
