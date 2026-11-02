#!/usr/bin/env python3
"""Select PR validation by component. Other events keep full validation."""

import argparse
import json
import os
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SDK = "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"
TEMPLATES = "src/Sdk/Gsharp.Templates/Gsharp.Templates.gsproj"
CS2GS = "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.gsproj"
GENERATOR = "tools/gsgen/GSharp.GeneratorHost.Tests/GSharp.GeneratorHost.Tests.gsproj"
SUITES = {
    "core": "test/Core.Tests/Core.Tests.gsproj",
    "compiler": "test/Compiler.Tests/Compiler.Tests.gsproj",
    "formatting": "test/Formatting.Tests/Formatting.Tests.gsproj",
    "interpreter": "test/Interpreter.Tests/Interpreter.Tests.gsproj",
    "language-server": "test/LanguageServer.Tests/LanguageServer.Tests.gsproj",
    "sdk": "test/Sdk.Tests/Sdk.Tests.gsproj",
    "channels": "test/Runtime.Channels.Tests/Runtime.Channels.Tests.gsproj",
    "extensions": "test/Extensions.Tests/Extensions.Tests.gsproj",
    "analyzers": "test/InternalAnalyzers.Tests/InternalAnalyzers.Tests.gsproj",
    "cs2gs": CS2GS,
    "generators": GENERATOR,
}
# These documentation files are also inputs to product contract tests.
CONTRACT_INPUTS = {
    "docs/cs2gs-coverage-matrix.md": "cs2gs",
    "docs/diagnostics.md": "core",
    "website/docs/ref/diagnostics.md": "core",
    "website/docs/tooling/repl.md": "interpreter",
}
HARNESS = {
    "counters": ["build/test-cs2gs-counters.sh", "build/cs2gs-counters.sh"],
    "stage1": ["build/test-selfhost-pack-stage1.py", "build/selfhost-pack-stage1.py",
               "build/test-rid-compiler-packages.py", "build/check-rid-packages.py"],
    "stage2": ["build/test-selfhost-stage2.py", "build/selfhost-stage2.py",
               "build/selfhost_pe.py", "build/verify-stage2-report.py"],
    "concurrency": ["build/verify-concurrency-bench.py", "build/run-concurrency-bench.py",
                    "build/test-concurrency-bench.py"],
    "apps": ["build/test-cs2gs-apps-gate-issues.py", "build/cs2gs-apps-gate-issues.py",
             "build/test-cs2gs-apps-leg.py", "build/cs2gs-apps-leg.py"],
    "selfhost-bench": ["build/test-selfhost-bench.py", "build/selfhost-bench.py",
                       "build/test-compiler-bench.py", "build/compiler-bench.py"],
    "comment-checker": ["build/test-check-comment-only-diff.py", "build/check-comment-only-diff.py"],
}
BUILD_JOBS = {
    "build", "discover-tests", "tests", "test-partition", "harness", "e2e",
    "ilverify", "release-version-refs", "cs2gs-corpus", "vscode-extension",
    "vsix", "visual-studio-extension", "desktop-msbuild-sdk-smoke", "r2r-compiler-smoke",
}
EDITOR_JOBS = {"vscode-extension", "vsix", "visual-studio-extension"}
COMPILER_JOBS = BUILD_JOBS - EDITOR_JOBS
GO_JOBS = {"go2gs", "go2gs-windows", "go2gs-macos"}


def solution_projects(solution=ROOT / "GSharp.slnx"):
    return sorted(node.attrib["Path"].replace("\\", "/")
                  for node in ET.parse(solution).iter("Project"))


def test_projects(projects):
    return [p for p in projects if p.lower().endswith(".tests.gsproj")]


def changed_paths(base, head, cwd=ROOT):
    """Read the complete diff, including deleted files and both rename paths."""
    result = subprocess.run(
        ["git", "diff", "--name-status", "-z", "--find-renames", f"{base}...{head}", "--"],
        cwd=cwd, check=True, capture_output=True,
    )
    fields = result.stdout.decode("utf-8").split("\0")
    if fields.pop() != "":
        raise ValueError("git diff did not return NUL-terminated records")
    paths = []
    while fields:
        status = fields.pop(0)
        if not status or status[0] not in "ACDMRTUXB":
            raise ValueError(f"unsupported git diff status: {status!r}")
        count = 2 if status[0] in "RC" else 1
        if len(fields) < count:
            raise ValueError("incomplete git diff record")
        for _ in range(count):
            path = fields.pop(0)
            if not path or path.startswith("/") or ".." in Path(path).parts:
                raise ValueError(f"invalid diff path: {path!r}")
            paths.append(path)
    return sorted(set(paths))


def area(path):
    # Component inputs precede prose: a fixture README can be executable data.
    parts = Path(path).parts
    if len(parts) == 3 and parts[0] == "tools" and parts[2] == "README.md":
        return "docs"
    for prefix, component in (
        ("tools/go2gs/", "go"), ("tools/cs2gs/", "cs2gs"),
        ("tools/gsgen/", "generators"), ("test/Shared/", "compiler"),
        ("test-assets/", "compiler"), ("samples/", "samples"),
        ("e2etests/", "sdk"), ("src/Core/", "compiler"),
        ("src/Compiler/", "compiler"), ("src/Analyzers/", "compiler"),
        ("src/Sdk/", "sdk"), ("src/Formatting/", "formatting"),
        ("src/LanguageServer/", "language-server"), ("src/Repl/", "interpreter"),
        ("src/vscode-gsharp/", "vscode"), ("src/vs-gsharp/", "visual-studio"),
        ("bench/concurrency/", "concurrency"), ("build/selfhost/", "stage2"),
        ("build/gstokens/", "comment-checker"),
    ):
        if path.startswith(prefix):
            return component
    for component, project in SUITES.items():
        if path.startswith(str(Path(project).parent) + "/"):
            # These files are linked into other suites, not just Core.Tests.
            if path.startswith("test/Core.Tests/") or path.startswith("test/Compiler.Tests/TestData/"):
                return "compiler"
            return component
    for harness, inputs in HARNESS.items():
        if path in inputs:
            return harness
    if path.startswith(("website/", "docs/")) or (
            "/" not in path and Path(path).suffix.lower() == ".md"):
        return "docs"
    # Changes to shared configuration, workflows, the router, and new inputs
    # require a full run. Never infer independence from a project-file suffix.
    return "full"


def select(paths, event, projects=None, go_exists=None):
    projects = solution_projects() if projects is None else projects
    all_tests = set(test_projects(projects))
    go_exists = (ROOT / "tools/go2gs/go.mod").is_file() if go_exists is None else go_exists
    reasons = {path: area(path) for path in paths} if event == "pull_request" else {}
    areas = set(reasons.values())
    # New suites must not disappear because the routing table predates them.
    unknown_suites = all_tests.difference(SUITES.values())
    full = event != "pull_request" or "full" in areas or bool(unknown_suites)
    jobs = {"release-version-refs"}
    suites = set()
    harnesses = set()
    docs_jobs = set()
    build_projects = set()
    for path in reasons:
        if path in CONTRACT_INPUTS:
            consumer = CONTRACT_INPUTS[path]
            suites.add(SUITES[consumer])
            reasons[path] += f" + {consumer} contract tests"
    if full:
        jobs.update(BUILD_JOBS)
        suites.update(all_tests)
        harnesses.update(HARNESS)
        docs_jobs.update({"build", "visual"})
    else:
        for component in areas:
            if component in SUITES:
                suites.add(SUITES[component])
        if "compiler" in areas:
            suites.update(all_tests)
            jobs.update(COMPILER_JOBS)
            harnesses.add("comment-checker")
        if areas.intersection({"sdk", "generators"}):
            suites.update(SUITES[key] for key in (
                "sdk", "compiler", "interpreter", "extensions", "channels", "cs2gs", "generators"))
            jobs.update({"build", "e2e", "ilverify", "desktop-msbuild-sdk-smoke", "r2r-compiler-smoke", "cs2gs-corpus"})
        if "sdk" in areas:
            # Core and all frontends consume the bundled runtimes.
            suites.update(all_tests)
            jobs.update(EDITOR_JOBS)
        if "cs2gs" in areas:
            suites.update({CS2GS, GENERATOR})
            jobs.update({"cs2gs-corpus", "e2e"})
            harnesses.update({"apps", "counters"})
        if "formatting" in areas:
            suites.update(SUITES[key] for key in ("formatting", "language-server", "interpreter", "cs2gs"))
            suites.add(GENERATOR)
            jobs.add("cs2gs-corpus")
        if areas.intersection({"language-server", "formatting"}):
            suites.add(SUITES["interpreter"])
            jobs.update(EDITOR_JOBS)
        if areas.intersection({"interpreter", "language-server", "formatting"}):
            suites.add(SUITES["compiler"])
        if "vscode" in areas:
            jobs.update(EDITOR_JOBS)
            if "src/vscode-gsharp/src/test/grammar-cases.json" in paths:
                docs_jobs.update({"build", "visual"})
        if "visual-studio" in areas:
            jobs.add("visual-studio-extension")
        if "samples" in areas:
            suites.update(SUITES[key] for key in (
                "core", "compiler", "formatting", "language-server", "interpreter", "sdk", "cs2gs"))
            jobs.update({"e2e", "ilverify", "cs2gs-corpus"})
            docs_jobs.update({"build", "visual"})
        if "docs" in areas:
            docs_jobs.update({"build", "visual"})
        harnesses.update(areas.intersection(HARNESS))
        if suites:
            jobs.update({"discover-tests", "tests", "test-partition"})
        if harnesses:
            jobs.add("harness")
        if any(Path(p).suffix == ".gs" for p in paths) or areas.intersection(SUITES):
            jobs.add("format")
        if "build" in jobs:
            build_projects.update({SDK, TEMPLATES})
    if go_exists and (event != "pull_request" or "go" in areas):
        jobs.update(GO_JOBS)
    if "go" in areas and not go_exists:
        raise ValueError("Go inputs changed but tools/go2gs/go.mod is missing")
    # Canonical formatting stays in the official solution build.
    if event != "pull_request":
        jobs.discard("format")
    return {
        "full": full, "jobs": sorted(jobs), "docs_jobs": sorted(docs_jobs),
        "projects": " ".join(sorted(suites)), "build_projects": " ".join(sorted(build_projects)),
        "harness_matrix": {"name": sorted(harnesses)},
        "reasons": reasons, "unknown_suites": sorted(unknown_suites),
    }


# ADR-0218: on a release tag the ReadyToRun smoke is advisory. The release names a platform whose leg did
# not pass instead of blocking. On pull requests and on main the smoke stays required.
SMOKE_JOB = "r2r-compiler-smoke"
SMOKE_RIDS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64", "osx-x64", "osx-arm64")


def advisory_applies(ref, job, advisory):
    return job in advisory and ref.startswith("refs/tags/v")


def smoke_legs(repository, run_id, run=subprocess.run):
    """Conclusion of each smoke leg of the current run, from the jobs API. Empty when the API cannot be read."""
    result = run(["gh", "api", "--paginate", f"repos/{repository}/actions/runs/{run_id}/jobs",
                  "--jq", ".jobs[] | [.name, .conclusion] | @tsv"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"warning: cannot read the jobs of run {run_id}: {result.stderr.strip()}")
        return {}
    legs = {}
    for line in result.stdout.splitlines():
        name, _, conclusion = line.partition("\t")
        if name.startswith(f"{SMOKE_JOB} (") and name.endswith(")"):
            legs[name[len(SMOKE_JOB) + 2:-1]] = conclusion
    return legs


def check_results(plan, needs, workflow, ref="", advisory=frozenset(), legs=lambda: {}):
    """Raise ValueError when a selected job did not succeed. Return the smoke RIDs that did not pass.

    A job in `advisory` may fail, be cancelled or be skipped on a refs/tags/v* ref. The RIDs of the smoke
    legs whose conclusion is not success are returned, so the release can name them. A leg that the jobs
    API does not list counts as not passed.
    """
    selected = set(plan["docs_jobs" if workflow == "docs" else "jobs"])
    required = selected | {"select"}
    failures = []
    unverified = []
    for job in sorted(set(needs) | required):
        result = needs.get(job, {}).get("result")
        if advisory_applies(ref, job, advisory):
            if result != "success" and job == SMOKE_JOB:
                seen = legs()
                unverified = [rid for rid in SMOKE_RIDS if seen.get(rid) != "success"]
            continue
        if job in required:
            if result != "success":
                failures.append(f"{job}: expected success, got {result!r}")
        elif result not in {"success", "skipped"}:
            failures.append(f"{job}: unselected job {result!r}")
    if failures:
        raise ValueError("\n".join(failures))
    return unverified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", choices=["build", "docs"])
    args = parser.parse_args()
    if args.check:
        ref = os.environ.get("GITHUB_REF", "")
        advisory = frozenset(filter(None, os.environ.get("ADVISORY_JOBS", "").split(",")))
        legs = lambda: smoke_legs(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"])
        unverified = check_results(json.loads(os.environ["PLAN"]), json.loads(os.environ["NEEDS"]),
                                   args.check, ref, advisory, legs)
        names = " ".join(unverified)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
                handle.write(f"unverified_rids={names}\n")
        if unverified and os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
                handle.write(f"## Unverified platforms\n\n`{names}`: the ReadyToRun compiler smoke did not pass "
                             "(advisory on a release tag, ADR-0218).\n")
        return
    event = os.environ["GITHUB_EVENT_NAME"]
    paths = []
    if event == "pull_request":
        payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = payload["pull_request"]
        paths = changed_paths(pr["base"]["sha"], pr["head"]["sha"])
    plan = select(paths, event)
    encoded = json.dumps(plan, separators=(",", ":"))
    with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
        handle.write(f"plan={encoded}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
        handle.write("## CI selection\n\n")
        handle.write(f"Full validation: `{plan['full']}`. Event: `{event}`.\n\n")
        handle.write(f"Build jobs: `{', '.join(plan['jobs'])}`\n\n")
        handle.write(f"Docs jobs: `{', '.join(plan['docs_jobs'])}`\n\n")
        handle.write(f"Test projects: `{plan['projects']}`\n\n")
        for path, reason in plan["reasons"].items():
            handle.write(f"- `{path}`: {reason}\n")
        if plan["unknown_suites"]:
            handle.write(f"\nUnclassified test projects require full validation: {plan['unknown_suites']}\n")


if __name__ == "__main__":
    main()
