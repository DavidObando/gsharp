#!/usr/bin/env python3
"""Metadata-only privacy and outcome contracts for the scoped #5393 diagnostic."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
CANARY = "PRIVATE_THEORY_OUTPUT_CANARY"
TEST_ID = "11111111-1111-1111-1111-111111111111"
EXECUTION_ID = "22222222-2222-2222-2222-222222222222"
# Counter attributes match VSTest 17.11.1 TestRunSummary (58dbd027217ac035a4e9114c9213b11dc0e988bd).
TRX = f"""<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
<TestDefinitions><UnitTest id="{TEST_ID}"><TestMethod
 className="GSharp.Core.Tests.Demo" name="Run" /></UnitTest></TestDefinitions>
<Results><UnitTestResult testId="{TEST_ID}" executionId="{EXECUTION_ID}"
 outcome="Passed" testName="{CANARY}"><Output><StdOut>{CANARY}</StdOut></Output>
</UnitTestResult></Results>
<ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1"
 failed="0" error="0" timeout="0" aborted="0" inconclusive="0"
 passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0"
 warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary>
<ResultFiles><ResultFile path="{CANARY}"/></ResultFiles></TestRun>"""


def load_helper():
    path = Path(os.environ.get(
        "GSHARP_5393_METADATA_HELPER", ROOT / "build/core-crash-diagnostics.py"))
    spec = importlib.util.spec_from_file_location("core_crash_diagnostics", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkflowTests(unittest.TestCase):
    def workflow(self):
        return Path(os.environ.get(
            "GSHARP_5393_METADATA_WORKFLOW", ROOT / ".github/workflows/build.yml")).read_text()

    def test_raw_upload_is_excluded_independently_of_test_success(self):
        workflow = self.workflow()
        upload = workflow.split("      - name: Upload test results\n", 1)[1]
        self.assertIn("env.GSHARP_5393_PRIVATE_ROUTE != 'true'", upload.split("\n\n", 1)[0])
        self.assertIn("      - name: Upload sanitized core diagnostics\n", workflow)
        sanitized = workflow.split("      - name: Upload sanitized core diagnostics\n", 1)[1]
        self.assertIn("steps.diagnostic5393.outcome == 'success'", sanitized.split("\n\n", 1)[0])
        for name in ("summary.json", "provenance.json", "test-sequence.json"):
            self.assertIn("TestResults/5393/" + name, sanitized.split("\n\n", 1)[0])
        self.assertNotIn("*", sanitized.split("\n\n", 1)[0])

    def test_route_requires_an_explicit_head_and_keeps_fixture_behavior(self):
        workflow = self.workflow()
        eligibility = workflow.split("      GSHARP_5393_DIAGNOSTIC: >-\n", 1)[1]
        eligibility = eligibility.split("\n\n", 1)[0]
        for predicate in ("vars.GSHARP_5393_INITIAL_HEAD",
                          "github.event.pull_request.head.sha", "github.run_attempt == 1",
                          "github.event.action == 'synchronize'", "github.event.number == 5432"):
            self.assertIn(predicate, eligibility)
        self.assertNotIn("'opened'", eligibility)
        self.assertNotIn("'reopened'", eligibility)
        self.assertNotIn("      - name: Require the separately approved diagnostic head\n", workflow)
        diagnostic = workflow.split("      - name: Test with dump-free sequence\n", 1)[1]
        diagnostic = diagnostic.split("      - name: Normalize core diagnostics\n", 1)[0]
        for forbidden in ("ulimit -f", "RLIMIT_FSIZE", "TMPDIR", "DOTNET_CLI_HOME",
                          "--blame-crash", "--blame-hang", "--diag", "umask"):
            self.assertNotIn(forbidden, diagnostic)
        self.assertIn("--blame", diagnostic)
        self.assertIn('exit "$status"', diagnostic)
        self.assertIn("--blame-hang --blame-hang-timeout 2m --blame-hang-dump-type mini",
                      workflow)

    def test_unarmed_route_runs_tests_without_collecting_or_publishing(self):
        workflow = self.workflow()
        ordinary = workflow.split("      - name: Test core without diagnostic collection\n", 1)[1]
        ordinary = ordinary.split("      - name: Test with dump-free sequence\n", 1)[0]
        self.assertIn("env.GSHARP_5393_PRIVATE_ROUTE == 'true' && "
                      "env.GSHARP_5393_DIAGNOSTIC != 'true'", ordinary)
        self.assertIn("ulimit -c 0", ordinary)
        self.assertIn("DOTNET_DbgEnableMiniDump: 0", ordinary)
        self.assertIn("COMPlus_DbgEnableMiniDump: 0", ordinary)
        self.assertIn("python3 build/core-crash-diagnostics.py test", ordinary)
        self.assertIn("if: always() && env.GSHARP_5393_PRIVATE_ROUTE == 'true' && "
                      "env.GSHARP_5393_DIAGNOSTIC != 'true'", ordinary)
        self.assertIn("python3 build/core-crash-diagnostics.py cleanup", ordinary)
        for forbidden in ("--blame", "--logger", " prepare", " finish", "upload-artifact",
                          "GSHARP_5393_INITIAL_HEAD", "ulimit -f", "umask"):
            self.assertNotIn(forbidden, ordinary)

    def test_unarmed_route_inherits_the_normal_job_budget(self):
        workflow = self.workflow()
        job = workflow.split("\n  tests:\n", 1)[1].split("    steps:\n", 1)[0]
        self.assertRegex(job, r"(?m)^    timeout-minutes: [1-9][0-9]*$")
        normal = workflow.split("      - name: Test\n", 1)[1]
        normal = normal.split("      - name: Test core without diagnostic collection\n", 1)[0]
        ordinary = workflow.split("      - name: Test core without diagnostic collection\n", 1)[1]
        ordinary = ordinary.split("      - name: Remove private core validation output\n", 1)[0]
        for step in (normal, ordinary):
            self.assertNotIn("timeout-minutes:", step)
        diagnostic = workflow.split("      - name: Test with dump-free sequence\n", 1)[1]
        diagnostic = diagnostic.split("      - name: Normalize core diagnostics\n", 1)[0]
        self.assertIn("timeout-minutes: 16", diagnostic)
        self.assertIn("timeout --signal=TERM --kill-after=10s 900s", diagnostic)


class OrdinaryValidationTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        work = ROOT / "out/5393-r2/implementation/metadata-work"
        work.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        environment = patch.dict(os.environ, {
            "TEST_PROJECTS": "test/Core.Tests/Core.Tests.gsproj",
            "TEST_FILTER": self.helper.FILTER,
            "CS2GS_TEST_SOURCE_ROOT": CANARY,
            "DOTNET_DbgEnableMiniDump": "1", "COMPlus_DbgEnableMiniDump": "1"})
        environment.start()
        self.addCleanup(environment.stop)

    def test_full_workload_preserves_failure_status_and_cleans_private_output(self):
        for exit_code in (0, 23, 124, 137, -9):
            with self.subTest(exit_code=exit_code):
                def run(command, **kwargs):
                    self.assertEqual(command, [
                        "dotnet", "test", "test/Core.Tests/Core.Tests.gsproj",
                        "--configuration", "Release", "--no-build", "--no-restore",
                        "--filter", self.helper.FILTER])
                    self.assertNotIn("timeout", kwargs)
                    self.assertEqual(kwargs["cwd"], self.root)
                    for name in ("DOTNET_DbgEnableMiniDump", "COMPlus_DbgEnableMiniDump"):
                        self.assertEqual(kwargs["env"][name], "0")
                    self.assertNotIn("CS2GS_TEST_SOURCE_ROOT", kwargs["env"])
                    for stream in (kwargs["stdout"], kwargs["stderr"]):
                        self.assertEqual(stat.S_IMODE(os.fstat(stream.fileno()).st_mode), 0o600)
                        stream.write(CANARY.encode())
                    self.assertEqual(stat.S_IMODE(
                        (self.root / self.helper.PRIVATE).stat().st_mode), 0o700)
                    return subprocess.CompletedProcess(command, exit_code)

                output = io.StringIO()
                with patch.object(self.helper.subprocess, "run", side_effect=run) as runner:
                    with redirect_stdout(output):
                        status = self.helper.test_without_collection(self.root)
                runner.assert_called_once()
                self.assertEqual(status, exit_code if exit_code >= 0 else 128 - exit_code)
                self.assertNotIn(CANARY, output.getvalue())
                self.assertFalse((self.root / self.helper.PRIVATE).exists())
                self.assertFalse((self.root / self.helper.PUBLIC).exists())

    def test_cli_preserves_exit_without_raw_output_or_artifacts(self):
        program = self.root / "build/core-crash-diagnostics.py"
        program.parent.mkdir()
        program.write_bytes(Path(self.helper.__file__).read_bytes())
        tools = self.root / "tools"
        tools.mkdir()
        dotnet = tools / "dotnet"
        dotnet.write_text(f"#!{sys.executable}\nimport os, sys\n"
                          "if os.umask(0o022) != 0o022: sys.exit(24)\n"
                          f"print({CANARY!r})\nprint({CANARY!r}, file=sys.stderr)\n"
                          "sys.exit(23)\n")
        dotnet.chmod(0o755)
        timeout = tools / "timeout"
        timeout.write_text(f"#!{sys.executable}\nimport sys\nsys.exit(24)\n")
        timeout.chmod(0o755)
        result = subprocess.run(
            [sys.executable, "-B", str(program), "test"], cwd=self.root,
            env={**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]},
            capture_output=True, text=True, umask=0o022)
        self.assertEqual(result.returncode, 23)
        self.assertIn("Core validation wrapper exit: 23", result.stdout)
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        self.assertFalse((self.root / self.helper.PRIVATE).exists())
        self.assertFalse((self.root / self.helper.PUBLIC).exists())

    def test_cleanup_cli_removes_interrupted_private_output(self):
        program = self.root / "build/core-crash-diagnostics.py"
        program.parent.mkdir()
        program.write_bytes(Path(self.helper.__file__).read_bytes())
        private = self.root / self.helper.PRIVATE
        private.mkdir(parents=True, mode=0o700)
        (private / ".owner").write_bytes(self.helper.OWNER)
        (private / "test.stdout").write_text(CANARY)
        result = subprocess.run(
            [sys.executable, "-B", str(program), "cleanup"], cwd=self.root,
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        self.assertFalse(private.exists())
        self.assertFalse((self.root / self.helper.PUBLIC).exists())

    def test_wrong_workload_is_rejected_before_launch(self):
        for changed in ({"TEST_PROJECTS": "test/Compiler.Tests/Compiler.Tests.gsproj"},
                        {"TEST_FILTER": "FullyQualifiedName~OneTest"}):
            with self.subTest(changed=changed), patch.dict(os.environ, changed):
                with patch.object(self.helper.subprocess, "run") as runner:
                    with self.assertRaisesRegex(self.helper.DiagnosticError, "^test-shape$"):
                        self.helper.test_without_collection(self.root)
                runner.assert_not_called()
                self.assertFalse((self.root / self.helper.PRIVATE).exists())

    def test_cleanup_failure_cannot_report_success(self):
        with patch.object(self.helper.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 0)):
            with patch.object(self.helper, "cleanup", side_effect=OSError(CANARY)):
                with redirect_stdout(io.StringIO()):
                    with self.assertRaises(OSError):
                        self.helper.test_without_collection(self.root)
        self.assertFalse((self.root / self.helper.PUBLIC).exists())


class NormalizerTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        work = ROOT / "out/5393-r2/implementation/metadata-work"
        work.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.metadata = {"schema_version": 1, "actual_loaded_modules": None}
        mocked = patch.object(self.helper, "provenance", return_value=self.metadata)
        mocked.start()
        self.addCleanup(mocked.stop)
        self.helper.prepare(self.root)
        self.private = self.root / "out/5393-ci/private"
        (self.private / "test.stdout").write_text(CANARY)
        (self.private / "test.stderr").write_text(CANARY)
        (self.private / "results/core-remainder.trx").write_text(TRX)

    def read(self, name):
        return json.loads((self.root / "TestResults/5393" / name).read_text())

    def sequence(self):
        source = ROOT / "build/test-data/core-crash-sequence-17.11.1.xml"
        shutil.copyfile(source, self.private / "results/Sequence_fixture.xml")

    def assert_not_published(self):
        self.assertFalse((self.root / "TestResults/5393").exists())

    def test_healthy_nonempty_trx_without_sequence_is_nonreproduction(self):
        self.helper.finish(self.root, 0)
        summary = self.read("summary.json")
        self.assertEqual(summary["classification"], "bounded-nonreproduction")
        self.assertEqual(summary["wrapper_exit"], 0)
        self.assertEqual(summary["counters"]["inProgress"], 0)
        self.assertFalse(summary["sequence_present"])
        self.assertIsNone(self.read("test-sequence.json")["sequences"])
        self.assertFalse(self.private.exists())

    def test_only_the_owned_result_directory_and_logs_have_private_modes(self):
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.private / "results").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.private / "test.stdout").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.private / "test.stderr").stat().st_mode), 0o600)

    def test_pinned_sequence_preserves_repetition_order_and_drops_private_data(self):
        self.sequence()
        self.helper.finish(self.root, 1)
        sequence = self.read("test-sequence.json")["sequences"][0]["occurrences"]
        self.assertEqual([row["method"] for row in sequence],
                         ["GSharp.Core.Tests.Demo.Run", "GSharp.Core.Tests.Demo.Other",
                          "GSharp.Core.Tests.Demo.Run"])
        self.assertEqual([row["completed"] for row in sequence], [True, True, False])
        self.assertTrue(all(row["test_id"] is None and row["execution_id"] is None
                            for row in sequence))
        results = self.read("test-sequence.json")["results"]
        self.assertEqual(results[0]["test_id"], TEST_ID)
        self.assertEqual(results[0]["execution_id"], EXECUTION_ID)
        self.assertEqual(results[0]["method"], "GSharp.Core.Tests.Demo.Run")
        published = self.root / "TestResults/5393"
        self.assertEqual({p.name for p in published.iterdir()},
                         {"summary.json", "provenance.json", "test-sequence.json"})
        self.assertNotIn(CANARY, "".join(p.read_text() for p in published.iterdir()))
        self.assertNotIn("/fixture", "".join(p.read_text() for p in published.iterdir()))
        self.assertFalse(self.private.exists())

    def test_abort_without_sequence_records_an_attribution_gap(self):
        (self.private / "test.stderr").write_text("Test Run Aborted.")
        self.helper.finish(self.root, 1)
        summary = self.read("summary.json")
        self.assertEqual(summary["classification"], "process-failure")
        self.assertEqual(summary["attribution"], "gap")
        self.assertEqual(summary["diagnostic_state"], "incomplete")
        self.assertIsNone(self.read("test-sequence.json")["sequences"])
        self.assertFalse(summary["original_issue_fixed"])

    def test_timeout_does_not_invent_a_child_exit_or_green(self):
        self.helper.finish(self.root, 124)
        summary = self.read("summary.json")
        self.assertEqual(summary["classification"], "timeout-status")
        self.assertEqual(summary["wrapper_exit"], 124)
        self.assertIsNone(summary["actual_dotnet_test_exit"])
        self.assertIsNone(summary["actual_testhost_exit"])

    def test_missing_trx_on_nonzero_exit_is_explicitly_incomplete(self):
        (self.private / "results/core-remainder.trx").unlink()
        self.helper.finish(self.root, 1)
        summary = self.read("summary.json")
        self.assertIsNone(summary["counters"])
        self.assertEqual(summary["diagnostic_state"], "incomplete")
        self.assertIsNone(self.read("test-sequence.json")["results"])

    def test_missing_step_status_cleans_private_data_without_publication(self):
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, None)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_zero_tests_cannot_be_a_successful_nonreproduction(self):
        empty = ET.fromstring(TRX)
        empty.find(self.helper.NS + "ResultSummary/" + self.helper.NS + "Counters").attrib.update(
            {"total": "0", "executed": "0", "passed": "0", "failed": "0"})
        empty.find(self.helper.NS + "Results").clear()
        (self.private / "results/core-remainder.trx").write_bytes(ET.tostring(empty))
        with self.assertRaisesRegex(self.helper.DiagnosticError, "^invalid-successful-trx$"):
            self.helper.finish(self.root, 0)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_unknown_sequence_attributes_are_not_copied(self):
        self.sequence()
        path = self.private / "results/Sequence_fixture.xml"
        path.write_text(path.read_text().replace('Completed="False"',
                                                f'Completed="False" Secret="{CANARY}"'))
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, 1)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_names_with_arguments_are_explicitly_unknown_not_published(self):
        self.sequence()
        path = self.private / "results/Sequence_fixture.xml"
        path.write_text(path.read_text().replace(
            'Name="GSharp.Core.Tests.Demo.Other"',
            f'Name="GSharp.Core.Tests.Demo.Other({CANARY})"'))
        self.helper.finish(self.root, 1)
        document = self.read("test-sequence.json")
        self.assertIsNone(document["sequences"][0]["occurrences"][1]["method"])
        self.assertNotIn(CANARY, json.dumps(document))

    def test_entities_and_oversized_xml_fail_closed(self):
        path = self.private / "results/core-remainder.trx"
        path.write_text('<!DOCTYPE TestRun [<!ENTITY x "private">]>' + TRX)
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, 1)
        self.assert_not_published()
        self.assertFalse(self.private.exists())

    def test_external_attachment_is_rejected_without_reading_it(self):
        (self.private / "results/unexpected.dmp").write_text(CANARY)
        original_read = self.helper.read
        read_names = []

        def guarded_read(path, *args):
            read_names.append(path.name)
            return original_read(path, *args)

        with patch.object(self.helper, "read", side_effect=guarded_read):
            with self.assertRaises(self.helper.DiagnosticError):
                self.helper.finish(self.root, 1)
        self.assertNotIn("unexpected.dmp", read_names)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_parser_input_bound_is_not_a_product_file_limit(self):
        with patch.object(self.helper, "MAX_INPUT", 32):
            with self.assertRaises(self.helper.DiagnosticError):
                self.helper.finish(self.root, 1)
        self.assert_not_published()

    def test_total_input_bound_is_enforced_across_files(self):
        with patch.object(self.helper, "MAX_TOTAL_INPUT", len(TRX.encode()) + 8):
            with self.assertRaises(self.helper.DiagnosticError):
                self.helper.finish(self.root, 1)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_symlink_is_rejected_without_touching_its_target(self):
        outside = self.root / "outside.xml"
        outside.write_text(CANARY)
        (self.private / "results/Sequence_link.xml").symlink_to(outside)
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, 1)
        self.assertEqual(outside.read_text(), CANARY)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_cleanup_failure_prevents_publication(self):
        with patch.object(self.helper.shutil, "rmtree", side_effect=OSError(CANARY)):
            with self.assertRaises(self.helper.DiagnosticError):
                self.helper.finish(self.root, 0)
        self.assert_not_published()

    def test_unowned_private_directory_is_not_deleted(self):
        (self.private / ".owner").unlink()
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, 1)
        self.assertTrue(self.private.exists())
        self.assertEqual((self.private / "test.stdout").read_text(), CANARY)
        self.assert_not_published()

    def test_public_artifact_bound_prevents_partial_publication(self):
        with patch.dict(self.helper.OUTPUT_LIMITS, {"test-sequence.json": 16}):
            with self.assertRaises(self.helper.DiagnosticError):
                self.helper.finish(self.root, 0)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_private_provenance_tampering_is_not_passthrough(self):
        path = self.private / "provenance.json"
        path.write_text(json.dumps({**self.metadata, "environment": CANARY}))
        with self.assertRaises(self.helper.DiagnosticError):
            self.helper.finish(self.root, 0)
        self.assertFalse(self.private.exists())
        self.assert_not_published()

    def test_authorization_is_specific_to_one_approved_head(self):
        head = "1" * 40
        environment = {
            "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": "DavidObando/gsharp",
            "GITHUB_HEAD_REF": "fix/p0-5393-b12435c5-r2", "GITHUB_RUN_ATTEMPT": "1",
            "GSHARP_5393_INITIAL_HEAD": head,
        }
        event = {"action": "synchronize", "number": 5432, "pull_request": {"head": {
            "sha": head, "repo": {"full_name": "DavidObando/gsharp"}}}}
        self.helper.authorize(environment, event)
        for changed in ({"GSHARP_5393_INITIAL_HEAD": ""},
                        {"GSHARP_5393_INITIAL_HEAD": "2" * 40},
                        {"GITHUB_RUN_ATTEMPT": "2"}):
            with self.subTest(changed=changed):
                with self.assertRaises(self.helper.DiagnosticError):
                    self.helper.authorize({**environment, **changed}, event)
        for action in ("opened", "reopened"):
            with self.subTest(action=action):
                with self.assertRaisesRegex(self.helper.DiagnosticError, "^not-authorized$"):
                    self.helper.authorize(environment, {**event, "action": action})
        for number in (5433, None):
            changed_event = {**event, "number": number}
            if number is None:
                del changed_event["number"]
            with self.subTest(number=number):
                with self.assertRaisesRegex(self.helper.DiagnosticError, "^not-authorized$"):
                    self.helper.authorize(environment, changed_event)


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        work = ROOT / "out/5393-r2/implementation/metadata-work"
        work.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.package = self.root / "packages/gsharp.net.sdk/0.5.212"
        self.compiler = self.file(self.package / "tools/compiler/gsc.dll")
        self.task = self.file(self.package / "tools/task/Gsharp.NET.Sdk.dll")
        (self.package / "build").mkdir()
        self.first = self.file(self.root / "framework/First.dll")
        self.second = self.file(self.root / "framework/Second.dll")
        self.stamp = self.root / "out/obj/Core.Tests/Release/repository-build-tools.cache"
        hashes = [str(path) + "|" + hashlib.sha256(path.read_bytes()).hexdigest().upper()
                  for path in (self.compiler, self.task)]
        compiler_property = str(self.package / "build") + r"/..\tools\compiler\gsc.dll"
        records = [f"COMPILER:{compiler_property}", f"TASK:{self.task}", *hashes,
                   f"SOURCE:{CANARY}", *(f"REFERENCE:{path}" for path in
                                        (self.first, self.second, self.first))]
        self.stamp.parent.mkdir(parents=True)
        self.stamp.write_text("\n".join(records))
        for name in ("GSharp.Core.Tests.dll", "GSharp.Core.dll",
                     "Gsharp.Runtime.Channels.dll", "Gsharp.Runtime.Values.dll",
                     "GSharp.Core.Tests.deps.json", "GSharp.Core.Tests.runtimeconfig.json"):
            self.file(self.root / "out/bin/Release/Core.Tests" / name)
        dotnet = self.file(self.root / "framework/dotnet")
        mocked_command = patch.object(self.helper.shutil, "which", return_value=str(dotnet))
        mocked_command.start()
        self.addCleanup(mocked_command.stop)
        (self.root / ".github/workflows").mkdir(parents=True)
        (self.root / ".github/workflows/build.yml").write_text("benign metadata fixture")
        (self.root / "global.json").write_text(json.dumps({
            "sdk": {"version": "10.0.300", "rollForward": "latestFeature"},
            "msbuild-sdks": {"Gsharp.NET.Sdk": "0.5.212"}}))
        head = "1" * 40
        event = self.root / "event.json"
        event.write_text(json.dumps({"action": "synchronize", "number": 5432, "pull_request": {
            "head": {"sha": head, "repo": {"full_name": "DavidObando/gsharp"}},
            "base": {"sha": "2" * 40}}}))
        environment = {
            "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": "DavidObando/gsharp",
            "GITHUB_HEAD_REF": "fix/p0-5393-b12435c5-r2", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_RUN_ID": "123", "GSHARP_5393_INITIAL_HEAD": head,
            "GITHUB_EVENT_PATH": str(event), "NUGET_PACKAGES": str(self.root / "packages"),
            "DOTNET_ROOT": str(self.root / "framework"),
            "TEST_PROJECTS": "test/Core.Tests/Core.Tests.gsproj",
            "TEST_FILTER": self.helper.FILTER}
        mocked_environment = patch.dict(os.environ, environment)
        mocked_environment.start()
        self.addCleanup(mocked_environment.stop)

        def git(command, **kwargs):
            self.assertEqual(command[0], "git")
            output = (("3" * 40 + "\n" + "4" * 40 + "\n" + "5" * 40 + "\n").encode()
                      if "show" in command else b"")
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr=b"")

        mocked_git = patch.object(self.helper.subprocess, "run", side_effect=git)
        mocked_git.start()
        self.addCleanup(mocked_git.stop)

    def file(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"Benign metadata placeholder; not a PE or executable.")
        return path

    def test_existing_build_stamp_preserves_all_declared_reference_occurrences(self):
        metadata = self.helper.provenance(self.root)
        self.assertEqual([row["name"] for row in metadata["reference_images"]],
                         ["First.dll", "Second.dll", "First.dll"])
        self.assertEqual(metadata["checkout_sha"], "3" * 40)
        self.assertEqual(metadata["pull_request_head"], "1" * 40)
        self.assertIsNone(metadata["response_file_sha256"])
        self.assertIsNone(metadata["actual_testhost_runtime"])
        self.assertNotIn(CANARY, json.dumps(metadata))
        self.assertNotIn(str(self.root), json.dumps(metadata))

    def test_stamp_hash_mismatch_stops_prepare_before_private_test_output(self):
        self.compiler.write_bytes(b"Changed benign metadata.")
        with self.assertRaisesRegex(self.helper.DiagnosticError, "tool-input-changed"):
            self.helper.prepare(self.root)
        self.assertFalse((self.root / self.helper.PRIVATE).exists())


if __name__ == "__main__":
    unittest.main()
