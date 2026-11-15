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
from unittest.mock import patch
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


class CaptureQualityContractTests(unittest.TestCase):
    def host_contract(self, path):
        path.mkdir(parents=True)
        readers = []
        for kind, name in enumerate(("Microsoft.Build.dll", "Microsoft.Build.Framework.dll", CAPTURE.TASK_FILES[2]), 1):
            file = path / name
            file.write_bytes(("SYNTHETIC_SELECTED_HOST_CONTRACT_" + name).encode())
            readers.append({
                "kind": kind, "known": True, "name_identity": hashlib.sha256(name.encode()).hexdigest(),
                "sha256": CAPTURE.digest(file), "mvid": f"{kind:032x}",
                "assembly_version": [15, 1, 0, 0],
                "file_version": [4, 0, 0, 0] if kind == 3 else [18, 12, 2, 53018],
            })
        return {"sdk": path}, readers, path / "HotReloadFirstCause.dll"

    def test_host_binding_checks_selected_hash_role_version_and_observed_mvid(self):
        path = RAW / ("host-binding-" + uuid.uuid4().hex)
        host, readers, helper = self.host_contract(path)
        with patch.object(CAPTURE, "HELPER", helper):
            CAPTURE.validate_host_binding({"readers": readers}, host)
            alternate = copy.deepcopy(readers)
            alternate[0]["mvid"] = "a" * 32
            alternate[1]["mvid"] = "b" * 32
            CAPTURE.validate_host_binding({"readers": alternate}, host)
            for role, field, invalid in (
                (0, "sha256", "0" * 64), (1, "sha256", ""),
                (0, "kind", 2), (1, "kind", 1),
                (0, "file_version", [18, 99, 2, 0]),
                (1, "file_version", [17, 12, 2, 0]),
                (0, "known", False), (1, "mvid", "0" * 32),
            ):
                value = copy.deepcopy(readers)
                value[role][field] = invalid
                with self.assertRaises(ValueError):
                    CAPTURE.validate_host_binding({"readers": value}, host)

    def test_owned_early_observations_survive_unknown_project_but_not_mismatch(self):
        path = RAW / ("early-ownership-" + uuid.uuid4().hex)
        host, readers, helper = self.host_contract(path / "host")
        expected = path / "Expected.proj"
        expected.write_text("<Project />")
        for binding, snapshot_ok, header_known in (
            (0, True, True), (1, True, True), (2, True, True),
            (0, False, True), (0, True, False),
        ):
            raw = path / f"case-{binding}-{snapshot_ok}-{header_known}"
            raw.mkdir()
            directory = CAPTURE.initialize_session(raw, expected)
            source = directory / "initial-20261114-000000--10002--Ab+_19.binlog"
            source.write_bytes(b"SYNTHETIC_OBSERVER_INPUT_NOT_A_NATIVE_LOG")
            (raw / "watch.log").write_text(
                f"Launched '/native/dotnet' with arguments 'build {expected} {CAPTURE.binlog_option(raw)}': process id 10001\n"
                "Process id 10001 ran for 1ms and exited with exit code 1\n"
            )
            value = CAPTURE.empty_summary(1)
            value["capture_quality"] = 2
            value["readers"] = copy.deepcopy(readers)
            value["build"].update(status=0, succeeded=0, errors=1, build_started=True,
                                  build_finished_seen=True, replay_returned=True)
            value["build"]["reader"].update(
                stage=5, outcome=1, returned=True, input_bytes_known=True,
                input_bytes=source.stat().st_size, header_known=header_known,
                format_version=26 if header_known else 0, minimum_reader_version=18 if header_known else 0,
            )
            value["build"]["events"] = [{
                "kind": 4, "ticks": 1, "node": -1, "project": -1, "target": -1,
                "task": -1, "submission": -1, "parent_project": -1, "category": 0,
                "role": 0, "thread": 0, "identity": "", "hresult": 0,
                "hresult_present": False, "frames_truncated": False, "frames": [],
            }]
            def projected(task_raw, binlog, target, selected_host, physical_project):
                shutil.copyfile(binlog, task_raw / "private-snapshot.binlog")
                (task_raw / "private-ownership.json").write_text(json.dumps({
                    "schema": 1, "snapshot_created": snapshot_ok, "snapshot_bytes": binlog.stat().st_size,
                    "snapshot_sha256": CAPTURE.digest(binlog), "root_projects": 0 if binding == 0 else 1,
                    "matching_roots": 1 if binding == 1 else 0, "project_bound": binding == 1,
                    "project_binding": binding,
                }))
                target.write_text(json.dumps(value))
                return 0
            with patch.object(CAPTURE, "HELPER", helper), patch.object(CAPTURE, "run_native_task", side_effect=projected):
                CAPTURE.project(raw, raw / "publish", e2e_exit=1, build=False, host=host)
            manifest = json.loads((raw / "publish/manifest.json").read_bytes())
            summary = json.loads((raw / "publish/summary.json").read_bytes())
            if binding != 2 and snapshot_ok and header_known:
                self.assertEqual(summary, value)
                self.assertEqual(manifest["capture_quality"], 2)
                self.assertTrue(manifest["snapshot_verified"])
                self.assertTrue(manifest["capability_verified"])
                self.assertEqual(manifest["project_binding"], binding)
                self.assertEqual(manifest["project_bound"], binding == 1)
            else:
                self.assertEqual(manifest["capture_quality"], 0)
                self.assertEqual(summary, CAPTURE.empty_summary(8))

    def test_quality_zero_requires_the_canonical_unavailable_fallback(self):
        for status in (1, 3, 7, 8):
            CAPTURE.validate_summary(CAPTURE.empty_summary(status))
        loss = CAPTURE.empty_summary(1)
        loss["capture_quality"] = 3
        process = loss["processes"][0]
        process["status"] = 4
        process["events_lost"] = 1
        process["reader"]["stage"] = 5
        process["reader"]["outcome"] = 10
        process["reader"]["returned"] = True
        CAPTURE.validate_summary(loss)
        loss["capture_quality"] = 0
        with self.assertRaises(ValueError):
            CAPTURE.validate_summary(loss)

    def test_partial_binlog_scope_cannot_claim_observed_traces_or_full_quality(self):
        for status in (1, 3, 7, 8):
            CAPTURE.validate_binlog_only(CAPTURE.empty_summary(status))
        value = CAPTURE.empty_summary(1)
        value["capture_quality"] = 2
        CAPTURE.validate_summary(value)
        CAPTURE.validate_binlog_only(value)
        for field in ("rundown", "has_stacks"):
            altered = copy.deepcopy(value)
            altered["processes"][0][field] = True
            with self.assertRaises(ValueError):
                CAPTURE.validate_binlog_only(altered)
        altered = copy.deepcopy(value)
        altered["capture_quality"] = 1
        with self.assertRaises(ValueError):
            CAPTURE.validate_binlog_only(altered)

    def test_partial_scope_requires_capability_and_exit_not_writer_process_identity(self):
        path = RAW / ("partial-guards-" + uuid.uuid4().hex)
        path.mkdir(parents=True)
        pid = os.getpid()
        expected = path / "Expected.proj"
        expected.write_text("<Project />")
        for mode in ("no-exit", "live", "different-writer", "multiple", "trace-input", "no-host", "wrong-root", "symlink"):
            raw = path / mode
            raw.mkdir()
            directory = CAPTURE.initialize_session(raw, expected)
            writer = pid + 1 if mode == "different-writer" else pid
            candidate = directory / f"initial-20261114-000000--{writer}--Ab+_19.binlog"
            candidate.write_bytes(b"private-input")
            if mode == "multiple":
                (directory / f"initial-20261114-000001--{writer}--Cd+_19.binlog").write_bytes(b"private-input")
            launch = (
                f"Launched '/native/dotnet' with arguments 'build {expected} --no-restore {CAPTURE.binlog_option(raw)}': process id {pid}\n"
            )
            (raw / "watch.log").write_text(
                launch + ("" if mode == "no-exit" else f"Process id {pid} ran for 1ms and exited with exit code 1\n")
            )
            if mode == "trace-input":
                (raw / "unexpected.nettrace").write_bytes(b"private-input")
            if mode == "wrong-root":
                directory.rename(raw / "unowned-directory")
            if mode == "symlink":
                candidate.unlink()
                candidate.symlink_to(expected)
            with patch.object(CAPTURE.os, "kill", side_effect=AssertionError("not_an_ownership_rule")), \
                    patch.object(CAPTURE, "installed_native_host", return_value=None), \
                    patch.object(CAPTURE, "run_native_task") as task:
                CAPTURE.project(raw, raw / "publish", e2e_exit=1, build=False)
                task.assert_not_called()
            CAPTURE.validate_publication(raw / "publish")
            manifest = json.loads((raw / "publish/manifest.json").read_bytes())
            self.assertEqual(manifest["preflight"], {"trace-input": 6, "no-host": 2, "live": 2, "different-writer": 2}.get(mode, 1))
            self.assertEqual(manifest["capture_quality"], 0)
            self.assertEqual(manifest["e2e_exit"], 1)

    def test_partial_manifest_cannot_relabel_scope_or_publish_trace_input(self):
        path = RAW / ("partial-manifest-" + uuid.uuid4().hex)
        path.mkdir(parents=True)
        CAPTURE.project(path, path / "publish", e2e_exit=1, build=False)
        manifest = json.loads((path / "publish/manifest.json").read_bytes())
        for key, replacement in (
            ("observation_scope", "COMPLETE"), ("trace_inputs", "OBSERVED"),
            ("capture_quality", 1), ("initial_trace_sha256", "a" * 64),
            ("watcher_pid", 101), ("raw_message", SECRET.decode()),
            ("writer_check", 4),
        ):
            altered = copy.deepcopy(manifest)
            altered[key] = replacement
            with self.assertRaises(ValueError):
                CAPTURE.validate_manifest(altered)


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
</ItemGroup></Project>""".replace("</ItemGroup>", f"""
<Reference Include="Microsoft.Diagnostics.Tracing.TraceEvent" HintPath="{CAPTURE.HELPER.parent / 'Microsoft.Diagnostics.Tracing.TraceEvent.dll'}" />
<Reference Include="Microsoft.Diagnostics.FastSerialization" HintPath="{CAPTURE.HELPER.parent / 'Microsoft.Diagnostics.FastSerialization.dll'}" />
</ItemGroup>"""))
        run_private(
            ["dotnet", "build", str(CAPTURE.PROJECT), "-c", "Release", "--no-restore", "--nologo", "-v:q"],
            "projector-build.log",
        )
        run_private(
            ["dotnet", "build", str(cls.fixture / "Canary.csproj"), "-c", "Release", "--nologo", "-v:q"],
            "fixture-build.log",
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
        self.assertTrue(data["build_started"])
        self.assertTrue(data["build_finished_seen"])
        self.assertTrue(data["replay_returned"])
        self.assertGreater(data["projects_started"], 0)
        self.assertGreater(data["tasks_started"], 0)
        self.assertEqual(data["reader"]["outcome"], 1)
        self.assertTrue(data["reader"]["header_known"])
        self.assertEqual(data["reader"]["format_version"], 26)
        self.assertEqual(data["reader"]["input_bytes"], (self.child / "native.binlog").stat().st_size)
        self.assertEqual(self.summary["capture_quality"], 1)
        for reader in self.summary["readers"]:
            self.assertTrue(reader["known"])
            self.assertTrue(bool(CAPTURE.HEX.fullmatch(reader["sha256"])))
            self.assertNotEqual(reader["mvid"], "0" * 32)
        self.assertEqual(
            self.summary["readers"][0]["sha256"].lower(),
            CAPTURE.digest(CAPTURE.HELPER.parent / "Microsoft.Build.dll"),
        )

    def test_schema_rejects_leaks_unknown_keys_and_wrong_types(self):
        for mutation in ("field", "opaque", "bool", "count", "inference", "pdb", "hresult",
                         "hresult_range", "reader_message", "mvid", "reader_version", "reader_stage",
                         "reader_type", "false_complete"):
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
            elif mutation == "hresult_range":
                value["processes"][0]["events"][0]["hresult"] = 4294967296
            elif mutation == "reader_message":
                value["build"]["reader"]["exception"]["message"] = SECRET.decode()
            elif mutation == "mvid":
                value["readers"][0]["mvid"] = SECRET.decode()
            elif mutation == "reader_version":
                value["readers"][0]["file_version"][0] = SECRET.decode()
            elif mutation == "reader_stage":
                value["build"]["reader"]["stage"] = True
            elif mutation == "reader_type":
                value["build"]["reader"]["exception"]["type_identity"] = SECRET.decode()
            else:
                value["build"]["replay_returned"] = False
            with self.assertRaises(ValueError):
                CAPTURE.validate_summary(value)
        for code in (-2147483648, -1, 0, 2147483647, 4294967295):
            value = copy.deepcopy(self.summary)
            value["processes"][0]["events"][0]["hresult"] = code
            CAPTURE.validate_summary(value)

    def test_route_truth_table(self):
        sha = "a" * 40
        valid = ("workflow_dispatch", CAPTURE.BRANCH, sha, 1, True, sha, CAPTURE.SCOPE)
        self.assertEqual(CAPTURE.route(*valid), (False, True))
        for index, replacement in ((0, "schedule"), (1, "refs/heads/main"), (2, "b" * 40), (3, 2), (5, "invalid"), (6, "UNSPECIFIED")):
            args = list(valid)
            args[index] = replacement
            nightly, diagnostic = CAPTURE.route(*args)
            self.assertFalse(diagnostic)
            self.assertEqual(nightly, index == 0)
        self.assertEqual(CAPTURE.route("schedule", "refs/heads/main", sha, 1, False, "", "UNSPECIFIED"), (True, False))
        self.assertEqual(CAPTURE.route("workflow_dispatch", "refs/heads/main", sha, 1, False, "", "UNSPECIFIED"), (True, False))
        self.assertFalse(CAPTURE.route("workflow_dispatch", CAPTURE.BRANCH.upper(), sha, 1, True, sha, CAPTURE.SCOPE)[1])
        self.assertFalse(CAPTURE.route("workflow_dispatch", CAPTURE.BRANCH, sha, 1, True, sha.upper(), CAPTURE.SCOPE)[1])

    def test_native_missing_rundown_stacks_loss_and_partial(self):
        for mode, expected in (("no-rundown", 6), ("no-stacks", 5), ("loss", 4)):
            path, pid = self.native(mode, mode)
            value = self.project(path, pid, self.watcher, self.watcher_pid, mode)
            self.assertEqual(value["processes"][0]["status"], expected)
            if mode == "loss":
                self.assertGreater(value["processes"][0]["events_lost"], 0)
            self.assertFalse(value["absence_proven"])
            self.assertTrue(value["processes"][0]["reader"]["returned"])
        partial = self.run_root / "partial"
        partial.mkdir()
        shutil.copyfile(self.child / "native.binlog", partial / "native.binlog")
        trace = self.child / f"process-{self.child_pid}.nettrace"
        data = trace.read_bytes()
        (partial / trace.name).write_bytes(data[:len(data) // 2])
        value = self.project(partial, self.child_pid, self.watcher, self.watcher_pid, "partial")
        self.assertNotEqual(value["processes"][0]["status"], 0)
        self.assertIn(value["processes"][0]["reader"]["outcome"], (6, 8, 9))
        self.assertFalse(value["absence_proven"])

    def test_native_wildcard_preserves_exclusive_roots_and_separate_writer_pid(self):
        path = self.run_root / "unique"
        path.mkdir()
        project = path / "Build-success.proj"
        failed_project = path / "Build-failure.proj"
        project.write_text('<Project><Target Name="Build" /></Project>')
        failed_project.write_text('<Project><Target Name="Build"><MissingTask /></Target></Project>')
        input_hashes = (CAPTURE.digest(project), CAPTURE.digest(failed_project))
        directory = CAPTURE.initialize_session(path, project)
        option = CAPTURE.binlog_option(path)
        first_pid = run_private(["dotnet", "msbuild", str(project), "-nologo", option], "unique-first-build.log")
        first_files = list(directory.glob("initial-*.binlog"))
        self.assertEqual(len(first_files), 1)
        first_hash = CAPTURE.digest(first_files[0])
        other = self.run_root / "unique-other"
        other.mkdir()
        other_directory = CAPTURE.initialize_session(other, failed_project)
        run_private(["dotnet", "msbuild", str(failed_project), "-nologo", CAPTURE.binlog_option(other)], "unique-second-build.log", expected=1)
        self.assertEqual((CAPTURE.digest(project), CAPTURE.digest(failed_project)), input_hashes)
        self.assertEqual(len(list(directory.glob("initial-*.binlog"))), 1)
        self.assertEqual(len(list(other_directory.glob("initial-*.binlog"))), 1)
        self.assertEqual(CAPTURE.digest(first_files[0]), first_hash)
        self.assertTrue(bool(CAPTURE.native_binlog_pattern().fullmatch(first_files[0].name)))
        self.assertTrue(bool(CAPTURE.native_binlog_pattern().fullmatch(
            f"initial-20261114-000000--{first_pid}--Ab+_19.binlog"
        )))
        (path / "watch.log").write_text(
            f"Launched '/native/dotnet' with arguments 'build {project} --no-restore {option}': process id {first_pid}\n"
            f"Process id {first_pid} ran for 1ms and exited with exit code 0\n"
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
        for enabled in ("0", "1", "BINLOG_ONLY"):
            probe = self.run_root / ("argv-" + enabled)
            command = (
                'python3() { mkdir -p "$ROOT/out/artifacts/issue-5976-first-cause/capture/raw"; printf "%s\\n" "-bl:$ROOT/out/artifacts/issue-5976-first-cause/capture/raw/native-00000000000000000000000000000000/initial-{}.binlog;ProjectImports=None;OmitInitialInfo"; }\n'
                f'ROOT="{probe}"\n'
                'APP=samples/HotReload/App/App.gsproj\n'
                f'GSHARP_HOT_RELOAD_FIRST_CAUSE={enabled}\n'
                + fragment + '\nprintf "%s\\0" "${WATCH_COMMAND[@]}"'
            )
            result = subprocess.run(["bash", "-c", command], cwd=ROOT, capture_output=True, check=True)
            output = result.stdout
            if enabled == "BINLOG_ONLY":
                self.assertEqual(result.stdout, b"")
                output = (probe / "out/artifacts/issue-5976-first-cause/capture/raw/private-harness.log").read_bytes()
            arguments = output.decode().rstrip("\0").split("\0")
            if enabled != "BINLOG_ONLY":
                self.assertEqual(arguments, expected)
            else:
                self.assertEqual(arguments[:7], expected)
                self.assertEqual(arguments[-1], (
                    f"-bl:{probe}/out/artifacts/issue-5976-first-cause/capture/raw/"
                    "native-00000000000000000000000000000000/initial-{}.binlog;ProjectImports=None;OmitInitialInfo"
                ))
                self.assertFalse(any("EventPipe" in argument for argument in arguments))
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
            "inputs.observation_scope == 'BINLOG_ONLY' && "
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
            'writer.WriteString("snapshot_sha256", capture.SnapshotHash)',
            'writer.WriteString("type_identity", data.Fault.Identity)',
            'writer.WriteString("name_identity", data.NameIdentity)',
            'writer.WriteString("sha256", data.Hash)',
            'writer.WriteString("mvid", data.Mvid)',
            'writer.WriteString("identity", entry.Identity)',
            'writer.WriteString("identity", frame.Identity)',
            'writer.WriteString("module", frame.Module)',
            'writer.WriteString("pdb_guid", frame.PdbGuid)',
        ])
        self.assertNotIn("Console.", text)
        self.assertIn("Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))", text)
        self.assertNotIn(".Message", text)

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
        self.assertEqual(json.loads((publish / "manifest.json").read_bytes())["observation_scope"], "INITIAL_NATIVE_BINLOG_ONLY")
        self.assertEqual(json.loads((publish / "manifest.json").read_bytes())["trace_inputs"], "NOT_OBSERVED")
        self.assertTrue(json.loads((publish / "manifest.json").read_bytes())["schema_valid"])
        self.assertNotEqual(json.loads((publish / "manifest.json").read_bytes())["capture_quality"], 1)
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
        expected = root / "samples/HotReload/App/App.gsproj"
        expected.parent.mkdir(parents=True)
        expected.write_text("<Project />")
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

    def test_native_reader_outcomes_and_private_callback_fault(self):
        controls = self.run_root / "reader-controls"
        run_private(
            ["dotnet", str(self.dll), str(controls), "reader-controls", str(CAPTURE.HELPER)],
            "reader-controls.private.log",
        )
        reports = {}
        for name in ("success26", "no-finish26", "corrupt26", "projection-throw", "native-read-throw"):
            path = controls / (name + ".json")
            value = json.loads(path.read_bytes())
            CAPTURE.validate_reader_state(value)
            self.assertNotIn(SECRET, path.read_bytes())
            reports[name] = value
        self.assertEqual(reports["success26"]["outcome"], 1)
        self.assertEqual(reports["no-finish26"]["outcome"], 2)
        self.assertTrue(reports["no-finish26"]["returned"])
        self.assertFalse(reports["no-finish26"]["exception"]["present"])
        self.assertEqual(reports["corrupt26"]["stage"], 2)
        self.assertEqual(reports["corrupt26"]["outcome"], 3)
        self.assertEqual(reports["native-read-throw"]["stage"], 3)
        self.assertEqual(reports["native-read-throw"]["outcome"], 4)
        self.assertEqual(reports["projection-throw"]["stage"], 4)
        self.assertEqual(reports["projection-throw"]["outcome"], 5)
        expected = hashlib.sha256(b"System.InvalidOperationException").hexdigest().upper()
        self.assertEqual(reports["projection-throw"]["exception"]["type_identity"], expected)
        self.assertTrue(reports["projection-throw"]["exception"]["hresult_present"])
        for name in ("native-read-throw", "projection-throw"):
            self.assertTrue(reports[name]["header_known"])
            self.assertEqual(reports[name]["format_version"], 26)
        output = RAW / "no-finish-full-report.json"
        run_private(
            ["dotnet", str(CAPTURE.HELPER), str(controls / "no-finish26.binlog"),
             str(controls / "missing"), str(controls / "missing"), "0", "0", str(output)],
            "no-finish-full-report.private.log",
        )
        value = json.loads(output.read_bytes())
        CAPTURE.validate_summary(value)
        self.assertTrue(value["build"]["replay_returned"])
        self.assertFalse(value["build"]["build_finished_seen"])
        self.assertEqual(value["build"]["reader"]["outcome"], 2)
        self.assertEqual(value["capture_quality"], 2)

    def test_native_early_failure_retains_errors_without_project_started(self):
        raw = self.run_root / "native-early-failure"
        raw.mkdir()
        expected = self.fixture / "Canary.csproj"
        directory = CAPTURE.initialize_session(raw, expected)
        client = run_private(
            ["dotnet", str(self.dll), str(raw), "early-failure", CAPTURE.binlog_option(raw)[4:],
             str(CAPTURE.HELPER), str(expected), str(directory)],
            "native-early-failure.private.log",
        )
        (raw / "native-client-pid.txt").write_text(str(client))
        value = json.loads((raw / "early-summary.json").read_bytes())
        proof = json.loads((raw / "early-ownership.json").read_bytes())
        CAPTURE.validate_summary(value)
        CAPTURE.validate_binlog_only(value)
        self.assertTrue(value["build"]["build_started"])
        self.assertTrue(value["build"]["build_finished_seen"])
        self.assertTrue(value["build"]["replay_returned"])
        self.assertEqual(value["build"]["succeeded"], 0)
        self.assertEqual(value["build"]["projects_started"], 0)
        self.assertEqual(value["build"]["errors"], 1)
        self.assertEqual([e["kind"] for e in value["build"]["events"]], [4])
        self.assertEqual(value["capture_quality"], 2)
        self.assertTrue(proof["snapshot_created"])
        self.assertEqual(proof["root_projects"], 0)
        self.assertEqual(proof["project_binding"], 0)
        self.assertFalse(proof["project_bound"])
        self.assertNotIn(SECRET, (raw / "early-summary.json").read_bytes())

    def test_native_trace_stage_controls(self):
        controls = self.run_root / "trace-controls"
        source = self.child / f"process-{self.child_pid}.nettrace"
        before = CAPTURE.digest(source)
        run_private(
            ["dotnet", str(self.dll), str(controls), "trace-controls", str(CAPTURE.HELPER),
             str(source), str(self.child_pid)],
            "trace-controls.private.log",
        )
        self.assertEqual(CAPTURE.digest(source), before)
        for name, stage, outcome in (
            ("trace-open", 7, 7), ("trace-iteration", 8, 8),
            ("trace-projection", 9, 5), ("trace-truncated", 5, 9),
        ):
            path = controls / (name + ".json")
            value = json.loads(path.read_bytes())
            state = value["reader"] if "reader" in value else value
            CAPTURE.validate_reader_state(state)
            self.assertEqual(state["stage"], stage)
            self.assertEqual(state["outcome"], outcome)
            self.assertNotIn(SECRET, path.read_bytes())
            if name == "trace-truncated":
                self.assertTrue(state["limit_reached"])
                self.assertGreaterEqual(state["events_seen"], state["event_limit"])


if __name__ == "__main__":
    unittest.main()
