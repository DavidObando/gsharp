#!/usr/bin/env python3
"""Proves the cs2gs apps nightly's per-leg accounting (build/cs2gs-apps-leg.py).

Issues #4917 / #4919: a fully green leg must report green, and every way a leg
can fail to account for itself (no stats, malformed stats, a non-zero exit, a
green count below the floor) must report red. The last case drives the real
sharded gate script (build/run-cs2gs-selfmig-gate.sh) over a tiny fixture to
prove it leaves stats.json behind even when the baseline fails it, and keeps
its own non-zero exit status.
"""
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("leg", HERE / "cs2gs-apps-leg.py")
leg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(leg)


def app(app_id, *statuses, category=None):
    stages = [{"stage": s, "status": st, "artifactCount": 0} for s, st in zip(leg.STAGES, statuses)]
    return {"appId": app_id, "succeeded": all(st == "passed" for st in statuses) and len(statuses) == 4,
            "failureCategory": category, "stages": stages}


GREEN = ("passed",) * 4
COMPILE_RED = ("passed", "failed", "skipped", "skipped")
RUN = {"runId": "r", "apps": [app("src/A/A.csproj", *GREEN), app("src/B/B.csproj", *GREEN),
                              app("src/C/C.csproj", *COMPILE_RED, category="compile-error")]}


def stats_cmd(*args) -> int:
    return leg.main(["stats", *args])


def result(d: Path, code: int, stats: object | None, **kw) -> dict:
    stats_path = d / "stats.json"
    if stats is not None:
        stats_path.write_text(stats if isinstance(stats, str) else json.dumps(stats))
    elif stats_path.exists():
        stats_path.unlink()
    out = d / "result.json"
    args = ["result", "--app", "x", "--exit-code", str(code), "--stats", str(stats_path), "--out", str(out)]
    for k, v in kw.items():
        args += [f"--{k.replace('_', '-')}", v]
    assert leg.main(args) == 0
    return json.loads(out.read_text())


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        # stats: newest run under --runs-dir, per-stage counts, red apps, extras.
        (d / "runs" / "2026-01-01").mkdir(parents=True)
        (d / "runs" / "2026-01-01" / "run.json").write_text(json.dumps({"apps": []}))
        (d / "runs" / "2026-01-02").mkdir(parents=True)
        (d / "runs" / "2026-01-02" / "run.json").write_text(json.dumps(RUN))
        out = d / "stats.json"
        assert stats_cmd("--runs-dir", str(d / "runs"), "--out", str(out),
                         "--extra", "bangs=12", "--extra", "baseline=passed") == 0
        s = json.loads(out.read_text())
        assert (s["green"], s["total"], s["red"], s["floor"]) == (2, 3, 1, 3), s
        assert s["translate_passed"] == 3 and s["compile_passed"] == 2 and s["compile_failed"] == 1, s
        assert s["ilverify_skipped"] == 1 and "translate_failed" not in s, s
        assert s["bangs"] == 12 and s["baseline"] == "passed", s
        assert s["redApps"] == ["src/C/C.csproj (compile-error, reached compile)"], s
        assert s["source"].endswith("2026-01-02/run.json"), s
        assert stats_cmd("--run", str(d / "runs" / "2026-01-02" / "run.json"), "--out", str(out),
                         "--floor", "2") == 0
        assert json.loads(out.read_text())["floor"] == 2

        # stats: a missing or malformed run is an error and writes nothing.
        out.unlink()
        assert stats_cmd("--runs-dir", str(d / "nope"), "--out", str(out)) == 2
        (d / "bad.json").write_text('{"apps": [')
        assert stats_cmd("--run", str(d / "bad.json"), "--out", str(out)) == 2
        (d / "bad.json").write_text('{"apps": "x"}')
        assert stats_cmd("--run", str(d / "bad.json"), "--out", str(out)) == 2
        assert not out.exists()

        # result: a fully green leg is green and says so (#4917).
        full = {"green": 17, "total": 17, "floor": 17}
        r = result(d, 0, full, run_url="https://run")
        assert r["status"] == "green" and r["summary"] == "leg exited 0; 17/17 apps green (floor 17)", r
        assert r["stats"] == full and r["run_url"] == "https://run" and r["gate"] == "cs2gs-apps-nightly", r
        # A floor below the total (the gsharp-csharp baseline) passes when met.
        assert result(d, 0, {"green": 56, "total": 58, "floor": 56})["status"] == "green"
        # Fail-safe: each of these is red, with the reason in the summary.
        assert result(d, 1, full)["status"] == "red"
        r = result(d, 0, None)
        assert r["status"] == "red" and "no stats.json" in r["summary"] and r["stats"] is None, r
        r = result(d, 0, '{"green": 1')
        assert r["status"] == "red" and "unreadable stats.json" in r["summary"], r
        assert result(d, 0, "[1, 2]")["status"] == "red"
        assert result(d, 0, {"green": "17", "total": 17})["status"] == "red"
        assert result(d, 0, {"green": True, "total": 1})["status"] == "red"
        assert result(d, 0, {"green": 0, "total": 0})["status"] == "red"
        r = result(d, 0, {"green": 16, "total": 17})
        assert r["status"] == "red" and "below the floor" in r["summary"], r
        r = result(d, 0, full, note="the validate shards failed")
        assert r["status"] == "red" and "the validate shards failed" in r["summary"], r
        # The log tail is the END of the log.
        (d / "leg.log").write_text("x" * 9000 + "THE END")
        assert result(d, 1, full, log=str(d / "leg.log"))["log_tail"].endswith("THE END")

        # The sharded gate writes stats.json even when the baseline fails it
        # (one app is far below greenFloor) and keeps its own exit status.
        migrate = d / "selfmig"
        (migrate / "migrated").mkdir(parents=True)
        (migrate / "runs" / "r1").mkdir(parents=True)
        (migrate / "runs" / "r1" / "run.json").write_text(json.dumps(
            {"runId": "r1", "succeeded": True, "apps": [app("src/A/A.csproj", "passed")]}))
        shard = d / "shards" / "cs2gs-selfmig-shard-1"
        shard.mkdir(parents=True)
        shard_app = app("src/A/A.csproj", *GREEN)
        shard_app["stages"] = shard_app["stages"][1:]
        (shard / "shard-run.json").write_text(json.dumps({"apps": [shard_app]}))
        gate = subprocess.run(["bash", str(HERE / "run-cs2gs-selfmig-gate.sh"), str(migrate), str(d / "shards")],
                              capture_output=True, text=True,
                              env={k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"})
        assert gate.returncode != 0, gate.stdout + gate.stderr
        assert "GATE: green count 1 fell below floor" in gate.stderr, gate.stderr
        s = json.loads((migrate / "stats.json").read_text())
        floor = json.loads((HERE.parent / "tools/cs2gs/selfmig-baseline.json").read_text())["greenFloor"]
        assert (s["green"], s["total"], s["floor"], s["baseline"]) == (1, 1, floor, "failed"), s
        assert s["bangs"] == 0 and s["labels"] == 0, s
        assert leg.leg_result("gsharp-csharp", gate.returncode, migrate / "stats.json", "", "", "u")["status"] == "red"
    print("OK")


main()
