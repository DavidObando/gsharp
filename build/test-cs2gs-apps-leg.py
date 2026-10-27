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
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("leg", HERE / "cs2gs-apps-leg.py")
leg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(leg)


def app(app_id, *statuses, category=None):
    stages = [{"stage": s, "status": st, "artifactCount": 0} for s, st in zip(leg.STAGES, statuses)]
    return {"appId": app_id, "succeeded": all(st == "passed" for st in statuses) and len(statuses) == 4,
            "failureCategory": category, "stages": stages}


def translated(app_id, status="passed"):
    """A translate-only pass's app: succeeded when its one stage passed."""
    a = app(app_id, status)
    a["succeeded"] = status == "passed"
    return a


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
        args += [f"--{k.replace('_', '-')}"] + ([v] if v != "" else [])
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
        # A succeeded-but-unverified app (a stage was skipped) is not green: a
        # leg cannot pass without full validation.
        unverified = app("src/D/D.csproj", "passed", "passed", "passed", "skipped")
        unverified["succeeded"], unverified["unverified"] = True, True
        (d / "unverified.json").write_text(json.dumps({"apps": RUN["apps"][:2] + [unverified]}))
        assert stats_cmd("--run", str(d / "unverified.json"), "--out", str(out)) == 0
        s = json.loads(out.read_text())
        assert (s["green"], s["total"], s["red"]) == (2, 3, 1), s
        assert s["redApps"] == ["src/D/D.csproj (unverified, reached ilverify)"], s
        assert leg.leg_result("x", 0, out, "", "", "u")["status"] == "red"
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
        # A cancelled dependency makes the leg incomplete, whatever the stats.
        assert leg.leg_result("x", 0, d / "stats.json", "", "", "u", incomplete=True)["status"] == "incomplete"
        r = result(d, 1, None, note="the translate job finished 'cancelled'", incomplete="")
        assert r["status"] == "incomplete" and "cancelled" in r["summary"], r
        # The log tail is the END of the log.
        (d / "leg.log").write_text("x" * 9000 + "THE END")
        assert result(d, 1, full, log=str(d / "leg.log"))["log_tail"].endswith("THE END")

        # A run-level failure (cs2gs failed the RUN with every app green: an
        # orphan or mirror-completeness check) survives merging and is red,
        # while a run that failed only because an app failed is left to the
        # floor. Driven through the real merge script, as the aggregate does.
        rl = d / "run-level"
        (rl / "shards").mkdir(parents=True)
        (rl / "migrate.json").write_text(json.dumps(
            {"runId": "m", "succeeded": False, "apps": [translated("src/A/A.csproj"), translated("src/B/B.csproj")]}))
        shard_apps = [app("src/A/A.csproj", *GREEN), app("src/B/B.csproj", *GREEN)]
        for a in shard_apps:
            a["stages"] = a["stages"][1:]
        (rl / "shards" / "shard-run.json").write_text(json.dumps({"apps": shard_apps}))
        subprocess.run(["python3", str(HERE / "merge-selfmig-runs.py"), "--migrate", str(rl / "migrate.json"),
                        "--out", str(rl / "merged.json"), str(rl / "shards" / "shard-run.json")], check=True)
        assert stats_cmd("--run", str(rl / "merged.json"), "--out", str(rl / "stats.json")) == 0
        s = json.loads((rl / "stats.json").read_text())
        assert (s["green"], s["total"], s["runLevelFailure"]) == (2, 2, True), s
        r = leg.leg_result("gsharp-csharp", 0, rl / "stats.json", "", "", "u")
        assert r["status"] == "red" and "the run itself failed" in r["summary"], r
        # The same merged run with the translate pass green is green.
        (rl / "migrate.json").write_text(json.dumps(
            {"runId": "m", "succeeded": True, "apps": [translated("src/A/A.csproj"), translated("src/B/B.csproj")]}))
        subprocess.run(["python3", str(HERE / "merge-selfmig-runs.py"), "--migrate", str(rl / "migrate.json"),
                        "--out", str(rl / "merged.json"), str(rl / "shards" / "shard-run.json")], check=True)
        assert stats_cmd("--run", str(rl / "merged.json"), "--out", str(rl / "stats.json")) == 0
        assert json.loads((rl / "stats.json").read_text())["runLevelFailure"] is False
        assert leg.leg_result("gsharp-csharp", 0, rl / "stats.json", "", "", "u")["status"] == "green"
        # Mixed: the translate pass failed the run (orphan/mirror) AND a shard
        # failed one app the floor permits. The run-level failure must still be
        # red, while the same app failure alone stays within the floor.
        mixed_shards = [app("src/A/A.csproj", *GREEN), app("src/B/B.csproj", *COMPILE_RED, category="compile-error")]
        for a in mixed_shards:
            a["stages"] = a["stages"][1:]
        (rl / "shards" / "shard-run.json").write_text(json.dumps({"apps": mixed_shards}))
        for verdict, expect_flag, expect_status in ((False, True, "red"), (True, False, "green")):
            (rl / "migrate.json").write_text(json.dumps(
                {"runId": "m", "succeeded": verdict,
                 "apps": [translated("src/A/A.csproj"), translated("src/B/B.csproj")]}))
            subprocess.run(["python3", str(HERE / "merge-selfmig-runs.py"), "--migrate", str(rl / "migrate.json"),
                            "--out", str(rl / "merged.json"), str(rl / "shards" / "shard-run.json")], check=True)
            assert json.loads((rl / "merged.json").read_text())["runLevelFailure"] is expect_flag
            assert stats_cmd("--run", str(rl / "merged.json"), "--out", str(rl / "stats.json"), "--floor", "1") == 0
            s = json.loads((rl / "stats.json").read_text())
            assert (s["green"], s["total"], s["runLevelFailure"]) == (1, 2, expect_flag), s
            assert leg.leg_result("gsharp-csharp", 0, rl / "stats.json", "", "", "u")["status"] == expect_status
        # A translate-only pass in which an app failed translate failed the run
        # because of that app: not a run-level failure.
        (rl / "migrate.json").write_text(json.dumps(
            {"runId": "m", "succeeded": False, "apps": [translated("src/A/A.csproj"), translated("src/B/B.csproj", "failed")]}))
        (rl / "shards" / "shard-run.json").write_text(json.dumps({"apps": [mixed_shards[0]]}))
        subprocess.run(["python3", str(HERE / "merge-selfmig-runs.py"), "--migrate", str(rl / "migrate.json"),
                        "--out", str(rl / "merged.json"), str(rl / "shards" / "shard-run.json")], check=True)
        assert json.loads((rl / "merged.json").read_text())["runLevelFailure"] is False
        # A non-boolean explicit flag is malformed.
        (d / "bad-flag.json").write_text(json.dumps({"runLevelFailure": "yes", "apps": RUN["apps"]}))
        assert stats_cmd("--run", str(d / "bad-flag.json"), "--out", str(d / "bad-flag-stats.json")) == 2
        # A failed app makes the run fail too; that is per-app, left to the floor.
        assert stats_cmd("--run", str(d / "runs" / "2026-01-02" / "run.json"), "--out", str(out)) == 0
        json_run = json.loads((d / "runs" / "2026-01-02" / "run.json").read_text())
        json_run["succeeded"] = False
        (d / "app-red.json").write_text(json.dumps(json_run))
        assert stats_cmd("--run", str(d / "app-red.json"), "--out", str(out), "--floor", "2") == 0
        assert json.loads(out.read_text())["runLevelFailure"] is False
        assert leg.leg_result("x", 0, out, "", "", "u")["status"] == "green"
        # A non-boolean runLevelFailure is malformed, and a recorded failed
        # baseline verdict is red even at or above the floor.
        assert result(d, 0, {"green": 2, "total": 2, "runLevelFailure": "no"})["status"] == "red"
        r = result(d, 0, {"green": 57, "total": 58, "floor": 56, "baseline": "failed"})
        assert r["status"] == "red" and "baseline gate failed" in r["summary"], r

        # The sharded gate writes stats.json even when the baseline fails it
        # (one app is far below greenFloor) and keeps its own exit status.
        migrate = d / "selfmig"
        (migrate / "migrated").mkdir(parents=True)
        (migrate / "runs" / "r1").mkdir(parents=True)
        (migrate / "runs" / "r1" / "run.json").write_text(json.dumps(
            {"runId": "r1", "succeeded": True, "apps": [translated("src/A/A.csproj")]}))
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

        def run_gate(migrate_dir, shards_dir, **extra_env):
            env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
            env.update(extra_env)
            return subprocess.run(["bash", str(HERE / "run-cs2gs-selfmig-gate.sh"), str(migrate_dir), str(shards_dir)],
                                  capture_output=True, text=True, env=env)

        def two_app_migrate(root):
            (root / "migrated").mkdir(parents=True)
            (root / "runs" / "r1").mkdir(parents=True)
            (root / "runs" / "r1" / "run.json").write_text(json.dumps(
                {"runId": "r1", "succeeded": True,
                 "apps": [translated("src/A/A.csproj"), translated("src/B/B.csproj")]}))
            return root

        def shard_with(root, name, *apps):
            (root / name).mkdir(parents=True)
            for a in apps:
                a["stages"] = a["stages"][1:]
            (root / name / "shard-run.json").write_text(json.dumps({"apps": list(apps)}))

        # Fail closed: a shard that left no result (a crashed or cancelled
        # validate job) fails the merge, so the gate writes no stats.json and
        # the leg is red, never a smaller green denominator.
        missing = two_app_migrate(d / "missing")
        shard_with(d / "missing-shards", "cs2gs-selfmig-shard-1", app("src/A/A.csproj", *GREEN))
        gate = run_gate(missing, d / "missing-shards")
        assert gate.returncode != 0 and "no shard reported a result" in gate.stderr, gate.stderr
        assert not (missing / "stats.json").exists()
        r = leg.leg_result("gsharp-csharp", gate.returncode, missing / "stats.json", "", "", "u")
        assert r["status"] == "red" and "no stats.json" in r["summary"], r
        # A corrupt (truncated) shard artifact fails closed the same way.
        corrupt = two_app_migrate(d / "corrupt")
        shard_with(d / "corrupt-shards", "cs2gs-selfmig-shard-1", app("src/A/A.csproj", *GREEN), app("src/B/B.csproj", *GREEN))
        (d / "corrupt-shards" / "cs2gs-selfmig-shard-1" / "shard-run.json").write_text('{"apps": [')
        gate = run_gate(corrupt, d / "corrupt-shards")
        assert gate.returncode != 0 and not (corrupt / "stats.json").exists(), gate.stderr
        assert leg.leg_result("gsharp-csharp", gate.returncode, corrupt / "stats.json", "", "", "u")["status"] == "red"
        # A failure inside ONE validate shard reaches the merged run, the
        # stats and the leg result.
        one_red = two_app_migrate(d / "one-red")
        shard_with(d / "one-red-shards", "cs2gs-selfmig-shard-1", app("src/A/A.csproj", *GREEN))
        shard_with(d / "one-red-shards", "cs2gs-selfmig-shard-2", app("src/B/B.csproj", *COMPILE_RED, category="compile-error"))
        gate = run_gate(one_red, d / "one-red-shards")
        s = json.loads((one_red / "stats.json").read_text())
        assert (s["green"], s["total"], s["compile_failed"]) == (1, 2, 1), s
        assert s["redApps"] == ["src/B/B.csproj (compile-error, reached compile)"], s
        assert leg.leg_result("gsharp-csharp", gate.returncode, one_red / "stats.json", "", "", "u")["status"] == "red"
        # The baseline is main's tools/cs2gs/selfmig-baseline.json even when
        # SELFMIG_SOURCE_ROOT points at a corpus carrying its own copy.
        corpus = d / "corpus"
        (corpus / "tools" / "cs2gs").mkdir(parents=True)
        (corpus / "tools" / "cs2gs" / "selfmig-baseline.json").write_text(json.dumps(
            {"greenFloor": 1, "syntheticLabelCeiling": 99, "liftedLocalCeiling": 99, "longLineCeiling": 99,
             "nullAssertionCeiling": 99, "greenApps": [], "stageFloor": {}}))
        from_corpus = two_app_migrate(d / "from-corpus")
        shard_with(d / "from-corpus-shards", "cs2gs-selfmig-shard-1", app("src/A/A.csproj", *GREEN), app("src/B/B.csproj", *GREEN))
        gate = run_gate(from_corpus, d / "from-corpus-shards", SELFMIG_SOURCE_ROOT=str(corpus))
        s = json.loads((from_corpus / "stats.json").read_text())
        assert (s["green"], s["floor"], s["baseline"]) == (2, floor, "failed"), s
        assert gate.returncode != 0 and f"fell below floor {floor}" in gate.stderr, gate.stderr
        shard_with_runner_local_oracle(d)
        single_job_with_separate_corpus(d)
    print("OK")


STUB_DOTNET = r"""#!/usr/bin/env bash
# A stand-in for dotnet: builds, restores and tool restores do nothing; the
# cs2gs verbs write the minimum the selfmig scripts read, and `validate`
# records what the migrated mirror looked like when validation started.
case "$1" in build|restore|tool) exit 0 ;; esac
verb=$2
shift 2
args=("$@")
get() { local i; for ((i = 0; i < ${#args[@]}; i++)); do [[ ${args[i]} == "$1" ]] && echo "${args[i+1]}"; done; }
case "$verb" in
  migrate)
    mkdir -p "$(get --out)" "$(get --artifacts)/r1"
    echo '{"runId":"r1","succeeded":true,"apps":[{"appId":"src/A/A.csproj","succeeded":true,"stages":[{"stage":"translate","status":"passed"}]}]}' \
      > "$(get --artifacts)/r1/run.json" ;;
  capture-test-oracle)
    [[ ${STUB_CAPTURE_FAIL:-0} == 1 ]] && exit 1
    mkdir -p "$(get --out)"
    printf '%s' "${STUB_CASES:-runner cases}" > "$(get --out)/cases"
    printf '%s\n' "${args[@]}" > "$(get --out)/capture-args" ;;
  validate)
    { ls "$(get --migrated)/.nugs"; echo "channels=${GsharpChannelsRuntimeAssemblyFullPath:-<unset>}"; } > "$STUB_LOG"
    status=passed
    [[ -f "$(get --csharp-test-oracle)/cases" ]] &&
      [[ $(cat "$(get --csharp-test-oracle)/cases") == "${STUB_CASES:-runner cases}" ]] || status=failed
    mkdir -p "$(get --artifacts)/r2"
    echo "{\"apps\":[{\"appId\":\"src/A/A.csproj\",\"succeeded\":$([[ $status == passed ]] && echo true || echo false),\"stages\":[{\"stage\":\"compile\",\"status\":\"passed\"},{\"stage\":\"ilverify\",\"status\":\"passed\"},{\"stage\":\"test-parity\",\"status\":\"$status\"}]}]}" \
      > "$(get --artifacts)/r2/run.json" ;;
  *) echo "stub dotnet: unexpected $verb" >&2; exit 2 ;;
esac
"""


def single_job_with_separate_corpus(d: Path) -> None:
    """Issue #4919: the single-job path with a SEPARATE corpus runs translate,
    one validate shard and the gate, so the mirror is validated with the
    corpus SDK staged in its local feed and the corpus runtime under the SDK,
    exactly as the nightly's shards are."""
    corpus = d / "sj-corpus"
    (corpus / "out" / "bin" / "Release" / "nupkgs").mkdir(parents=True)
    (corpus / "GSharp.sln").write_text("")
    with zipfile.ZipFile(corpus / "out" / "bin" / "Release" / "nupkgs" / "Gsharp.NET.Sdk.0.4.1271-gabc.nupkg", "w") as z:
        for member in ("tools/extensions//Gsharp.Extensions.dll", "tools/channels//Gsharp.Runtime.Channels.dll",
                       "tools/values//Gsharp.Runtime.Values.dll"):
            z.writestr(member, member)
    stub = d / "sj-bin"
    stub.mkdir()
    (stub / "dotnet").write_text(STUB_DOTNET)
    (stub / "dotnet").chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
    env.update(PATH=f"{stub}:{env['PATH']}", SELFMIG_SOURCE_ROOT=str(corpus),
               SELFMIG_GATE_ROOT=str(d / "sj-root"), STUB_LOG=str(d / "sj-validate.log"))
    run = subprocess.run(["bash", str(HERE / "run-cs2gs-selfmig.sh")], capture_output=True, text=True, env=env)
    seen = (d / "sj-validate.log").read_text().splitlines()
    assert "Gsharp.NET.Sdk.0.4.1271-gabc.nupkg" in seen, (seen, run.stderr[-2000:])
    real = corpus.resolve()
    assert f"channels={real}/out/selfmig-corpus-sdk/channels/Gsharp.Runtime.Channels.dll" in seen, seen
    stats = json.loads((d / "sj-root" / "stats.json").read_text())
    assert (stats["green"], stats["total"], stats["runLevelFailure"]) == (1, 1, False), stats
    # One green app is far below the real greenFloor: the gate's verdict and
    # exit status come through.
    assert run.returncode != 0 and stats["baseline"] == "failed", run.stderr[-2000:]


def shard_with_runner_local_oracle(d: Path) -> None:
    """Run the real shard script with a process double for the SDK and CLI.

    The producer lists three closures; the validator has four. A failed
    local capture must not fall back to the producer's stale oracle.
    """
    root = d / "local-oracle"
    (root / "migrated" / ".nugs").mkdir(parents=True)
    manifest = root / "runs" / "r1"
    manifest.mkdir(parents=True)
    (manifest / "run.json").write_text("{}")
    (root / "migrate-run-dir.txt").write_text(str(manifest))
    (root / "csharp-tests").mkdir()
    (root / "csharp-tests" / "cases").write_text("three closures")
    stub = d / "oracle-bin"
    stub.mkdir()
    (stub / "dotnet").write_text(STUB_DOTNET)
    (stub / "dotnet").chmod(0o755)
    env = dict(os.environ, PATH=f"{stub}:{os.environ['PATH']}",
               SELFMIG_GATE_ROOT=str(root), SELFMIG_SOURCE_ROOT=str(HERE.parent),
               STUB_LOG=str(d / "oracle-validate.log"), STUB_CASES="four closures")
    for capture_fails in (False, True):
        env["STUB_CAPTURE_FAIL"] = "1" if capture_fails else "0"
        run = subprocess.run(
            ["bash", str(HERE / "run-cs2gs-selfmig-validate.sh"), "local", "src/A/A.csproj"],
            capture_output=True, text=True, env=env)
        assert run.returncode == 0, run.stderr
        shard = root / "shard-local"
        result = json.loads((shard / "shard-run.json").read_text())["apps"][0]
        assert result["succeeded"] is not capture_fails, (result, run.stdout, run.stderr)
        if not capture_fails:
            args = (shard / "csharp-tests" / "capture-args").read_text().splitlines()
            assert args[args.index("--app") + 1:] == ["src/A/A.csproj"], args
            assert args[args.index("--config") + 1] == "Release", args
        else:
            assert result["stages"][-1]["status"] == "failed", result
            assert not (shard / "csharp-tests" / "cases").exists()


main()
