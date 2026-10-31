#!/usr/bin/env python3
"""CI routing, graph, matrix, and fail-closed aggregate contracts (#5006)."""

import copy
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "build" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ci = load("ci-selection")
matrix = load("generate-ci-test-matrix")
partition = load("verify-ci-test-partition")
graphs = load("ci-projects")
rules = load("migrate-ci-rules")


def selection(*paths, event="pull_request", **kwargs):
    return ci.select(list(paths), event, go_exists=True, **kwargs)


def job(text, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"missing job {name}")
    return match.group(0)


class SelectionTests(unittest.TestCase):
    def test_shared_lexical_cases_select_both_editor_and_website_consumers(self):
        plan = selection("src/vscode-gsharp/src/test/grammar-cases.json")
        self.assertFalse(plan["full"])
        self.assertIn("vscode-extension", plan["jobs"])
        self.assertIn("visual-studio-extension", plan["jobs"])
        self.assertEqual(plan["docs_jobs"], ["build", "visual"])

    def test_prose_and_website_do_not_select_product_jobs(self):
        for path in ("README.md", "docs/guide.md", "tools/cs2gs/README.md", "website/docs/intro.md",
                     "website/src/pages/index.tsx", "website/package.json"):
            with self.subTest(path=path):
                plan = selection(path)
                self.assertEqual(plan["jobs"], ["release-version-refs"])
                self.assertEqual(plan["projects"], "")
                self.assertEqual(plan["docs_jobs"], ["build", "visual"])

    def test_go_and_docs_union_without_dotnet_builds(self):
        go = selection("tools/go2gs/analyze.go")
        self.assertEqual(set(go["jobs"]), ci.GO_JOBS | {"release-version-refs"})
        self.assertEqual(go["docs_jobs"], [])
        mixed = selection("tools/go2gs/go.mod", "docs/go.md")
        self.assertEqual(mixed["jobs"], go["jobs"])
        self.assertEqual(mixed["docs_jobs"], ["build", "visual"])

    def test_documentation_consumed_by_product_contracts_keeps_its_suite(self):
        for path, consumer in ci.CONTRACT_INPUTS.items():
            plan = selection(path)
            self.assertIn(ci.SUITES[consumer], plan["projects"].split())
            self.assertIn("tests", plan["jobs"])
            self.assertEqual(plan["docs_jobs"], ["build", "visual"])
        # Do not let deletion of the exception table make this test vacuous.
        self.assertIn(ci.CS2GS, selection("docs/cs2gs-coverage-matrix.md")["projects"].split())
        self.assertIn(ci.SUITES["interpreter"],
                      selection("website/docs/tooling/repl.md")["projects"].split())

    def test_component_project_files_and_fixture_prose_are_not_shared_config(self):
        for path in ("tools/cs2gs/Cs2Gs.Tests/Fixtures/README.md",
                     "tools/cs2gs/corpus/L1/notes.md",
                     "tools/cs2gs/Cs2Gs.Translator/Cs2Gs.Translator.gsproj"):
            with self.subTest(path=path):
                plan = selection(path)
                self.assertFalse(plan["full"])
                self.assertEqual(set(plan["projects"].split()), {ci.CS2GS, ci.GENERATOR})
                self.assertIn("cs2gs-corpus", plan["jobs"])
                self.assertNotIn("build", plan["jobs"])
                self.assertNotIn("visual-studio-extension", plan["jobs"])

    def test_compiler_and_shared_inputs_cover_consumers(self):
        all_tests = set(ci.test_projects(ci.solution_projects()))
        for path in ("src/Core/Binder.gs", "src/Compiler/Program.gs",
                     "test/Shared/Oracle.gs", "test-assets/fixture/README.md",
                     "test/Core.Tests/CSharpFixture.gs"):
            with self.subTest(path=path):
                plan = selection(path)
                self.assertEqual(set(plan["projects"].split()), all_tests)
                self.assertTrue(ci.BUILD_JOBS.issubset(plan["jobs"]))
        for path in ("global.json", "Directory.Build.props", "new/unknown.input",
                     ".github/workflows/build.yml", "build/ci-selection.py", "GSharp.slnx"):
            self.assertTrue(selection(path)["full"], path)

    def test_owning_suites_and_downstream_consumers(self):
        for path, suites, jobs in (
            ("src/Formatting/Gsfmt.Cli/Program.gs", ["formatting", "language-server", "compiler", "cs2gs"],
             ["format", "cs2gs-corpus", "visual-studio-extension", "vsix"]),
            ("src/LanguageServer/Server.gs", ["language-server", "interpreter", "compiler"],
             ["vscode-extension", "vsix", "visual-studio-extension"]),
            ("src/Repl/Program.gs", ["interpreter", "compiler"], ["tests"]),
            ("src/Sdk/Gsharp.NET.Sdk/BuildTask.gs", ["sdk", "core", "compiler", "cs2gs"],
             ["build", "e2e", "desktop-msbuild-sdk-smoke", "vscode-extension"]),
            ("tools/gsgen/Gsgen.Cli/Program.gs", ["generators", "compiler", "cs2gs"],
             ["build", "e2e"]),
            ("samples/Trail/README.md", ["compiler", "formatting", "language-server"],
             ["e2e", "ilverify"]),
            ("src/vscode-gsharp/themes/light.json", [],
             ["vscode-extension", "vsix", "visual-studio-extension"]),
            ("src/vscode-gsharp/src/extension.ts", [], ["visual-studio-extension"]),
            ("src/vs-gsharp/src/VsGsharp/Package.cs", [], ["visual-studio-extension"]),
        ):
            with self.subTest(path=path):
                plan = selection(path)
                self.assertTrue({ci.SUITES[s] for s in suites}.issubset(plan["projects"].split()))
                self.assertTrue(set(jobs).issubset(plan["jobs"]))
                if "build" in jobs:
                    self.assertIn(ci.SDK, plan["build_projects"].split())
                if path.startswith("samples/"):
                    self.assertEqual(plan["docs_jobs"], ["build", "visual"])

    def test_harnesses_are_independent_of_test_partition(self):
        for name, paths in ci.HARNESS.items():
            for path in paths:
                plan = selection(path)
                self.assertEqual(plan["harness_matrix"], {"name": [name]})
                self.assertIn("harness", plan["jobs"])
                self.assertNotIn("test-partition", plan["jobs"])

    def test_official_events_always_select_full_validation(self):
        for event in ("push", "schedule", "workflow_dispatch"):
            plan = selection("README.md", event=event)
            self.assertTrue(plan["full"])
            self.assertEqual(set(plan["jobs"]), ci.BUILD_JOBS | ci.GO_JOBS)
            self.assertEqual(set(plan["projects"].split()), set(ci.test_projects(ci.solution_projects())))
            self.assertEqual(set(plan["harness_matrix"]["name"]), set(ci.HARNESS))
            self.assertEqual(plan["docs_jobs"], ["build", "visual"])

    def test_new_test_project_cannot_be_silently_omitted(self):
        projects = ci.solution_projects() + ["test/New.Tests/New.Tests.gsproj"]
        plan = selection("docs/readme.md", projects=projects)
        self.assertTrue(plan["full"])
        self.assertIn("test/New.Tests/New.Tests.gsproj", plan["projects"].split())
        self.assertEqual(plan["unknown_suites"], ["test/New.Tests/New.Tests.gsproj"])

    def test_dormant_go_checks_and_missing_module_fail_closed(self):
        self.assertFalse(ci.GO_JOBS.intersection(ci.select([], "push", go_exists=False)["jobs"]))
        with self.assertRaises(ValueError):
            ci.select(["tools/go2gs/go.mod"], "pull_request", go_exists=False)


class DiffTests(unittest.TestCase):
    def test_real_git_add_delete_and_both_rename_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True,
                                      capture_output=True, text=True).stdout.strip()

            git("init", "-q")
            git("config", "user.name", "CI Test")
            git("config", "user.email", "ci@example.invalid")
            (root / "docs").mkdir()
            (root / "tools").mkdir()
            (root / "docs/old.md").write_text("rename this exact content\n")
            (root / "docs/deleted.md").write_text("delete\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("mv", "docs/old.md", "tools/renamed.input")
            (root / "docs/deleted.md").unlink()
            (root / "docs/new with spaces.md").write_text("new\n")
            git("add", "-A")
            git("commit", "-qm", "head")
            paths = ci.changed_paths(base, git("rev-parse", "HEAD"), root)
            self.assertEqual(paths, ["docs/deleted.md", "docs/new with spaces.md",
                                     "docs/old.md", "tools/renamed.input"])
            self.assertTrue(selection(*paths)["full"])
            with self.assertRaises(subprocess.CalledProcessError):
                ci.changed_paths("missing-ref", "HEAD", root)

    def test_malformed_diff_is_not_an_empty_selection(self):
        for output in (b"M\0", b"R100\0one\0", b"M\0file", b"?\0file\0"):
            with patch.object(ci.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
                with self.assertRaises(ValueError):
                    ci.changed_paths("base", "head")

    def test_real_cli_diff_failure_writes_no_success_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "event.json").write_text(json.dumps({
                "pull_request": {"base": {"sha": "not-a-ref"}, "head": {"sha": "HEAD"}}}))
            env = {**os.environ, "GITHUB_EVENT_NAME": "pull_request",
                   "GITHUB_EVENT_PATH": str(root / "event.json"),
                   "GITHUB_OUTPUT": str(root / "output"),
                   "GITHUB_STEP_SUMMARY": str(root / "summary")}
            result = subprocess.run(["python3", str(ROOT / "build/ci-selection.py")],
                                    cwd=ROOT, env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "output").exists())


class MatrixAndGraphTests(unittest.TestCase):
    def test_sdk_pack_targets_are_in_the_restore_graph(self):
        path = ROOT / ci.SDK
        tree = ET.parse(path)
        properties = {node.tag: node.text for group in tree.iter("PropertyGroup") for node in group}

        def resolve(value):
            if value.startswith("$(") and value.endswith(")"):
                value = properties[value[2:-1]]
            value = value.replace("$(MSBuildThisFileDirectory)", str(path.parent) + "/")
            self.assertNotIn("$(", value)
            return (path.parent / value.replace("\\", "/")).resolve()

        references = {resolve(node.attrib["Include"]) for node in tree.iter("ProjectReference")}
        # The native reference walker only invokes projects from ProjectReference.
        invoked = {resolve(node.attrib["Projects"]) for node in tree.iter("MSBuild")
                   if node.attrib["Projects"] != "@(_MSBuildProjectReferenceExistent)"}
        self.assertTrue(invoked)
        self.assertFalse(invoked - references, f"pack tools missing from restore graph: {invoked - references}")

    def entries(self):
        entries = [{"name": matrix.GROUPED_NAME, "project": " ".join(matrix.GROUPED_PROJECTS), "filter": ""}]
        for project, bands in matrix.SHARDED_PROJECTS.items():
            entries.extend(matrix.sharded_entries(project, bands))
        return entries

    def test_filter_preserves_bands_and_intersects_grouped_members(self):
        entries = self.entries()
        for grouped in matrix.GROUPED_PROJECTS:
            selected = matrix.selected_entries(entries, f"{ci.CS2GS} {grouped}")
            self.assertEqual(next(e["project"] for e in selected if e["name"] == matrix.GROUPED_NAME), grouped)
            self.assertEqual([e for e in selected if e["project"] == ci.CS2GS],
                             [e for e in entries if e["project"] == ci.CS2GS])
        self.assertEqual(matrix.selected_entries(entries, ""), [])
        self.assertEqual(matrix.selected_entries(entries, None), entries)
        with self.assertRaises(ValueError):
            matrix.selected_entries(entries, "missing.gsproj")

    def test_partition_receives_the_identical_selection(self):
        with patch.object(partition.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 0, '{"include":[]}')) as run:
            partition.matrix("GSharp.slnx", ci.CS2GS)
        self.assertEqual(run.call_args.args[0][-2:], ["--projects", ci.CS2GS])

    def test_selected_restore_and_build_use_one_graph_not_solution(self):
        for command in ("restore", "build"):
            captured = []

            def capture(args, **kwargs):
                self.assertEqual(args[:2], ["dotnet", command])
                self.assertNotEqual(Path(args[2]).name, "GSharp.slnx")
                filtered = json.loads(Path(args[2]).read_text())["solution"]
                self.assertEqual(filtered["path"], "GSharp.slnx")
                captured.append(filtered["projects"])
                if command == "build":
                    self.assertIn("-graph", args)
                    self.assertIn("--no-restore", args)
                else:
                    self.assertIn("--locked-mode", args)
                return subprocess.CompletedProcess(args, 0)

            with patch.object(graphs.subprocess, "run", side_effect=capture):
                graphs.run(command, f"{ci.CS2GS} {ci.GENERATOR}")
            self.assertEqual(captured, [sorted([ci.CS2GS, ci.GENERATOR])])
        with self.assertRaises(ValueError):
            graphs.run("build", "")
        with self.assertRaises(ValueError):
            graphs.run("build", "not-in-solution.gsproj")


class AggregateTests(unittest.TestCase):
    def test_only_selected_success_is_green_for_each_workflow(self):
        plan = selection("tools/go2gs/main.go", "docs/go.md")
        for workflow, jobs in (("build", plan["jobs"]), ("docs", plan["docs_jobs"])):
            needs = {name: {"result": "success"} for name in [*jobs, "select"]}
            needs["unrelated"] = {"result": "skipped"}
            ci.check_results(plan, needs, workflow)
            for name in [*jobs, "select"]:
                for bad in ("failure", "cancelled", "skipped", None):
                    broken = copy.deepcopy(needs)
                    broken[name] = {"result": bad}
                    with self.subTest(workflow=workflow, job=name, bad=bad):
                        with self.assertRaises(ValueError):
                            ci.check_results(plan, broken, workflow)
                missing = copy.deepcopy(needs)
                del missing[name]
                with self.assertRaises(ValueError):
                    ci.check_results(plan, missing, workflow)


class AdvisorySmokeTests(unittest.TestCase):
    """ADR-0218: r2r-compiler-smoke is advisory on a release tag and required everywhere else."""
    TAG = "refs/tags/v0.5.300"
    ADVISORY = frozenset({"r2r-compiler-smoke"})

    def setUp(self):
        self.plan = selection("src/Core/Lexer.gs")
        self.assertIn("r2r-compiler-smoke", self.plan["jobs"])
        self.needs = {name: {"result": "success"} for name in [*self.plan["jobs"], "select"]}

    def check(self, needs, ref, legs=None):
        return ci.check_results(self.plan, needs, "build", ref, self.ADVISORY, lambda: legs or {})

    def test_failed_smoke_passes_on_a_tag_and_names_the_failed_legs(self):
        self.needs["r2r-compiler-smoke"] = {"result": "failure"}
        legs = {rid: "success" for rid in ci.SMOKE_RIDS}
        legs["osx-x64"] = "failure"
        legs["win-arm64"] = "cancelled"
        self.assertEqual(self.check(self.needs, self.TAG, legs), ["win-arm64", "osx-x64"])

    def test_every_non_success_result_passes_on_a_tag(self):
        for bad in ("failure", "cancelled", "skipped"):
            with self.subTest(result=bad):
                self.needs["r2r-compiler-smoke"] = {"result": bad}
                self.assertEqual(self.check(self.needs, self.TAG), list(ci.SMOKE_RIDS))

    def test_successful_smoke_has_no_unverified_platform_and_reads_no_legs(self):
        def forbidden():
            raise AssertionError("the jobs API must not be read when the smoke passed")
        self.assertEqual(ci.check_results(self.plan, self.needs, "build", self.TAG, self.ADVISORY, forbidden), [])

    def test_failed_smoke_fails_on_pull_requests_main_and_other_tags(self):
        self.needs["r2r-compiler-smoke"] = {"result": "failure"}
        for ref in ("refs/pull/5/merge", "refs/heads/main", "refs/tags/release-1", ""):
            with self.subTest(ref=ref):
                with self.assertRaises(ValueError):
                    self.check(self.needs, ref)

    def test_other_failed_jobs_fail_on_a_tag(self):
        for name in self.plan["jobs"]:
            if name == "r2r-compiler-smoke":
                continue
            with self.subTest(job=name):
                broken = copy.deepcopy(self.needs)
                broken[name] = {"result": "failure"}
                with self.assertRaises(ValueError):
                    self.check(broken, self.TAG)

    def test_without_an_advisory_list_a_tag_still_requires_the_smoke(self):
        self.needs["r2r-compiler-smoke"] = {"result": "failure"}
        with self.assertRaises(ValueError):
            ci.check_results(self.plan, self.needs, "build", self.TAG)

    def test_legs_come_from_the_jobs_api_of_the_current_run(self):
        calls = []

        def fake(command, **kwargs):
            calls.append(command)
            out = "r2r-compiler-smoke (linux-x64)\tsuccess\nr2r-compiler-smoke (osx-x64)\tfailure\nbuild\tsuccess\n"
            return subprocess.CompletedProcess(command, 0, out, "")

        legs = ci.smoke_legs("owner/repo", "42", fake)
        self.assertEqual(legs, {"linux-x64": "success", "osx-x64": "failure"})
        self.assertIn("repos/owner/repo/actions/runs/42/jobs", calls[0])
        broken = lambda command, **kwargs: subprocess.CompletedProcess(command, 1, "", "HTTP 403")
        self.assertEqual(ci.smoke_legs("owner/repo", "42", broken), {})

    def test_rids_match_the_workflow_matrix_and_the_package_check(self):
        text = (ROOT / ".github/workflows/build.yml").read_text()
        rids = re.findall(r"\{ rid: ([a-z0-9-]+), os:", job(text, "r2r-compiler-smoke"))
        self.assertEqual(sorted(rids), sorted(ci.SMOKE_RIDS))
        self.assertEqual(sorted(load("check-rid-packages").RIDS), sorted(ci.SMOKE_RIDS))

    def test_ci_job_passes_the_advisory_rule_and_has_the_actions_read_permission(self):
        block = job((ROOT / ".github/workflows/build.yml").read_text(), "ci")
        self.assertIn("ADVISORY_JOBS: r2r-compiler-smoke", block)
        self.assertRegex(block, r"permissions:\n\s+#.*\n\s+contents: read\n\s+actions: read")
        self.assertIn("unverified_rids: ${{ steps.check.outputs.unverified_rids }}", block)
        self.assertIn("id: check", block)


class PublishJobTests(unittest.TestCase):
    """ADR-0218: seven publish jobs, each with its condition in full (the implicit success() looks past the
    direct prerequisite, as the step-2 probe showed). Nothing here can run a publish; only a tag run does."""
    JOBS = {
        "publish-verify": {"ci"},
        "publish-github-release": {"publish-verify"},
        "publish-nuget-compiler": {"publish-verify"},
        "publish-nuget-sdk": {"publish-verify", "publish-nuget-compiler"},
        "publish-vscode-marketplace": {"publish-verify", "publish-nuget-sdk"},
        "publish-visual-studio-marketplace": {"publish-verify", "publish-nuget-sdk"},
        "publish-finalize": {"publish-verify", "publish-github-release", "publish-vscode-marketplace",
                             "publish-visual-studio-marketplace"},
    }

    def setUp(self):
        self.text = (ROOT / ".github/workflows/build.yml").read_text()

    def needs(self, name):
        return set(re.search(r"^    needs: \[(.*?)\]", job(self.text, name), re.M).group(1).split(", "))

    def condition(self, name):
        return re.search(r"^    if: \$\{\{ (.*) \}\}$", job(self.text, name), re.M).group(1)

    def test_the_old_jobs_are_gone_and_the_seven_exist(self):
        self.assertNotRegex(self.text, r"(?m)^  publish:")
        self.assertNotIn("publish-visual-studio-extension", self.text)
        found = set(re.findall(r"(?m)^  (publish-[\w-]+):", self.text))
        self.assertEqual(found, set(self.JOBS))

    def test_the_graph_is_the_adr_graph(self):
        for name, needs in self.JOBS.items():
            with self.subTest(job=name):
                self.assertEqual(self.needs(name), needs)

    def test_every_job_states_its_condition_in_full(self):
        for name, needs in self.JOBS.items():
            with self.subTest(job=name):
                condition = self.condition(name)
                self.assertIn("!cancelled()", condition)
                self.assertNotIn("always()", condition)
                self.assertIn("startsWith(github.ref, 'refs/tags/v')", condition)
                for need in needs:
                    if name == "publish-finalize" and need != "publish-verify":
                        continue  # finalize reports the other destinations itself
                    self.assertIn(f"needs.{need}.result == 'success'", condition)

    def test_only_the_visual_studio_job_skips_on_a_prerelease(self):
        for name in self.JOBS:
            has = "prerelease != 'true'" in self.condition(name)
            self.assertEqual(has, name == "publish-visual-studio-marketplace", name)

    def test_permissions_secrets_and_runners(self):
        for name in self.JOBS:
            block = job(self.text, name)
            writes = "contents: write" in block
            self.assertEqual(writes, name in {"publish-github-release", "publish-finalize"}, name)
            self.assertNotIn("environment:", block)
        for secret, owner in (("NUGET_API_KEY", {"publish-nuget-compiler", "publish-nuget-sdk"}),
                              ("VSCE_PAT", {"publish-vscode-marketplace", "publish-visual-studio-marketplace"})):
            self.assertEqual({n for n in self.JOBS if f"secrets.{secret}" in job(self.text, n)}, owner)
        self.assertIn("runs-on: windows-latest", job(self.text, "publish-visual-studio-marketplace"))

    def test_scripts_vsce_pin_draft_and_artifacts(self):
        self.assertIn("nuget-push --group compiler", job(self.text, "publish-nuget-compiler"))
        self.assertIn("--wait-minutes 30", job(self.text, "publish-nuget-compiler"))
        sdk = job(self.text, "publish-nuget-sdk")
        self.assertLess(sdk.index("check-rid-packages.py --packages ./nupkgs\n"), sdk.index("nuget-push --group sdk"))
        self.assertIn("--wait-minutes 15 --require-sdk", sdk)
        vscode = job(self.text, "publish-vscode-marketplace")
        self.assertIn("@vscode/vsce@3.9.2 publish", vscode)
        self.assertIn("--skip-duplicate", vscode)
        self.assertNotRegex(vscode, r"vsce@[\d.]+ publish[^\n]*--pre-release")
        self.assertRegex(self.text, r"@vscode/vsce@\d+\.\d+\.\d+")
        self.assertNotRegex(self.text, r"vsce publish --packagePath \./vsix/vscode-gsharp\.vsix\n")
        release = job(self.text, "publish-github-release")
        self.assertIn("--draft", release)
        self.assertIn("--prerelease", release)
        self.assertIn("--clobber", release)
        self.assertIn("finalize", job(self.text, "publish-finalize"))
        for name in ("publish-github-release", "publish-nuget-compiler", "publish-nuget-sdk"):
            self.assertIn("name: nuget-packages", job(self.text, name))

    def test_the_vsix_job_asks_tag_kind_for_the_pre_release_flag(self):
        block = job(self.text, "vsix")
        self.assertIn('release-publish.py tag-kind "$GITHUB_REF_NAME"', block)
        self.assertIn("--pre-release", block)
        self.assertLess(block.index("tag-kind"), block.index("vsce package"))

    def test_publish_verify_forwards_the_ci_output_and_the_script_outputs(self):
        block = job(self.text, "publish-verify")
        for name in ("version", "prerelease", "vscode_version", "visual_studio_version"):
            self.assertIn(f"{name}: ${{{{ steps.verify.outputs.{name} }}}}", block)
        self.assertIn("unverified_rids: ${{ needs.ci.outputs.unverified_rids }}", block)


class WorkflowTests(unittest.TestCase):
    def test_partition_pipeline_propagates_failed_verification(self):
        text = (ROOT / ".github/workflows/build.yml").read_text()
        steps = re.findall(r"      - name: Verify .*?exactly once\n(.*?)(?=^      -|\Z)",
                           job(text, "test-partition"), re.M | re.S)
        self.assertEqual(len(steps), 2)
        for step in steps:
            command = re.search(r"^        run: (.+)", step, re.M).group(1)
            command = command.replace("python3 build/verify-ci-test-partition.py",
                                      "python3 -c 'raise SystemExit(23)'")
            # Match Actions' explicit-bash and default Linux shell invocations.
            shell = ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail"] \
                if re.search(r"^        shell: bash$", step, re.M) else ["bash", "-e"]
            with tempfile.TemporaryDirectory() as directory:
                result = subprocess.run([*shell, "-c", command], capture_output=True,
                                        env={**os.environ, "GITHUB_STEP_SUMMARY": str(Path(directory) / "summary"),
                                             "PROJECTS": ci.CS2GS})
            self.assertEqual(result.returncode, 23, "tee masked a partition failure")

    def test_aggregates_cover_all_selected_job_ids_even_after_failure(self):
        for filename, aggregate, selected in (
            ("build.yml", "ci", ci.BUILD_JOBS | ci.GO_JOBS | {"format"}),
            ("pages.yml", "docs-ci", {"build", "visual"}),
        ):
            text = (ROOT / ".github/workflows" / filename).read_text()
            block = job(text, aggregate)
            self.assertIn("if: always()", block)
            needs = re.search(r"needs: \[(.*?)\]", block).group(1).split(", ")
            self.assertEqual(set(needs), selected | {"select"})
            for name in selected:
                block = job(text, name)
                self.assertIn(f", '{name}')", block)
                self.assertIn("select", re.search(r"needs: (.*)", block).group(1))
            trigger = text.split("\nconcurrency:")[0]
            pr_trigger = trigger.split("  pull_request:")[1].split("\n  schedule:")[0]
            self.assertNotIn("paths:", pr_trigger)

    def test_official_commands_artifacts_and_publication_dependencies_stay(self):
        text = (ROOT / ".github/workflows/build.yml").read_text()
        for name in ("build", "tests", "test-partition"):
            block = job(text, name)
            self.assertIn("dotnet restore GSharp.slnx --locked-mode", block)
            self.assertIn("dotnet build GSharp.slnx --configuration Release --no-restore -graph", block)
            self.assertIn("if: github.event_name != 'pull_request'", block)
        # The publish jobs are covered by PublishJobTests (ADR-0218).
        for artifact in ("nuget-packages", "vscode-gsharp-vsix", "visual-studio-gsharp-vsix"):
            self.assertIn(f"name: {artifact}", job(text, "publish-verify"))
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        push = pages.split("  push:\n")[1].split("  pull_request:")[0]
        self.assertEqual(re.findall(r"      - '(.*?)'", push),
                         ["website/**", "samples/**", "global.json", ".github/workflows/pages.yml"])
        self.assertIn("- cron: '23 06 * * *'", pages)
        self.assertIn("if: github.event_name != 'pull_request'", job(pages, "build"))
        deploy = job(pages, "deploy")
        self.assertIn("needs: [build, visual]", deploy)
        self.assertIn("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'", deploy)


class RulesTests(unittest.TestCase):
    def test_apply_creates_main_protection_before_narrowing_the_old_ruleset(self):
        args = rules.argparse.Namespace(ruleset=123, apply=True)
        with patch.object(rules.argparse.ArgumentParser, "parse_args", return_value=args), \
                patch.object(rules, "split_rules", return_value=({"name": "Main CI aggregates"}, {"name": "Lock Main"})), \
                patch.object(rules, "api", side_effect=[{}, [], {"id": 456}, {"id": 123}]) as api, \
                patch("builtins.print"):
            rules.main()
        self.assertEqual([call.args for call in api.call_args_list], [
            ("rulesets/123",), ("rulesets",),
            ("rulesets", "POST", {"name": "Main CI aggregates"}),
            ("rulesets/123", "PUT", {"name": "Lock Main"}),
        ])

    def test_split_preserves_every_csharp_rule_and_only_replaces_main_checks(self):
        original = {"name": "Lock Main", "target": "branch", "enforcement": "active",
                    "bypass_actors": [{"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}],
                    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH", "refs/heads/cs2gs/csharp*"], "exclude": []}},
                    "rules": [{"type": "deletion"}, {"type": "non_fast_forward"},
                              {"type": "pull_request", "parameters": {"required_approving_review_count": 0}},
                              {"type": "required_status_checks", "parameters": {
                                  "strict_required_status_checks_policy": False,
                                  "do_not_enforce_on_create": False,
                                  "required_status_checks": [{"context": "build", "integration_id": 15368}]}},
                              {"type": "copilot_code_review", "parameters": {"review_on_push": True}}]}
        snapshot = copy.deepcopy(original)
        main, csharp = rules.split_rules(original)
        self.assertEqual(original, snapshot)
        self.assertEqual(csharp["rules"], original["rules"])
        self.assertEqual(csharp["conditions"]["ref_name"]["include"], ["refs/heads/cs2gs/csharp*"])
        self.assertEqual(main["conditions"]["ref_name"]["include"], ["~DEFAULT_BRANCH"])
        for name in ("bypass_actors", "target", "enforcement"):
            self.assertEqual(main[name], original[name])
            self.assertEqual(csharp[name], original[name])
        unchanged = lambda rs: [r for r in rs["rules"] if r["type"] != "required_status_checks"]
        self.assertEqual(unchanged(main), unchanged(original))
        checks = next(r["parameters"] for r in main["rules"] if r["type"] == "required_status_checks")
        self.assertEqual(checks["required_status_checks"],
                         [{"context": name, "integration_id": 15368} for name in ("ci", "docs-ci")])


if __name__ == "__main__":
    unittest.main()
