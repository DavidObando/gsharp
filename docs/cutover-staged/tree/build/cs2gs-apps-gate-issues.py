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

    cs2gs-apps-gate-issues.py --results DIR --banked FILE --ref REF [--dry-run]

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
    return "P0" if result["app"] in banked and ref in ("main", "refs/heads/main") else "P1"


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
    tail = result.get("log_tail", "").strip()
    return (
        f"{MARKER.format(fp)}\n"
        f"The `{result.get('gate', 'cs2gs-apps-nightly')}` gate failed for **{result['app']}**.\n\n"
        f"- Summary: {result.get('summary', '(none)')}\n"
        f"- Run: {result.get('run_url', '(unknown)')}\n"
        f"- Priority: {prio} (P0 only when a banked app goes red on main)\n\n"
        "Gate report (log tail):\n\n```text\n" + tail[-6000:] + "\n```\n"
    )


def process(results: list[dict], banked: set[str], ref: str, gh: Gh) -> int:
    filed = 0
    for r in results:
        if r.get("status") != "red":
            continue
        fp = fingerprint(r)
        prio = priority(r, banked, ref)
        found = json.loads(
            gh.run("issue", "list", "--state", "open", "--label", LABEL, "--search",
                   f'"cs2gs-gate-fp:{fp}" in:body', "--json", "number,labels", read=True) or "[]"
        )
        if found:
            n = str(found[0]["number"])
            current = {l["name"] for l in found[0].get("labels", [])} & set(PRIORITIES)
            gh.run("issue", "comment", n, "--body", f"Still failing.\n\n{body_for(r, fp, prio)}")
            # Exactly one priority label, never lowered: the highest of the
            # existing labels and this run's priority (P0 is highest).
            target = min(current | {prio}, key=PRIORITIES.index)
            for old in sorted(current - {target}):
                gh.run("issue", "edit", n, "--remove-label", old)
            if target not in current:
                gh.run("issue", "edit", n, "--add-label", target)
        else:
            gh.run("issue", "create", "--title", f"cs2gs apps nightly: {r['app']} is red",
                   "--label", LABEL, "--label", "bug", "--label", prio,
                   "--body", body_for(r, fp, prio))
            filed += 1
    return filed


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, required=True)
    ap.add_argument("--banked", type=Path, required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--expect", default="", help="comma-separated apps that must have a result; a missing one counts as red")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    results = [json.loads(p.read_text()) for p in sorted(a.results.rglob("result-*.json"))]
    if not results and not a.expect:
        print("no result-*.json files found: refusing to report a vacuous green", file=sys.stderr)
        return 2
    for app in filter(None, a.expect.split(",")):
        if not any(r["app"] == app for r in results):
            results.append({"app": app, "status": "red", "summary": "no result file: the leg crashed before reporting",
                            "fingerprint": "missing-result", "log_tail": "", "run_url": "(see the workflow run)"})
    banked = set(json.loads(a.banked.read_text()).get("banked", []))
    process(results, banked, a.ref, Gh(a.dry_run))
    reds = [r["app"] for r in results if r.get("status") == "red"]
    print(f"{len(results)} apps, {len(reds)} red: {', '.join(reds) or 'none'}")
    return 1 if reds else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
