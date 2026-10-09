#!/usr/bin/env python3
"""Proves the cs2gs apps gate issue logic: dedup, priority rule, vacuous input."""
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

    def run(self, *args, read=False):
        if read:
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
    print("OK")


main()
