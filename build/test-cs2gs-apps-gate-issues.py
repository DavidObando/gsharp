#!/usr/bin/env python3
"""Proves the cs2gs apps gate issue logic: dedup, priority rule, vacuous and
malformed input, the summary table, and that branch runs file no issues."""
import importlib.util
import json
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("cs2gs-apps-gate-issues.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FakeGh(gate.Gh):
    def __init__(self, existing):
        super().__init__(True)
        self.existing = existing
        self.writes = []
        self.reads = []

    def run(self, *args, read=False):
        if read:
            self.reads.append(list(args))
            return json.dumps(self.existing)
        self.writes.append(list(args))
        return ""


def red(app, **kw):
    return {"app": app, "status": "red", "summary": "s", "log_tail": "error CS1: x 12", **kw}


def main():
    # A banked app red on main files a new P0 issue.
    g = FakeGh([])
    gate.process([red("oahu")], {"oahu"}, "main", g)
    assert g.writes[0][:2] == ["issue", "create"] and "P0" in g.writes[0], g.writes
    # The marker is quoted in the search so the colon is not read as a qualifier.
    g = FakeGh([])
    gate.process([red("oahu")], set(), "main", g)
    query = g.reads[0][g.reads[0].index("--search") + 1]
    assert query.startswith('"cs2gs-gate-fp:') and query.endswith('" in:body'), query
    # Not banked, or banked but not on main: P1.
    g = FakeGh([])
    gate.process([red("oahu")], set(), "main", g)
    assert "P1" in g.writes[0] and "P0" not in g.writes[0]
    g = FakeGh([])
    gate.process([red("oahu")], {"oahu"}, "feature", g)
    assert "P1" in g.writes[0]
    # An open issue with the same fingerprint gets a comment, not a duplicate,
    # and is raised to P0 when the rule now applies.
    g = FakeGh([{"number": 7, "labels": [{"name": "P1"}]}])
    gate.process([red("oahu")], {"oahu"}, "main", g)
    kinds = [w[:2] for w in g.writes]
    assert ["issue", "create"] not in kinds and ["issue", "comment"] in kinds and ["issue", "edit"] in kinds, g.writes
    # The comment reports the retained priority, not this run's lower one.
    g = FakeGh([{"number": 7, "labels": [{"name": "P0"}]}])
    gate.process([red("oahu")], set(), "feature", g)
    comment = next(w for w in g.writes if w[:2] == ["issue", "comment"])[-1]
    assert "Priority: P0" in comment and "Priority: P1" not in comment, comment
    # Priority labels are normalized to exactly one and never lowered.
    def edits(existing, banked):
        g = FakeGh([{"number": 7, "labels": [{"name": n} for n in existing]}])
        gate.process([red("oahu")], banked, "main", g)
        return [w for w in g.writes if w[:2] == ["issue", "edit"]]

    assert edits([], set()) == [["issue", "edit", "7", "--add-label", "P1"]]
    assert edits(["P2"], set()) == [["issue", "edit", "7", "--remove-label", "P2"], ["issue", "edit", "7", "--add-label", "P1"]]
    assert edits(["P0", "P1"], set()) == [["issue", "edit", "7", "--remove-label", "P1"]]
    assert edits(["P0"], set()) == []
    assert edits(["P1"], set()) == []
    # A malformed status is red, not green.
    with tempfile.TemporaryDirectory() as bad:
        Path(bad, "result-oahu.json").write_text(json.dumps({"app": "oahu", "status": "error"}))
        Path(bad, "banked.json").write_text(json.dumps({"banked": []}))
        assert gate.main(["--results", bad, "--banked", str(Path(bad, "banked.json")), "--ref", "feature", "--dry-run"]) == 1
    # Green never touches issues.
    g = FakeGh([])
    gate.process([{"app": "oahu", "status": "green"}], {"oahu"}, "main", g)
    assert not g.writes
    # The fingerprint ignores digits (line numbers) and differs per app.
    assert gate.fingerprint(red("oahu")) == gate.fingerprint(red("oahu", log_tail="error CS1: x 99"))
    assert gate.fingerprint(red("oahu")) != gate.fingerprint(red("code-exploder"))
    # Different diagnostic IDs on otherwise identical lines stay distinct.
    id_a = gate.fingerprint(red("oahu", log_tail="error GS0154: bad type at 4,5"))
    id_b = gate.fingerprint(red("oahu", log_tail="error GS0155: bad type at 4,5"))
    assert id_a != id_b and id_a == gate.fingerprint(red("oahu", log_tail="error GS0154: bad type at 90,12"))
    # No results is an error; a missing expected app counts as red.
    with tempfile.TemporaryDirectory() as d:
        base = ["--results", d, "--banked", d + "/b.json", "--ref", "main", "--dry-run"]
        Path(d, "b.json").write_text('{"banked": []}')
        assert gate.main(base) == 2
        Path(d, "result-oahu.json").write_text(json.dumps({"app": "oahu", "status": "green"}))
        assert gate.main(base) == 0
        assert gate.main(base + ["--expect", "oahu,code-exploder"]) == 1
    # Issue #4887: a truncated, non-object or nameless result is red, named
    # after its file, and never stops the report.
    with tempfile.TemporaryDirectory() as d:
        Path(d, "b.json").write_text('{"banked": []}')
        Path(d, "r").mkdir()
        Path(d, "r", "result-oahu.json").write_text('{"app": "oahu", "status": "gre')
        Path(d, "r", "result-code-exploder.json").write_text("[]")
        Path(d, "r", "result-gsharp-csharp.json").write_text('{"status": "green"}')
        loaded = {r["app"]: r for r in gate.load_results(Path(d, "r"))}
        assert set(loaded) == {"oahu", "code-exploder", "gsharp-csharp"}, loaded
        assert all(r["status"] == "red" and r["fingerprint"] == "malformed-result" for r in loaded.values()), loaded
        assert "does not parse" in loaded["oahu"]["summary"] and "not a JSON object" in loaded["code-exploder"]["summary"]
        summary = Path(d, "summary.md")
        assert gate.main(["--results", str(Path(d, "r")), "--banked", str(Path(d, "b.json")), "--ref", "main",
                          "--dry-run", "--summary", str(summary), "--expect", "oahu,code-exploder,gsharp-csharp"]) == 1
        assert summary.read_text().count("| red |") == 3, summary.read_text()

    # A non-string text field (e.g. log_tail: null, which fingerprint() would
    # crash on) makes the result malformed at load time, and reporting it and
    # the legs after it still runs end to end.
    with tempfile.TemporaryDirectory() as d:
        Path(d, "b.json").write_text('{"banked": []}')
        Path(d, "r").mkdir()
        Path(d, "r", "result-code-exploder.json").write_text(json.dumps({"app": "code-exploder", "status": "red", "log_tail": None}))
        Path(d, "r", "result-oahu.json").write_text(json.dumps({"app": "oahu", "status": "red", "summary": 3}))
        Path(d, "r", "result-zz.json").write_text(json.dumps(red("zz")))
        loaded = gate.load_results(Path(d, "r"))
        assert [(r["app"], r["status"], r.get("fingerprint")) for r in loaded] == [
            ("code-exploder", "red", "malformed-result"), ("oahu", "red", "malformed-result"), ("zz", "red", None)], loaded
        assert "non-string log_tail" in loaded[0]["summary"] and "non-string summary" in loaded[1]["summary"], loaded
        g = FakeGh([])
        assert gate.process(loaded, set(), "main", g) == 3
        assert [w[:2] for w in g.writes] == [["issue", "create"]] * 3, g.writes
        summary = Path(d, "summary.md")
        assert gate.main(["--results", str(Path(d, "r")), "--banked", str(Path(d, "b.json")), "--ref", "main",
                          "--dry-run", "--summary", str(summary)]) == 1
        assert summary.read_text().count("| red |") == 3, summary.read_text()

    # Reporting one leg can fail (a gh error); the legs after it are still reported.
    class Flaky(FakeGh):
        def run(self, *args, read=False):
            if read and any("oahu" in a for a in self.pending):
                raise RuntimeError("gh: HTTP 502")
            return super().run(*args, read=read)

    g = Flaky([])
    g.pending = []
    orig_report = gate.report_one

    def tracked(r, banked, ref, gh):
        gh.pending = [r["app"]]
        return orig_report(r, banked, ref, gh)

    gate.report_one = tracked
    try:
        assert gate.process([red("oahu"), red("code-exploder")], set(), "main", g) == 1
    finally:
        gate.report_one = orig_report
    assert len(g.writes) == 1 and "code-exploder is red" in g.writes[0][3], g.writes

    # Cancelled legs (run 38908586181): with --incomplete, an expected app with
    # no result is "incomplete" -- the gate still exits 1, so the run is never
    # green, but no issue is filed or commented on, even on main. A leg result
    # that says "incomplete" behaves the same. An app NOT listed as incomplete
    # that left no result is still a red crash and is filed.
    with tempfile.TemporaryDirectory() as d:
        Path(d, "b.json").write_text('{"banked": ["oahu"]}')
        base = ["--results", d, "--banked", str(Path(d, "b.json")), "--ref", "main", "--dry-run",
                "--expect", "gsharp-csharp,oahu,code-exploder"]
        filed = []
        real_process = gate.process
        gate.process = lambda results, banked, ref, gh: filed.extend(r for r in results if r["status"] == "red") or 0
        try:
            summary = Path(d, "summary.md")
            assert gate.main(base + ["--incomplete", "oahu,code-exploder,gsharp-csharp,", "--summary", str(summary)]) == 1
            assert filed == [], filed
            assert summary.read_text().count("| incomplete |") == 3, summary.read_text()
            Path(d, "result-gsharp-csharp.json").write_text(json.dumps(
                {"app": "gsharp-csharp", "status": "incomplete", "summary": "the translate job finished 'cancelled'"}))
            assert gate.main(base + ["--incomplete", "oahu"]) == 1
            assert [r["app"] for r in filed] == ["code-exploder"], filed
            assert filed[0]["fingerprint"] == "missing-result", filed
        finally:
            gate.process = real_process
    # Per-leg conclusions (--jobs/--leg-job): a matrix's needs.result is one
    # value for both children, so Oahu failing at restore while Code Exploder
    # is cancelled must file Oahu and excuse only Code Exploder.
    with tempfile.TemporaryDirectory() as d:
        Path(d, "b.json").write_text('{"banked": []}')
        legs = ["--leg-job", "oahu=app (oahu)", "--leg-job", "code-exploder=app (code-exploder)",
                "--leg-job", "gsharp-csharp=gsharp-csharp (aggregate)"]
        base = ["--results", str(Path(d, "r")), "--banked", str(Path(d, "b.json")), "--ref", "main", "--dry-run",
                "--expect", "gsharp-csharp,oahu,code-exploder", "--jobs", str(Path(d, "jobs.json"))] + legs
        Path(d, "r").mkdir()
        Path(d, "r", "result-gsharp-csharp.json").write_text(json.dumps({"app": "gsharp-csharp", "status": "green"}))

        def outcome(jobs):
            Path(d, "jobs.json").write_text(jobs if isinstance(jobs, str) else json.dumps({"jobs": jobs}))
            seen = []
            real = gate.process
            gate.process = lambda results, banked, ref, gh: seen.extend(results) or 0
            try:
                code = gate.main(base)
            finally:
                gate.process = real
            return code, {r["app"]: r["status"] for r in seen}

        mixed = [{"name": "app (oahu)", "conclusion": "failure"},
                 {"name": "app (code-exploder)", "conclusion": "cancelled"},
                 {"name": "gsharp-csharp (aggregate)", "conclusion": "success"}]
        assert outcome(mixed) == (1, {"gsharp-csharp": "green", "oahu": "red", "code-exploder": "incomplete"})
        both = [{"name": "app (oahu)", "conclusion": "cancelled"}, {"name": "app (code-exploder)", "conclusion": "skipped"}]
        assert outcome(both) == (1, {"gsharp-csharp": "green", "oahu": "incomplete", "code-exploder": "incomplete"})
        # Unreadable jobs: nothing is excused, both missing legs are red crashes.
        assert outcome("{not json") == (1, {"gsharp-csharp": "green", "oahu": "red", "code-exploder": "red"})
        assert outcome([]) == (1, {"gsharp-csharp": "green", "oahu": "red", "code-exploder": "red"})
    # process() itself never files an incomplete result.
    g = FakeGh([])
    gate.process([{"app": "oahu", "status": "incomplete", "summary": "cancelled"}], {"oahu"}, "main", g)
    assert not g.writes and not g.reads, g.writes

    # The summary table: scalar stats as k=v (lists and the source path left
    # out), each leg's red apps listed below, and a non-object stats is n/a.
    table = gate.render_summary([
        {"app": "oahu", "status": "red", "summary": "a|b", "stats": {"total": 15, "green": 9, "bangs": 2, "source": "/x",
                                                                    "redApps": ["src/X (compile-error, reached compile)"]}},
        {"app": "code-exploder", "status": "green", "summary": "ok", "stats": "garbage"},
    ])
    assert "| oahu | red | a\\|b | green=9, total=15, bangs=2 |" in table, table
    assert "| code-exploder | green | ok | n/a |" in table, table
    assert "**oahu**: 1 red app(s)" in table and "- src/X (compile-error, reached compile)" in table, table
    assert "/x" not in table

    # The issue body carries the leg's accounting.
    body = gate.body_for({"app": "oahu", "summary": "s", "stats": {"green": 9, "total": 15, "floor": 15,
                                                                   "redApps": ["src/X (c, reached compile)"]}},
                         "fp", "P1")
    assert "- Apps: 9/15 green (floor 15)" in body and "  - red: src/X (c, reached compile)" in body, body

    # Branch runs never file or update issues; main runs do. --run-url reaches
    # the synthesized missing-result entry.
    made = []

    class Recording(gate.Gh):
        def __init__(self, dry_run):
            super().__init__(dry_run)
            made.append(dry_run)

        def run(self, *args, read=False):
            if not self.dry_run and not read:
                self.calls.append(list(args))
                return ""
            return "[]" if read else ""

    real_gh, gate.Gh = gate.Gh, Recording
    try:
        with tempfile.TemporaryDirectory() as d:
            Path(d, "b.json").write_text('{"banked": []}')
            base = ["--results", d, "--banked", str(Path(d, "b.json")), "--expect", "oahu", "--run-url", "https://run/1"]
            assert gate.main(base + ["--ref", "cs2gs/fix-nightly"]) == 1
            assert made == [True], made
            assert gate.main(base + ["--ref", "main"]) == 1
            assert made == [True, False], made
            assert gate.main(base + ["--ref", "refs/heads/main", "--dry-run"]) == 1
            assert made == [True, False, True], made
            loaded = []
            orig_process = gate.process
            gate.process = lambda results, banked, ref, gh: loaded.extend(results) or 0
            try:
                gate.main(base + ["--ref", "main"])
            finally:
                gate.process = orig_process
            assert loaded[0]["run_url"] == "https://run/1" and loaded[0]["status"] == "red", loaded
    finally:
        gate.Gh = real_gh
    print("OK")


main()
