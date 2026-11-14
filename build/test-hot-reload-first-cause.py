#!/usr/bin/env python3
"""Local native-mechanism and privacy canaries; never a reproduction of issue 5976."""
import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("capture5976", ROOT / "build/hot-reload-first-cause.py")
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)
WORK = ROOT / "out/artifacts/issue-5976-first-cause/local-validation"
RAW = WORK / "raw"
SECRET = b"PRIVATE_5976_CANARY_NOT_FOR_PUBLICATION"


def run_private(command, name, env=None, timeout=120, expected=0):
    with (RAW / name).open("wb") as stream:
        process = subprocess.Popen(
            command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT,
        )
        try:
            result = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError("native_canary_timeout") from None
    if result != expected:
        raise RuntimeError("native_canary_failed")
    return process.pid


class FirstCauseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RAW.mkdir(parents=True, exist_ok=True)
        cls.run_root = RAW / ("canaries-" + uuid.uuid4().hex)
        cls.run_root.mkdir()
        cls.fixture = WORK / "native-fixture"
        cls.fixture.mkdir(exist_ok=True)
        (cls.fixture / "Directory.Build.props").write_text("<Project />")
        (cls.fixture / "Directory.Build.targets").write_text("<Project />")
        shutil.copyfile(
            ROOT / "build/hot-reload-first-cause/Canary.cs.txt",
            cls.fixture / "Program.cs",
        )
        (cls.fixture / "Canary.csproj").write_text("""<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>
<ItemGroup>
<Reference Include="Microsoft.Build" HintPath="$(MSBuildBinPath)/Microsoft.Build.dll" />
<Reference Include="Microsoft.Build.Framework" HintPath="$(MSBuildBinPath)/Microsoft.Build.Framework.dll" />
<Reference Include="Microsoft.Build.Utilities.Core" HintPath="$(MSBuildBinPath)/Microsoft.Build.Utilities.Core.dll" />
</ItemGroup></Project>""")
        run_private(
            ["dotnet", "build", str(cls.fixture / "Canary.csproj"), "-c", "Release", "--nologo", "-v:q"],
            "fixture-build.log",
        )
        run_private(
            ["dotnet", "build", str(CAPTURE.PROJECT), "-c", "Release", "--no-restore", "--nologo", "-v:q"],
            "projector-build.log",
        )
        cls.dll = cls.fixture / "bin/Release/net10.0/Canary.dll"
        cls.child, cls.child_pid = cls.native("initial")
        cls.watcher, cls.watcher_pid = cls.native("watcher")
        cls.summary = cls.project(cls.child, cls.child_pid, cls.watcher, cls.watcher_pid, "native-summary")

    @classmethod
    def native(cls, label, mode=None):
        path = cls.run_root / label
        path.mkdir()
        env = os.environ.copy()
        env.update({
            "DOTNET_EnableEventPipe": "1",
            "DOTNET_EventPipeOutputPath": str(path / "process-{pid}.nettrace"),
            "DOTNET_EventPipeConfig": "Microsoft-Build:1:4,Microsoft-Windows-DotNETRuntime:8000:4",
            "DOTNET_EventPipeCircularMB": "1" if mode == "loss" else "8",
            "DOTNET_EventPipeOutputStreaming": "0",
            "PRIVATE_5976_CANARY_ENV": SECRET.decode(),
        })
        if mode == "no-rundown":
            env["DOTNET_EventPipeRundown"] = "0"
        if mode == "no-stacks":
            env["DOTNET_EventPipeEnableStackwalk"] = "0"
        args = ["dotnet", str(cls.dll), str(path)]
        if mode == "loss":
            args.append("loss")
        pid = run_private(args, f"{label}-run.log", env=env)
        return path, pid

    @classmethod
    def project(cls, child, child_pid, watcher, watcher_pid, label):
        output = RAW / f"{label}.json"
        run_private(
            ["dotnet", str(CAPTURE.HELPER), str(child / "native.binlog"),
             str(child / f"process-{child_pid}.nettrace"),
             str(watcher / f"process-{watcher_pid}.nettrace"),
             str(child_pid), str(watcher_pid), str(output)],
            f"{label}-helper-run.log",
        )
        value = json.loads(output.read_bytes())
        CAPTURE.validate_summary(value)
        if SECRET in output.read_bytes():
            raise RuntimeError("canary_leaked")
        return value

    def test_native_cancel_and_caught_exception_origins(self):
        self.assertNotEqual(self.child_pid, self.watcher_pid)
        for role, pid, path, data in zip((1, 2), (self.child_pid, self.watcher_pid),
                                       (self.child, self.watcher), self.summary["processes"]):
            expected = json.loads((path / "expected.json").read_bytes())
            self.assertEqual(data["role"], role)
            self.assertEqual(data["pid"], pid)
            self.assertEqual(data["status"], 0)
            self.assertGreater(data["cancellations"], 0)
            self.assertGreater(data["exceptions"], 1000)
            cancels = [e for e in data["events"] if e["kind"] == 7]
            self.assertTrue(bool(cancels), "native_cancellation_not_observed")
            self.assertTrue(
                any(f["category"] == 1 for e in cancels for f in e["frames"]),
                "native_buildmanager_caller_not_decoded",
            )
            self.assertTrue(any(f["token"] == expected["owner_token"] for e in cancels for f in e["frames"]),
                            "actual_native_cancellation_owner_not_retained")
            exceptions = [e for e in data["events"] if e["kind"] == 8]
            self.assertTrue(bool(exceptions), "caught_exception_not_observed")
            self.assertTrue(
                any(f["category"] == 0 and f["token"] == expected["throw_token"]
                    and e["category"] == 7 and CAPTURE.HEX.fullmatch(f["identity"])
                    for e in exceptions for f in e["frames"]),
                "unknown_frame_not_opaque",
            )
            unknown = [
                e for e in exceptions
                if any(f["token"] == expected["unknown_token"] for f in e["frames"])
            ]
            self.assertTrue(bool(unknown), "actual_unknown_exception_origin_not_retained")
            self.assertTrue(any(
                e["category"] == 0 and e["identity"] == expected["unknown_type_hash"]
                and e["hresult_present"] and e["hresult"] & 0xFFFFFFFF == 0xF1234567
                for e in unknown
            ), "actual_unknown_exception_identity_or_hresult_missing")
            frames = [f for e in data["events"] for f in e["frames"]]
            self.assertTrue(all(CAPTURE.GUID.fullmatch(f["pdb_guid"]) for f in frames))
            self.assertTrue(any(f["pdb_guid"] != "0" * 32 for f in frames))
            self.assertTrue(data["selection_truncated"])
            self.assertLessEqual(len(exceptions), 6)
            self.assertFalse(self.summary["absence_proven"])

    def test_native_failed_task_is_preserved(self):
        data = self.summary["build"]
        self.assertEqual(data["status"], 0)
        self.assertEqual(data["succeeded"], 0)
        self.assertGreater(data["tasks_finished"], 0)
        self.assertTrue(any(e["kind"] in (1, 2, 3, 5) for e in data["events"]))

    def test_schema_rejects_leaks_unknown_keys_and_wrong_types(self):
        for mutation in ("field", "opaque", "bool", "count", "inference", "pdb", "hresult", "hresult_range"):
            value = copy.deepcopy(self.summary)
            if mutation == "field":
                value["raw_message"] = SECRET.decode()
            elif mutation == "opaque":
                value["processes"][0]["events"][0]["frames"][0]["identity"] = SECRET.decode()
            elif mutation == "bool":
                value["build"]["errors"] = True
            elif mutation == "count":
                value["processes"][0]["events"] *= 20
            elif mutation == "inference":
                value["absence_proven"] = True
            elif mutation == "pdb":
                value["processes"][0]["events"][0]["frames"][0]["pdb_guid"] = SECRET.decode()
            elif mutation == "hresult":
                value["processes"][0]["events"][0]["hresult"] = SECRET.decode()
            else:
                value["processes"][0]["events"][0]["hresult"] = 4294967296
            with self.assertRaises(ValueError):
                CAPTURE.validate_summary(value)
        for code in (-2147483648, -1, 0, 2147483647, 4294967295):
            value = copy.deepcopy(self.summary)
            value["processes"][0]["events"][0]["hresult"] = code
            CAPTURE.validate_summary(value)

    def test_route_truth_table(self):
        sha = "a" * 40
        valid = ("workflow_dispatch", CAPTURE.BRANCH, sha, 1, True, sha)
        self.assertEqual(CAPTURE.route(*valid), (False, True))
        for index, replacement in ((0, "schedule"), (1, "refs/heads/main"), (2, "b" * 40), (3, 2), (5, "invalid")):
            args = list(valid)
            args[index] = replacement
            nightly, diagnostic = CAPTURE.route(*args)
            self.assertFalse(diagnostic)
            self.assertEqual(nightly, index == 0)
        self.assertEqual(CAPTURE.route("schedule", "refs/heads/main", sha, 1, False, ""), (True, False))
        self.assertEqual(CAPTURE.route("workflow_dispatch", "refs/heads/main", sha, 1, False, ""), (True, False))
        self.assertFalse(CAPTURE.route("workflow_dispatch", CAPTURE.BRANCH.upper(), sha, 1, True, sha)[1])
        self.assertFalse(CAPTURE.route("workflow_dispatch", CAPTURE.BRANCH, sha, 1, True, sha.upper())[1])

    def test_native_missing_rundown_stacks_loss_and_partial(self):
        for mode, expected in (("no-rundown", 6), ("no-stacks", 5), ("loss", 4)):
            path, pid = self.native(mode, mode)
            value = self.project(path, pid, self.watcher, self.watcher_pid, mode)
            self.assertEqual(value["processes"][0]["status"], expected)
            if mode == "loss":
                self.assertGreater(value["processes"][0]["events_lost"], 0)
            self.assertFalse(value["absence_proven"])
        partial = self.run_root / "partial"
        partial.mkdir()
        shutil.copyfile(self.child / "native.binlog", partial / "native.binlog")
        trace = self.child / f"process-{self.child_pid}.nettrace"
        data = trace.read_bytes()
        (partial / trace.name).write_bytes(data[:len(data) // 2])
        value = self.project(partial, self.child_pid, self.watcher, self.watcher_pid, "partial")
        self.assertNotEqual(value["processes"][0]["status"], 0)
        self.assertFalse(value["absence_proven"])

    def test_native_wildcard_preserves_both_builds_and_pid_selection(self):
        path = self.run_root / "unique"
        path.mkdir()
        project = path / "Build.proj"
        project.write_text('<Project><Target Name="Build" /></Project>')
        option = f"-bl:{path}/initial-{{}}.binlog;ProjectImports=None;OmitInitialInfo"
        first_pid = run_private(["dotnet", "msbuild", str(project), "-nologo", option], "unique-first-build.log")
        first_files = list(path.glob("initial-*.binlog"))
        self.assertEqual(len(first_files), 1)
        first_hash = CAPTURE.digest(first_files[0])
        project.write_text('<Project><Target Name="Build"><MissingTask /></Target></Project>')
        run_private(["dotnet", "msbuild", str(project), "-nologo", option], "unique-second-build.log", expected=1)
        self.assertEqual(len(list(path.glob("initial-*.binlog"))), 2)
        self.assertEqual(CAPTURE.digest(first_files[0]), first_hash)
        self.assertTrue(bool(CAPTURE.native_binlog_pattern(first_pid).fullmatch(first_files[0].name)))
        self.assertTrue(bool(CAPTURE.native_binlog_pattern(first_pid).fullmatch(
            f"initial-20261114-000000--{first_pid}--Ab+_19.binlog"
        )))
        (path / "watcher-pid.txt").write_text(str(self.watcher_pid))
        (path / "watch.log").write_text(
            f"Launched '/native/dotnet' with arguments 'build /repo/samples/HotReload/App/App.gsproj --no-restore': process id {first_pid}"
        )
        selected = CAPTURE.select_inputs(path)
        self.assertEqual(selected[0], first_files[0])
        self.assertEqual(selected[5], 1)
        output = RAW / "unique-first-summary.json"
        run_private(
            ["dotnet", str(CAPTURE.HELPER), str(selected[0]), str(path / "missing"),
             str(path / "missing"), str(first_pid), str(self.watcher_pid), str(output)],
            "unique-helper-run.log",
        )
        self.assertEqual(json.loads(output.read_bytes())["build"]["succeeded"], 1)

    def test_original_watch_arguments_and_runtime_oracles_unchanged(self):
        text = (ROOT / "e2etests/hot-reload-e2e.sh").read_text()
        fragment = text[text.index("WATCH_COMMAND=(dotnet watch"):text.index('\n"${WATCH_COMMAND[@]}" >')]
        expected = ["dotnet", "watch", "--project", "samples/HotReload/App/App.gsproj",
                    "--no-restore", "--non-interactive", "--verbose"]
        for enabled in ("0", "1"):
            probe = self.run_root / ("argv-" + enabled)
            command = (
                'python3() { mkdir -p "$ROOT/out/artifacts/issue-5976-first-cause/capture/raw"; }\n'
                f'ROOT="{probe}"\n'
                'APP=samples/HotReload/App/App.gsproj\n'
                f'GSHARP_HOT_RELOAD_FIRST_CAUSE={enabled}\n'
                + fragment + '\nprintf "%s\\0" "${WATCH_COMMAND[@]}"'
            )
            result = subprocess.run(["bash", "-c", command], cwd=ROOT, capture_output=True, check=True)
            output = result.stdout
            if enabled == "1":
                self.assertEqual(result.stdout, b"")
                output = (probe / "out/artifacts/issue-5976-first-cause/capture/raw/private-harness.log").read_bytes()
            arguments = output.decode().rstrip("\0").split("\0")
            if enabled == "0":
                self.assertEqual(arguments, expected)
            else:
                self.assertEqual(arguments[6:13], expected)
                self.assertTrue(arguments[-1].endswith("initial-{}.binlog;ProjectImports=None;OmitInitialInfo"))
        baseline = subprocess.run(
            ["git", "show", "388bfab155660bcac2d4ed0b22e859bf6adbf2a5:e2etests/hot-reload-e2e.sh"],
            cwd=ROOT, capture_output=True, check=True,
        ).stdout.decode()
        marker = 'wait_for "values=1,2,3"'
        self.assertEqual(text.split(marker)[1], baseline.split(marker)[1])

    def test_actual_workflow_guards_permissions_and_no_subscribers(self):
        result = subprocess.run(
            ["ruby", "-rjson", "-ryaml", "-e",
             'puts JSON.generate(Dir[".github/workflows/*"].to_h { |f| [f, YAML.load_file(f)] })'],
            cwd=ROOT, capture_output=True, check=True,
        )
        workflows = json.loads(result.stdout)
        workflow = workflows[".github/workflows/cs2gs-nightly.yml"]
        self.assertFalse(workflow["true"]["workflow_dispatch"]["inputs"]["issue_5976_first_cause"]["default"])
        jobs = workflow["jobs"]
        self.assertEqual(jobs["nightly"]["if"], "github.event_name != 'workflow_dispatch' || !inputs.issue_5976_first_cause")
        job = jobs["issue-5976-first-cause"]
        self.assertEqual(" ".join(job["if"].split()),
            "github.event_name == 'workflow_dispatch' && inputs.issue_5976_first_cause && "
            "github.ref == 'refs/heads/oats/5976-first-submission-cause' && "
            "github.sha == inputs.expected_sha && github.run_attempt == 1")
        self.assertEqual(job["permissions"], {"contents": "read"})
        self.assertNotIn("concurrency", workflow)
        checkout = next(s for s in job["steps"] if s.get("uses") == "actions/checkout@v5")
        self.assertFalse(checkout["with"]["persist-credentials"])
        self.assertEqual(
            sum("GITHUB_TOKEN" in s.get("env", {}) for s in job["steps"]), 1,
        )
        self.assertTrue(any("./build/run-e2e-tests.sh\n" in s.get("run", "") for s in job["steps"]))
        projection = next(s for s in job["steps"] if s.get("id") == "project5976")
        self.assertIn("steps.guard5976.outcome == 'success'", projection["if"])
        self.assertIn("steps.e2e5976.outputs.capture_fresh == 'true'", projection["if"])
        self.assertTrue(any(s.get("id") == "guard5976" for s in job["steps"]))
        baseline_text = subprocess.run(
            ["git", "show", "388bfab155660bcac2d4ed0b22e859bf6adbf2a5:.github/workflows/cs2gs-nightly.yml"],
            cwd=ROOT, capture_output=True, check=True,
        ).stdout
        baseline = json.loads(subprocess.run(
            ["ruby", "-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.load(STDIN.read))"],
            input=baseline_text, capture_output=True, check=True,
        ).stdout)
        original_job = copy.deepcopy(jobs["nightly"])
        original_job.pop("if")
        self.assertEqual(original_job, baseline["jobs"]["nightly"])
        self.assertEqual(workflow["permissions"], baseline["permissions"])
        self.assertEqual(workflow["true"]["schedule"], baseline["true"]["schedule"])
        for name, value in workflows.items():
            events = value["true"]
            self.assertTrue(
                not {"workflow_run", "check_run", "check_suite", "repository_dispatch", "workflow_call"} & set(events),
                "repository_subscriber_found",
            )
            if "push" in events:
                self.assertEqual(events["push"].get("branches"), ["main"])

    def test_source_has_no_unreviewed_data_string_output(self):
        text = (ROOT / "build/hot-reload-first-cause/Program.gs").read_text()
        strings = [line.strip() for line in text.splitlines() if "writer.WriteString(" in line]
        self.assertEqual(strings, [
            'writer.WriteString("identity", entry.Identity)',
            'writer.WriteString("identity", frame.Identity)',
            'writer.WriteString("module", frame.Module)',
            'writer.WriteString("pdb_guid", frame.PdbGuid)',
        ])
        self.assertNotIn("Console.", text)
        self.assertIn("Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))", text)

    def test_budget_drops_only_supplemental_exceptions(self):
        value = copy.deepcopy(self.summary)
        template = copy.deepcopy(value["processes"][0]["events"][0])
        for key in ("node", "project", "target", "task", "submission", "parent_project", "thread"):
            template[key] = 2147483647
        template["ticks"] = 3155378975999999999
        template["identity"] = "F" * 64
        template["hresult"] = 4294967295
        template["hresult_present"] = True
        template["frames"] = [
            {"category": 0, "token": 2147483647, "identity": "F" * 64,
             "module": "F" * 64, "pdb_guid": "F" * 32}
            for _ in range(10)
        ]
        failure = copy.deepcopy(template)
        failure.update(kind=3, frames=[], hresult=0, hresult_present=False)
        value["build"]["events"] = [copy.deepcopy(failure) for _ in range(32)]
        for process in value["processes"]:
            cancel = copy.deepcopy(template)
            cancel.update(kind=7, hresult=0, hresult_present=False)
            exception = copy.deepcopy(template)
            exception["kind"] = 8
            process["events"] = (
                [copy.deepcopy(cancel) for _ in range(4)]
                + [copy.deepcopy(exception) for _ in range(6)]
            )
        self.assertGreater(len(json.dumps(value, separators=(",", ":"), sort_keys=True).encode()), 61440)
        self.assertLessEqual(len(json.dumps(value, separators=(",", ":"), sort_keys=True).encode()), 131072)
        negatives = copy.deepcopy(value["build"]["events"])
        cancellations = [[copy.deepcopy(e) for e in p["events"] if e["kind"] == 7] for p in value["processes"]]
        repeat = copy.deepcopy(value)
        encoded = CAPTURE.bounded_encoding(value)
        self.assertEqual(CAPTURE.bounded_encoding(repeat), encoded)
        self.assertLessEqual(len(encoded), 61440)
        result = json.loads(encoded)
        CAPTURE.validate_summary(result)
        self.assertEqual(result["build"]["events"], negatives)
        self.assertEqual([[e for e in p["events"] if e["kind"] == 7] for p in result["processes"]], cancellations)
        self.assertLess(sum(e["kind"] == 8 for p in result["processes"] for e in p["events"]), 12)
        self.assertTrue(any(p["selection_truncated"] for p in result["processes"]))
        self.assertFalse(result["absence_proven"])

    def test_publication_bounds_and_private_fail_closed(self):
        path = self.run_root / "publication"
        path.mkdir()
        raw = path / "raw"
        raw.mkdir()
        publish = path / "publish"
        CAPTURE.project(raw, publish, e2e_exit=1, build=False)
        CAPTURE.validate_publication(publish)
        self.assertLessEqual(sum(p.stat().st_size for p in publish.iterdir()), 65536)
        self.assertEqual(json.loads((publish / "manifest.json").read_bytes())["e2e_exit"], 1)
        self.assertFalse(json.loads((publish / "manifest.json").read_bytes())["formal_ci"])
        (publish / "raw-extra").write_text("private")
        with self.assertRaises(ValueError):
            CAPTURE.validate_publication(publish)
        (publish / "raw-extra").unlink()
        original = (publish / "summary.json").read_bytes()
        (publish / "summary.json").write_bytes(b" " * 65537)
        with self.assertRaises(ValueError):
            CAPTURE.validate_publication(publish)
        (publish / "summary.json").write_bytes(original)
        data = json.loads(original)
        data["leak"] = SECRET.decode()
        (publish / "summary.json").write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            CAPTURE.validate_publication(publish)

    def test_linux_watcher_identity_is_not_the_cli_launcher(self):
        proc = self.run_root / "proc-fixture"
        for pid, arguments, children in (
            (100, b"dotnet\0watch\0", "101"),
            (101, b"dotnet\0/sdk/dotnet-watch.dll\0", "102"),
            (102, b"dotnet\0build\0App.gsproj\0", ""),
        ):
            path = proc / str(pid)
            (path / "task" / str(pid)).mkdir(parents=True)
            (path / "cmdline").write_bytes(arguments)
            (path / "task" / str(pid) / "children").write_text(children)
        self.assertEqual(CAPTURE.watcher_pid(100, proc), 101)
        self.assertEqual(CAPTURE.watcher_pid(102, proc), 0)

    def test_only_new_owned_default_watch_sidecars_are_moved(self):
        root = self.run_root / "sidecar-owner"
        root.mkdir()
        original_root, original_raw = CAPTURE.ROOT, CAPTURE.RAW
        CAPTURE.ROOT = root
        CAPTURE.RAW = root / "raw"
        try:
            self.assertEqual(CAPTURE.prepare(), 0)
            owned = root / "msbuild-dotnet-watch.DesignTimeBuild.App.gsproj.1.binlog"
            unrelated = root / "other.binlog"
            owned.write_bytes(b"owned")
            unrelated.write_bytes(b"unrelated")
            CAPTURE.finish()
            self.assertFalse(owned.exists())
            self.assertTrue((CAPTURE.RAW / owned.name).is_file())
            self.assertEqual(unrelated.read_bytes(), b"unrelated")
            blocked = root / "blocked"
            blocked.mkdir()
            old = blocked / owned.name
            old.write_bytes(b"preexisting")
            CAPTURE.ROOT = blocked
            CAPTURE.RAW = blocked / "raw"
            self.assertEqual(CAPTURE.prepare(), 1)
            CAPTURE.finish()
            self.assertEqual(old.read_bytes(), b"preexisting")
        finally:
            CAPTURE.ROOT, CAPTURE.RAW = original_root, original_raw

    def test_cleanup_keeps_original_exit_status(self):
        text = (ROOT / "e2etests/hot-reload-e2e.sh").read_text()
        cleanup = text[text.index("cleanup() {"):text.index("\ntrap cleanup EXIT")]
        path = self.run_root / "cleanup-status"
        path.mkdir()
        retained = path / "retained"
        retained.mkdir()
        (path / "watch.log").write_bytes(SECRET)
        command = (
            "set -euo pipefail\npython3() { return 0; }\ngit() { return 0; }\n"
            f'FIRST_CAUSE_RAW="{retained}"\nLOG="{path}/watch.log"\n'
            'WATCH_PID=""\nSAMPLE=unused\n' + cleanup + "\ntrap cleanup EXIT\nexit 17\n"
        )
        result = subprocess.run(["bash", "-c", command], cwd=ROOT, capture_output=True)
        self.assertEqual(result.returncode, 17)
        self.assertNotIn(SECRET, result.stdout)
        self.assertNotIn(SECRET, result.stderr)
        self.assertEqual((retained / "watch.log").read_bytes(), SECRET)


if __name__ == "__main__":
    unittest.main()
