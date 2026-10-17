#!/usr/bin/env python3
"""Create or update one GitHub issue per failed app of the cs2gs apps nightly.

Input is a directory of per-app result files written by the nightly's app legs
(`result-<app>.json`):

    {"app": "oahu", "gate": "cs2gs-apps-nightly", "status": "red" | "green",
     "summary": "one line", "fingerprint": "optional stable failure key",
     "log_tail": "last lines of the log", "run_url": "..."}

Deduplication: every issue body carries a hidden marker
`<!-- cs2gs-gate-fp:<sha1> -->` where the hash covers gate, app and failure
fingerprint (the first error line with volatile standalone numbers removed,
keeping digits inside identifiers such as GS0154, when the result gives
none). A red app whose marker matches an OPEN issue adds a comment to that
issue; otherwise a new issue is filed. Green apps never touch issues.

Priority (CLAUDE.md triage rule): every issue gets exactly one of P0/P1/P2.
P0 only when a previously banked app (listed in the banked file) goes red on
`main`; every other red app is P1. An update never lowers a priority and
raises it to P0 when the rule now applies.

    cs2gs-apps-gate-issues.py --results DIR --banked FILE --ref REF
        [--expect APP,APP,...] [--incomplete APP,APP,...] [--run-url URL]
        [--summary FILE] [--dry-run]

Issues are filed ONLY for a run on `main` (the schedule, or a dispatch with
`--ref main`). A run on any other ref (a branch proving a workflow change)
prints what it would file and touches no issue, so iterating on a branch
cannot spam or comment on the real gate issues; its exit code still reports
the red apps.

A leg whose own job was cancelled or skipped (`--incomplete`, or `--jobs` with
`--leg-job APP=JOB`, which reads each matrix child's conclusion separately; or a
leg result with status "incomplete") is reported "incomplete": the gate still exits non-zero,
so a cancelled run is never green, but no issue is filed or commented on,
because nothing showed a migration failure (scheduled run 38908586181 had all
three legs cancelled and filed three bogus issues).

Fail-safe input handling (issue #4887): a result file that does not parse, is
not an object, or has no app name becomes a RED result named after its file
(`result-<app>.json`), and an app listed in `--expect` with no result at all is
red too. Neither can stop the report or pass as green.

`--summary FILE` appends the end-of-run markdown table (one row per app with
its status, summary and stats, then each red leg's red apps) to FILE, e.g.
$GITHUB_STEP_SUMMARY. It is rendered from the same normalized results, so a
malformed result cannot break it.

Needs `gh` and a token with `issues: write`. `--dry-run` prints the gh calls
instead of making them (used by build/test-cs2gs-apps-gate-issues.py).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

LABEL = "cs2gs-nightly"
# "incomplete": the leg's job was cancelled or skipped, so it neither passed nor
# showed a migration failure. It keeps the gate red but files no issue.
STATUSES = ("green", "red", "incomplete")
PRIORITIES = ("P0", "P1", "P2")
MARKER = "<!-- cs2gs-gate-fp:{} -->"


def fingerprint(result: dict) -> str:
    key = result.get("fingerprint")
    if not key:
        first = next((l for l in result.get("log_tail", "").splitlines() if re.search(r"error|fail", l, re.I)), result.get("summary", ""))
        # Drop only volatile numbers (line/column, counts, durations). Digits
        # that are part of an identifier such as GS0154 or CS8600 are kept, so
        # different diagnostics get different fingerprints.
        key = re.sub(r"(?<![A-Za-z0-9_])\d+", "", first).strip()
    raw = "|".join((result.get("gate", "cs2gs-apps-nightly"), result["app"], key))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def priority(result: dict, banked: set[str], ref: str) -> str:
    return "P0" if result["app"] in banked and is_main(ref) else "P1"


class Gh:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.calls: list[list[str]] = []

    def run(self, *args: str, read: bool = False) -> str:
        if self.dry_run:
            self.calls.append(list(args))
            if not read:
                print("gh", *args)
                return ""
            return "[]"
        return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def body_for(result: dict, fp: str, prio: str) -> str:
    tail = str(result.get("log_tail") or "").strip()
    stats = result.get("stats") if isinstance(result.get("stats"), dict) else {}
    accounting = ""
    if stats:
        green, total = stats.get("green", "?"), stats.get("total", "?")
        accounting = f"- Apps: {green}/{total} green (floor {stats.get('floor', total)})\n"
        red_apps = stats.get("redApps") if isinstance(stats.get("redApps"), list) else []
        accounting += "".join(f"  - red: {a}\n" for a in red_apps[:30])
    return (
        f"{MARKER.format(fp)}\n"
        f"The `{result.get('gate', 'cs2gs-apps-nightly')}` gate failed for **{result['app']}**.\n\n"
        f"- Summary: {result.get('summary', '(none)')}\n"
        f"{accounting}"
        f"- Run: {result.get('run_url', '(unknown)')}\n"
        f"- Priority: {prio} (P0 only when a banked app goes red on main)\n\n"
        "Gate report (log tail):\n\n```text\n" + tail[-6000:] + "\n```\n"
    )


def report_one(r: dict, banked: set[str], ref: str, gh: Gh) -> bool:
    """Files or updates the issue for one red result; True when it filed one."""
    fp = fingerprint(r)
    prio = priority(r, banked, ref)
    found = json.loads(
        gh.run("issue", "list", "--state", "open", "--label", LABEL, "--search",
               f'"cs2gs-gate-fp:{fp}" in:body', "--json", "number,labels", read=True) or "[]"
    )
    if found:
        n = str(found[0]["number"])
        current = {l["name"] for l in found[0].get("labels", [])} & set(PRIORITIES)
        # Exactly one priority label, never lowered: the highest of the
        # existing labels and this run's priority (P0 is highest). The
        # comment reports that retained target, so it agrees with the label.
        target = min(current | {prio}, key=PRIORITIES.index)
        gh.run("issue", "comment", n, "--body", f"Still failing.\n\n{body_for(r, fp, target)}")
        for old in sorted(current - {target}):
            gh.run("issue", "edit", n, "--remove-label", old)
        if target not in current:
            gh.run("issue", "edit", n, "--add-label", target)
        return False
    gh.run("issue", "create", "--title", f"cs2gs apps nightly: {r['app']} is red",
           "--label", LABEL, "--label", "bug", "--label", prio,
           "--body", body_for(r, fp, prio))
    return True


def process(results: list[dict], banked: set[str], ref: str, gh: Gh) -> int:
    """Reports every red result. A failure reporting one leg (a gh error, an
    unexpected field) is printed and the remaining legs are still reported; the
    gate's exit code is already non-zero because that leg is red."""
    filed = 0
    for r in results:
        if r.get("status") != "red":
            continue
        try:
            filed += report_one(r, banked, ref, gh)
        except Exception as exc:  # fail closed: keep reporting the other legs
            print(f"could not report {r.get('app')!r}: {exc.__class__.__name__}: {exc}", file=sys.stderr)
    return filed


def is_main(ref: str) -> bool:
    return ref in ("main", "refs/heads/main")


# Fields fingerprinting and the issue body read as text. Each must be absent
# or a string: anything else (e.g. `"log_tail": null`) would crash reporting
# for this and every later leg, so it makes the result malformed instead.
TEXT_FIELDS = ("summary", "log_tail", "fingerprint", "gate", "run_url")


def schema_problem(r: dict) -> str | None:
    if not (isinstance(r.get("app"), str) and r["app"]):
        return "has no app name"
    bad = [k for k in TEXT_FIELDS if k in r and not isinstance(r[k], str)]
    if bad:
        return "has non-string " + ", ".join(bad)
    return None


def load_results(results_dir: Path) -> list[dict]:
    """Every result-*.json under results_dir; a malformed one becomes red."""
    results = []
    for p in sorted(results_dir.rglob("result-*.json")):
        app = p.stem[len("result-"):] or p.stem
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
            problem = None if isinstance(r, dict) else "is not a JSON object"
        except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
            r, problem = None, f"does not parse ({exc.__class__.__name__})"
        if problem is None:
            problem = schema_problem(r)
        if problem is not None:
            r = {"app": app, "status": "red", "summary": f"malformed leg result: {p.name} {problem}",
                 "fingerprint": "malformed-result", "log_tail": "", "run_url": "(see the workflow run)"}
        results.append(r)
    return results


def cancelled_legs(jobs_path: Path | None, leg_jobs: list[str]) -> set[str]:
    """The apps whose OWN job was cancelled or skipped, decided per leg.

    A matrix job's `needs.<id>.result` is one conclusion for all of its
    children, so a failed Oahu leg and a cancelled Code Exploder leg cannot be
    told apart from it. The Actions jobs API names each child ("app (oahu)").
    Fail-closed: when the jobs cannot be read, no leg is excused, and a
    missing result stays a red, filed crash.
    """
    if jobs_path is None or not leg_jobs:
        return set()
    try:
        jobs = json.loads(jobs_path.read_text(encoding="utf-8")).get("jobs", [])
        conclusions = {j["name"]: j.get("conclusion") or j.get("status") for j in jobs if isinstance(j, dict)}
    except (OSError, ValueError, AttributeError, KeyError, TypeError) as exc:
        print(f"could not read the run's jobs ({exc.__class__.__name__}): no leg is treated as cancelled", file=sys.stderr)
        return set()
    legs = set()
    for pair in leg_jobs:
        app, _, job = pair.partition("=")
        if conclusions.get(job) in ("cancelled", "skipped"):
            legs.add(app)
    return legs


def cell(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def render_summary(results: list[dict]) -> str:
    lines = ["### cs2gs apps nightly", "", "| app | status | summary | stats |", "|---|---|---|---|"]
    for r in results:
        stats = r.get("stats") if isinstance(r.get("stats"), dict) else {}
        first = ("green", "total", "floor", "red")
        keys = [k for k in first if k in stats] + sorted(k for k in stats if k not in first)
        shown = ", ".join(f"{k}={stats[k]}" for k in keys
                          if isinstance(stats[k], (int, float, str)) and k != "source") or "n/a"
        lines.append(f"| {cell(r['app'])} | {cell(r.get('status'))} | {cell(r.get('summary', ''))} | {cell(shown)} |")
    for r in results:
        stats = r.get("stats") if isinstance(r.get("stats"), dict) else {}
        red_apps = stats.get("redApps")
        if isinstance(red_apps, list) and red_apps:
            lines += ["", f"**{r['app']}**: {len(red_apps)} red app(s)", ""]
            lines += [f"- {cell(a)}" for a in red_apps[:50]]
            if len(red_apps) > 50:
                lines.append(f"- ... {len(red_apps) - 50} more")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, required=True)
    ap.add_argument("--banked", type=Path, required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--expect", default="", help="comma-separated apps that must have a result; a missing one counts as red")
    ap.add_argument("--run-url", default="(see the workflow run)", help="the run, for results synthesized here")
    ap.add_argument("--incomplete", default="",
                    help="comma-separated apps whose job was cancelled or skipped; if such an app has no result it is "
                         "reported incomplete (the run is not green, no issue is filed) instead of crashed")
    ap.add_argument("--jobs", type=Path,
                    help="the run's jobs as the Actions API returns them ({\"jobs\": [{\"name\", \"conclusion\"}]})")
    ap.add_argument("--leg-job", action="append", default=[], metavar="APP=JOB",
                    help="the job whose conclusion decides whether APP is incomplete; with --jobs")
    ap.add_argument("--summary", type=Path, help="append the end-of-run markdown table to this file")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    results = load_results(a.results) if a.results.is_dir() else []
    if not results and not a.expect:
        print("no result-*.json files found: refusing to report a vacuous green", file=sys.stderr)
        return 2
    for r in results:
        if r.get("run_url") in (None, "", "(see the workflow run)"):
            r["run_url"] = a.run_url
    incomplete = set(filter(None, a.incomplete.split(","))) | cancelled_legs(a.jobs, a.leg_job)
    for app in filter(None, a.expect.split(",")):
        if not any(r["app"] == app for r in results):
            if app in incomplete:
                results.append({"app": app, "status": "incomplete", "log_tail": "", "run_url": a.run_url,
                                "summary": "no result file: the leg's job was cancelled or skipped before reporting"})
            else:
                results.append({"app": app, "status": "red", "summary": "no result file: the leg crashed before reporting",
                                "fingerprint": "missing-result", "log_tail": "", "run_url": a.run_url})
    # A status other than green, red or incomplete is a malformed result, never a pass.
    for r in results:
        if r.get("status") not in STATUSES:
            r["summary"] = f"invalid status {r.get('status')!r} in the leg result; {r.get('summary', '')}"
            r["fingerprint"] = r.get("fingerprint") or "invalid-status"
            r["status"] = "red"
    if a.summary:
        try:
            with a.summary.open("a", encoding="utf-8") as handle:
                handle.write(render_summary(results))
        except Exception as exc:  # best effort: the report below must still run
            print(f"could not write the summary table: {exc}", file=sys.stderr)
    banked = set(json.loads(a.banked.read_text()).get("banked", []))
    dry_run = a.dry_run
    if not is_main(a.ref) and not dry_run:
        print(f"ref {a.ref!r} is not main: reporting only, no issue is filed or updated.")
        dry_run = True
    process(results, banked, a.ref, Gh(dry_run))
    reds = [r["app"] for r in results if r.get("status") == "red"]
    unfinished = [r["app"] for r in results if r.get("status") == "incomplete"]
    print(f"{len(results)} apps, {len(reds)} red: {', '.join(reds) or 'none'}"
          + (f"; {len(unfinished)} incomplete (cancelled, no issue filed): {', '.join(unfinished)}" if unfinished else ""))
    return 1 if reds or unfinished else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
