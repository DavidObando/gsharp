#!/usr/bin/env python3
"""Stage-2 self-host equivalence check for a cs2gs-migrated (G#) tree.

Issue #4631 (C3/C4). Given a migrated tree prepared by
build/selfhost-pack-stage1.py, the stage-0 (C#-built) SDK package and the
stage-1 (G#-source, stage-0-built) SDK package, this script:

  1. builds the requested projects with stage 0  -> the stage-1 assemblies
  2. builds the same projects, in the SAME tree path, with stage 1
                                                -> the stage-2 assemblies
  3. compares each assembly pair: full-file SHA-256, and the complete PE
     image with only the referenced Module.Mvid GUID slot zeroed
     (build/selfhost/PeContentHash.cs)
  4. optionally runs test projects while pinned to stage 1, so every
     assembly they compile against is a stage-2 assembly.

Both builds run from the same absolute paths with the same isolated
NuGet cache layout, so any byte that differs comes from the compiler (or
the SDK task) that produced it. The verdict is "equivalent" only if every
IL+metadata hash matches; a full-file difference with matching IL+metadata
is reported, not hidden.

Exit status: 0 equivalent (and tests passed), 1 not equivalent or a test
failed, 2 a build or tool error.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("selfhost_pack_stage1", HERE / "selfhost-pack-stage1.py")
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-pack-stage1.py")
packer = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(packer)

HASH_TOOL = HERE / "selfhost" / "PeContentHash.cs"
DEFAULT_PROJECTS = ["src/Core/Core.gsproj"]


class Stage2Error(Exception):
    """A build or tool failure (exit 2)."""


def replace_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.staging-{os.getpid()}")
    try:
        temporary.unlink(missing_ok=True)
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def replace_xml(document: ET.ElementTree, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.staging-{os.getpid()}")
    try:
        temporary.unlink(missing_ok=True)
        document.write(temporary, encoding="utf-8", xml_declaration=True)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def run(command: list[str], cwd: Path, env: dict, log: Path) -> tuple[int, float]:
    started = time.monotonic()
    with log.open("a", encoding="utf-8") as handle:
        handle.write("$ " + shlex.join(command) + "\n")
        handle.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    return result.returncode, time.monotonic() - started


def stage_env(work: Path, stage: str) -> dict:
    env = dict(os.environ)
    # Keep the stages separate; build_stage also clears the building stage's
    # cache so a reused work directory cannot supply an old same-version SDK.
    env["NUGET_PACKAGES"] = str(work / f"nuget-{stage}")
    env["TMPDIR"] = str(work / "tmp")
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["MSBUILDDISABLENODEREUSE"] = "1"
    (work / "tmp").mkdir(parents=True, exist_ok=True)
    return env


def clean_outputs(tree: Path, assemblies: list[str]) -> None:
    for name in ("out",):
        shutil.rmtree(tree / name, ignore_errors=True)
    for assembly in assemblies:
        output = tree / assembly
        output.unlink(missing_ok=True)
        output.with_suffix(".pdb").unlink(missing_ok=True)


def pin(tree: Path, nupkg: Path) -> str:
    version = packer.package_version(nupkg)
    packer.stage_feed(tree, packer.sibling_nupkgs(nupkg, version))
    packer.pin_global_json(tree, version)
    return version


def project_sdk_specs(path: Path) -> list[tuple[str, str | None]]:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        raise Stage2Error(f"cannot inspect {path}: {error}") from error
    specs = []
    for element in root.iter():
        for sdk in element.attrib.get("Sdk", "").split(";"):
            name, separator, version = sdk.strip().partition("/")
            if name:
                specs.append((name, version if separator else None))
        if element.tag.rsplit("}", 1)[-1] == "Sdk":
            name = element.attrib.get("Name", "")
            if name:
                specs.append((name, element.attrib.get("Version")))
    return specs


def evaluate_project(path: Path, tree: Path, env: dict, config: str,
                     global_properties: dict[str, Path] | None = None) -> dict:
    property_args = [f"-p:{name}={value}" for name, value in (global_properties or {}).items()]
    result = subprocess.run(
        ["dotnet", "msbuild", str(path.relative_to(tree)), "-nologo",
         "-getProperty:MSBuildAllProjects,GsharpCompilerFullPath,GsharpToolFullPath,"
         "TargetFrameworks,BuildProjectReferences",
         "-getItem:ProjectReference",
         f"-p:Configuration={config}", *property_args, "-nodeReuse:false"],
        cwd=tree, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise Stage2Error(f"cannot evaluate participating project {path.relative_to(tree)}:\n"
                          + result.stdout + result.stderr)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Stage2Error(f"invalid MSBuild evaluation for {path.relative_to(tree)}: {error}") from error


def inspect_msbuild_files(paths: list[Path], expected_sdk: Path) -> None:
    immutable = {
        "CustomAfterMicrosoftCommonTargets",
        "GsharpCompilerFullPath",
        "GsharpToolFullPath",
    }
    for path in paths:
        if not path.is_file():
            continue
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError) as error:
            raise Stage2Error(f"cannot inspect evaluated MSBuild file {path}: {error}") from error
        local = {name.strip() for name in root.attrib.get("TreatAsLocalProperty", "").split(";")
                 if name.strip()}
        forbidden = sorted(local & immutable)
        if forbidden:
            raise Stage2Error(
                f"{path} exempts immutable stage-2 properties via TreatAsLocalProperty: "
                + ", ".join(forbidden))
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "UsingTask":
                continue
            task_name = element.attrib.get("TaskName", "").strip()
            if task_name.rsplit(".", 1)[-1].casefold() != "buildtask":
                continue
            if not path.resolve().is_relative_to(expected_sdk):
                raise Stage2Error(
                    f"{path} registers {task_name} outside the verified SDK")


def validate_participating_projects(tree: Path, roots: list[str], env: dict,
                                    config: str, sdk_version: str,
                                    global_properties: dict[str, Path] | None = None,
                                    gsharp_projects_out: set[Path] | None = None) -> list[str]:
    cache = Path(env["NUGET_PACKAGES"])
    expected_sdk = (cache / packer.SDK_ID.lower() / sdk_version.lower()).resolve()
    pending = [tree / root for root in roots]
    seen = set()
    gsharp_projects = set()
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        if not path.is_relative_to(tree) or not path.is_file():
            raise Stage2Error(f"participating project must be an existing file under --tree: {path}")
        seen.add(path)
        specs = project_sdk_specs(path)
        for name, version in specs:
            if name.lower() == packer.SDK_ID.lower() and version:
                raise Stage2Error(
                    f"{path.relative_to(tree)} explicitly selects {name}/{version}; "
                    "participating projects must use the global.json SDK pin")
        evaluation = (evaluate_project(path, tree, env, config, global_properties)
                      if global_properties is not None
                      else evaluate_project(path, tree, env, config))
        properties = evaluation.get("Properties", {})
        if properties.get("TargetFrameworks"):
            raise Stage2Error(
                f"{path.relative_to(tree)} is multi-targeted; stage-2 preflight requires "
                "a single effective project context")
        imports = [Path(item).resolve()
                   for item in properties.get("MSBuildAllProjects", "").split(";") if item]
        sdk_imports = [item for item in imports
                       if packer.SDK_ID.lower() in item.as_posix().lower().split("/")]
        declares_gsharp = any(name.lower() == packer.SDK_ID.lower() for name, _ in specs)
        if declares_gsharp or sdk_imports:
            if not sdk_imports or any(not item.is_relative_to(expected_sdk) for item in sdk_imports):
                raise Stage2Error(
                    f"{path.relative_to(tree)} did not resolve {packer.SDK_ID}/{sdk_version} "
                    f"from {expected_sdk}")
            expected_tools = {
                "GsharpCompilerFullPath": expected_sdk / "tools/compiler/gsc.dll",
                "GsharpToolFullPath": expected_sdk / "tools/task/Gsharp.NET.Sdk.dll",
            }
            for property_name, expected_path in expected_tools.items():
                actual = properties.get(property_name)
                if not actual or Path(actual).resolve() != expected_path.resolve():
                    raise Stage2Error(
                        f"{path.relative_to(tree)} overrides {property_name}: "
                        f"expected {expected_path}, got {actual!r}")
            inspect_msbuild_files([path, *imports], expected_sdk)
            gsharp_projects.add(path)
        references = evaluation.get("Items", {}).get("ProjectReference", [])
        if references and properties.get("BuildProjectReferences", "").strip().casefold() == "false":
            raise Stage2Error(
                f"{path.relative_to(tree)} disables ProjectReference builds via "
                "BuildProjectReferences=false")
        for reference in references:
            full_path = reference.get("FullPath")
            if not full_path:
                raise Stage2Error(f"{path.relative_to(tree)} has a ProjectReference without FullPath")
            if reference.get("BuildReference", "").strip().casefold() == "false":
                raise Stage2Error(
                    f"{path.relative_to(tree)} disables building ProjectReference {full_path}")
            context = {
                name: reference.get(name)
                for name in ("AdditionalProperties", "Properties", "SetConfiguration", "SetPlatform",
                             "SetTargetFramework", "GlobalPropertiesToRemove", "Targets")
                if reference.get(name)
            }
            if context:
                details = ", ".join(f"{name}={value}" for name, value in context.items())
                raise Stage2Error(
                    f"{path.relative_to(tree)} changes ProjectReference build context for "
                    f"{full_path}: {details}")
            pending.append(Path(full_path))
    if not gsharp_projects:
        raise Stage2Error("participating build closure contains no G# project")
    if gsharp_projects_out is not None:
        gsharp_projects_out.update(gsharp_projects)
    return sorted(path.relative_to(tree).as_posix() for path in seen)


def verify_resolved_sdk_payload(nupkg: Path, expected_sdk: Path) -> int:
    expected = {}
    with zipfile.ZipFile(nupkg) as archive:
        for info in archive.infolist():
            name = packer.entry_name(info.filename).lstrip("/")
            if info.is_dir() or not name.startswith(("Sdk/", "tools/", "build/")):
                continue
            expected[name] = hashlib.sha256(archive.read(info)).digest()
    actual = {}
    for root in ("Sdk", "tools", "build"):
        directory = expected_sdk / root
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if path.is_file():
                actual[path.relative_to(expected_sdk).as_posix()] = hashlib.sha256(path.read_bytes()).digest()
    if expected != actual:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(name for name in expected.keys() & actual.keys()
                         if expected[name] != actual[name])
        details = [*(f"missing {name}" for name in missing),
                   *(f"extra {name}" for name in extra),
                   *(f"changed {name}" for name in changed)]
        raise Stage2Error(
            f"resolved {packer.SDK_ID} payload does not match supplied {nupkg}:\n  "
            + "\n  ".join(details))
    return len(expected)


def add_toolchain_validation(parent: ET.Element, expected_sdk: Path) -> None:
    namespace = parent.tag[1:].split("}", 1)[0] if parent.tag.startswith("{") else ""
    tag = lambda name: f"{{{namespace}}}{name}" if namespace else name
    compiler = expected_sdk / "tools/compiler/gsc.dll"
    task = expected_sdk / "tools/task/Gsharp.NET.Sdk.dll"
    properties = ET.SubElement(parent, tag("PropertyGroup"))
    ET.SubElement(properties, tag("_Stage2ActualCompiler")).text = (
        "$([System.IO.Path]::GetFullPath('$(GsharpCompilerFullPath)'))")
    ET.SubElement(properties, tag("_Stage2ActualTool")).text = (
        "$([System.IO.Path]::GetFullPath('$(GsharpToolFullPath)'))")
    ET.SubElement(properties, tag("_Stage2ExpectedCompiler")).text = str(compiler)
    ET.SubElement(properties, tag("_Stage2ExpectedTool")).text = str(task)
    escaped_actual_compiler = "$([MSBuild]::Escape($(_Stage2ActualCompiler)))"
    escaped_expected_compiler = "$([MSBuild]::Escape($(_Stage2ExpectedCompiler)))"
    escaped_actual_tool = "$([MSBuild]::Escape($(_Stage2ActualTool)))"
    escaped_expected_tool = "$([MSBuild]::Escape($(_Stage2ExpectedTool)))"
    ET.SubElement(
        parent, tag("Error"),
        {"Condition": f"'{escaped_actual_compiler}' != '{escaped_expected_compiler}'",
         "Text": "stage-2 gate: CoreCompile used unexpected "
                 "GsharpCompilerFullPath=$(GsharpCompilerFullPath); "
                 "expected $(_Stage2ExpectedCompiler)"})
    ET.SubElement(
        parent, tag("Error"),
        {"Condition": f"'{escaped_actual_tool}' != '{escaped_expected_tool}'",
         "Text": "stage-2 gate: CoreCompile used unexpected "
                 "GsharpToolFullPath=$(GsharpToolFullPath); expected $(_Stage2ExpectedTool)"})


def toolchain_token(expected_sdk: Path) -> str:
    return hashlib.sha256(str(expected_sdk.resolve()).encode()).hexdigest()


def msbuild_escape(value: str) -> str:
    escaped = value.replace("%", "%25")
    for character in "$@';()*?":
        escaped = escaped.replace(character, f"%{ord(character):02X}")
    return escaped


def toolchain_guard(work: Path, stage: str, expected_sdk: Path,
                    gsharp_projects: set[Path] | None = None) -> Path:
    work.mkdir(parents=True, exist_ok=True)
    path = work / f"{stage}.toolchain-guard.targets"
    project = ET.Element("Project")
    token = toolchain_token(expected_sdk)
    identities = sorted(path.resolve() for path in (gsharp_projects or set()))
    applicability = " Or ".join(
        f"'$([MSBuild]::Escape($(MSBuildProjectFullPath)))' == "
        f"'{msbuild_escape(str(identity))}'"
        for identity in identities) or "false"
    target = ET.SubElement(
        project, "Target",
        {"Name": "_Stage2ValidateToolchain", "AfterTargets": "CoreCompile",
         "Condition": applicability})
    add_toolchain_validation(target, expected_sdk)
    ET.SubElement(
        target, "Error",
        {"Condition": f"'$(_Stage2GuardedCoreCompile)' != '{token}'",
         "Text": "stage-2 gate: effective CoreCompile did not invoke the guarded SDK BuildTask"})
    replace_xml(ET.ElementTree(project), path)
    return path


def install_sdk_task_guard(expected_sdk: Path) -> Path:
    path = expected_sdk / "build/Gsharp.NET.Core.Sdk.targets"
    try:
        document = ET.parse(path)
    except (ET.ParseError, OSError) as error:
        raise Stage2Error(f"cannot install task guard in {path}: {error}") from error
    root = document.getroot()
    namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)
    tag = lambda name: f"{{{namespace}}}{name}" if namespace else name
    token = toolchain_token(expected_sdk)
    for target in root.iter():
        if target.tag.rsplit("}", 1)[-1] != "Target" or target.attrib.get("Name") != "CoreCompile":
            continue
        children = list(target)
        for index, child in enumerate(children):
            if child.tag.rsplit("}", 1)[-1] != "BuildTask":
                continue
            holder = ET.Element(target.tag)
            add_toolchain_validation(holder, expected_sdk)
            ET.SubElement(
                holder, tag("Error"),
                {"Condition": "'$(SkipCompilerExecution)' == 'true'",
                 "Text": "stage-2 gate: SkipCompilerExecution cannot certify compilation"})
            marker = ET.SubElement(holder, tag("PropertyGroup"))
            ET.SubElement(marker, tag("_Stage2GuardedCoreCompile")).text = token
            target.remove(child)
            for offset, validation in enumerate(list(holder)):
                target.insert(index + offset, validation)
            target.insert(index + len(holder), child)
            replace_xml(document, path)
            return path
    raise Stage2Error(f"{path} has no CoreCompile BuildTask to guard")


def reject_feed_aliases(tree: Path, packages: set[Path]) -> None:
    feed = tree / ".nugs"
    for package in packages:
        destination = feed / package.name
        if destination.absolute() == package or not os.path.lexists(destination):
            continue
        if any(destination.samefile(other) for other in packages):
            raise Stage2Error(
                f"SDK feed destination aliases a supplied package: {destination}")


def build_stage(tree: Path, stage: str, nupkg: Path, projects: list[str], assemblies: list[str],
                work: Path, config: str, validation_projects: list[str] | None = None) -> dict:
    version = pin(tree, nupkg)
    env = stage_env(work, stage)
    cache = Path(env["NUGET_PACKAGES"])
    if cache.exists():
        shutil.rmtree(cache)
    expected_sdk = cache / packer.SDK_ID.lower() / version.lower()
    compiler = expected_sdk / "tools/compiler/gsc.dll"
    task = expected_sdk / "tools/task/Gsharp.NET.Sdk.dll"
    guard = toolchain_guard(work, stage, expected_sdk)
    global_properties = {
        "CustomAfterMicrosoftCommonTargets": guard,
        "GsharpCompilerFullPath": compiler,
        "GsharpToolFullPath": task,
    }
    gsharp_projects: set[Path] = set()
    participating = (validate_participating_projects(
        tree, validation_projects, env, config, version, global_properties,
        gsharp_projects) if validation_projects is not None else [])
    payload_files = (verify_resolved_sdk_payload(nupkg, expected_sdk)
                     if validation_projects is not None else 0)
    if validation_projects is not None:
        install_sdk_task_guard(expected_sdk)
        guard = toolchain_guard(work, stage, expected_sdk, gsharp_projects)
    clean_outputs(tree, assemblies)
    log = work / f"{stage}.build.log"
    replace_text(log, "")
    seconds = 0.0
    for project in projects:
        code, elapsed = run(
            ["dotnet", "build", project, "-c", config, "-t:Rebuild", "-nodeReuse:false",
             f"-p:CustomAfterMicrosoftCommonTargets={guard}",
             f"-p:GsharpCompilerFullPath={compiler}", f"-p:GsharpToolFullPath={task}"],
            tree, env, log)
        seconds += elapsed
        if code != 0:
            raise Stage2Error(f"{stage}: dotnet build {project} failed (exit {code}); see {log}")
    target = work / stage
    if target.exists():
        shutil.rmtree(target)
    copied = {}
    for index, assembly in enumerate(assemblies):
        source = tree / assembly
        if not source.is_file():
            raise Stage2Error(f"{stage}: expected output {assembly} was not produced")
        destination = target / f"{index}-{Path(assembly).name}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        pdb = source.with_suffix(".pdb")
        if pdb.is_file():
            shutil.copy2(pdb, destination.with_suffix(".pdb"))
        copied[assembly] = str(destination)
    return {"sdkVersion": version, "sdkPayloadFiles": payload_files,
            "participatingProjects": participating,
            "buildSeconds": round(seconds, 1), "assemblies": copied}


def content_hashes(paths: list[str], work: Path) -> dict[str, tuple[str, int]]:
    env = stage_env(work, "hash")
    result = subprocess.run(["dotnet", "run", str(HASH_TOOL), "--", *paths], cwd=HERE / "selfhost",
                            env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise Stage2Error("PeContentHash failed:\n" + result.stdout + result.stderr)
    hashes = {}
    for line in result.stdout.splitlines():
        digest, methods, path = line.split("  ", 2)
        hashes[path] = (digest, int(methods))
    return hashes


def file_sha256(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest().upper()


def compare(stage1: dict, stage2: dict, work: Path) -> list[dict]:
    paths = list(stage1["assemblies"].values()) + list(stage2["assemblies"].values())
    hashes = content_hashes(paths, work)
    rows = []
    for assembly, first in stage1["assemblies"].items():
        second = stage2["assemblies"][assembly]
        first_sha256 = file_sha256(first)
        second_sha256 = file_sha256(second)
        rows.append({
            "assembly": assembly,
            "stage1": {"sha256": first_sha256, "content": hashes[first][0], "methods": hashes[first][1]},
            "stage2": {"sha256": second_sha256, "content": hashes[second][0], "methods": hashes[second][1]},
            "contentEqual": hashes[first][0] == hashes[second][0],
            "bytesEqual": first_sha256 == second_sha256,
        })
    return rows


def run_tests(tree: Path, tests: list[str], work: Path, config: str,
              sdk_version: str) -> list[dict]:
    env = stage_env(work, "stage2")
    guard = work / "stage2.toolchain-guard.targets"
    if tests and not guard.is_file():
        raise Stage2Error(f"stage-2 toolchain guard is missing: {guard}")
    expected_sdk = Path(env["NUGET_PACKAGES"]) / packer.SDK_ID.lower() / sdk_version.lower()
    compiler = expected_sdk / "tools/compiler/gsc.dll"
    task = expected_sdk / "tools/task/Gsharp.NET.Sdk.dll"
    results = []
    for index, spec in enumerate(tests):
        project, _, test_filter = spec.partition("::")
        results_dir = work / f"test-{index}"
        if results_dir.exists():
            shutil.rmtree(results_dir)
        results_dir.mkdir()
        log = results_dir / "test.log"
        replace_text(log, "")
        command = ["dotnet", "test", project, "-c", config, "-nodeReuse:false",
                   f"-p:CustomAfterMicrosoftCommonTargets={guard}",
                   f"-p:GsharpCompilerFullPath={compiler}", f"-p:GsharpToolFullPath={task}",
                   "--logger", "trx", "--results-directory", str(results_dir)]
        if test_filter:
            command += ["--filter", test_filter]
        code, elapsed = run(command, tree, env, log)
        summary = [line.strip() for line in log.read_text(encoding="utf-8", errors="replace").splitlines()
                   if line.strip().startswith(("Passed!", "Failed!", "Total tests", "Passed:", "Failed:"))]
        executed, evidence_error = test_evidence(results_dir)
        results.append({"project": project, "filter": test_filter, "exitCode": code,
                        "seconds": round(elapsed, 1), "summary": summary[-3:],
                        "resultsDirectory": str(results_dir), "executedTests": executed,
                        "evidenceError": evidence_error})
    return results


def test_evidence(results_dir: Path) -> tuple[int, str | None]:
    files = sorted(results_dir.rglob("*.trx"))
    if not files:
        return 0, "no fresh TRX results"
    total = 0
    for path in files:
        try:
            summary = ET.parse(path).getroot().find("{*}ResultSummary")
            if summary is None:
                return total, f"{path.name}: missing test summary"
            counters = summary.find("{*}Counters")
            if counters is None:
                return total, f"{path.name}: missing test counters"
            executed, passed, failed = (int(counters.attrib[key]) for key in ("executed", "passed", "failed"))
            if summary.get("outcome") not in ("Completed", "Passed"):
                return total, f"{path.name}: test run did not complete successfully"
            if executed <= 0 or passed != executed or failed != 0:
                return total, f"{path.name}: no tests executed or not all executed tests passed"
            total += executed
        except (ET.ParseError, OSError, KeyError, ValueError) as error:
            return total, f"{path.name}: invalid test evidence ({error})"
    return total, None


def decide(report: dict) -> tuple[bool, bool]:
    """Equivalent only if every compared assembly's normalized image matches and
    at least one assembly was compared; requested tests need positive evidence."""
    rows = report["comparison"]
    equivalent = bool(rows) and all(row["contentEqual"] for row in rows)
    tests_passed = all(test["exitCode"] == 0 and test.get("executedTests", 0) > 0
                       and not test.get("evidenceError") for test in report["tests"])
    return equivalent, tests_passed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tree", required=True, type=Path)
    parser.add_argument("--bootstrap", required=True, type=Path, help="stage-0 Gsharp.NET.Sdk nupkg")
    parser.add_argument("--stage1", required=True, type=Path, help="stage-1 Gsharp.NET.Sdk nupkg")
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--project", action="append", help="tree-relative project to build (repeatable)")
    parser.add_argument("--assembly", action="append", help="tree-relative output assembly to compare (repeatable)")
    parser.add_argument("--test", action="append", default=[],
                        help="tree-relative test project, optionally '::<filter>', run under stage 2 (repeatable)")
    parser.add_argument("--config", default="Release")
    args = parser.parse_args(argv)

    tree, work = args.tree.resolve(), args.work.resolve()
    projects = args.project or DEFAULT_PROJECTS
    assemblies = args.assembly or [f"out/bin/{args.config}/Core/GSharp.Core.dll"]
    report: dict = {"tree": str(tree), "projects": projects}
    if tree == work or tree.is_relative_to(work) or work.is_relative_to(tree):
        print("selfhost-stage2: --tree and --work must be disjoint directories", file=sys.stderr)
        return 2
    work.mkdir(parents=True, exist_ok=True)
    try:
        bootstrap, stage1 = args.bootstrap.resolve(), args.stage1.resolve()
        if packer.package_version(stage1) == packer.package_version(bootstrap):
            raise Stage2Error("stage-1 and bootstrap SDK versions must differ")
        report["stage1PackageVerification"] = packer.verify(stage1, bootstrap)
        cleanup_roots = [(tree / "out").resolve()]
        cleanup_roots.extend((work / name).resolve()
                             for name in ("stage1", "stage2", "nuget-stage1", "nuget-stage2"))
        cleanup_roots.extend((work / f"test-{index}").resolve()
                             for index in range(len(args.test)))
        cleanup_files = {
            path
            for assembly in assemblies
            for path in ((tree / assembly).resolve(), (tree / assembly).resolve().with_suffix(".pdb"))
        }
        supplied_packages = {
            path.resolve()
            for package in (bootstrap, stage1)
            for path in packer.sibling_nupkgs(package, packer.package_version(package))
        }
        reject_feed_aliases(tree, supplied_packages)
        endangered = sorted(path for path in supplied_packages
                            if any(path.is_relative_to(root) for root in cleanup_roots)
                            or path in cleanup_files)
        if endangered:
            raise Stage2Error(
                "SDK package inputs overlap a cleaned stage-2 path:\n  "
                + "\n  ".join(str(path) for path in endangered))
        test_projects = [spec.partition("::")[0] for spec in args.test]
        report["stage1Build"] = build_stage(
            tree, "stage1", bootstrap, projects, assemblies, work, args.config, projects)
        report["stage2Build"] = build_stage(
            tree, "stage2", stage1, projects, assemblies, work, args.config,
            [*projects, *test_projects])
        report["comparison"] = compare(report["stage1Build"], report["stage2Build"], work)
        report["tests"] = run_tests(
            tree, args.test, work, args.config, report["stage2Build"]["sdkVersion"])
    except (Stage2Error, packer.SelfHostError, OSError) as error:
        report["error"] = str(error)
        replace_text(work / "stage2-report.json", json.dumps(report, indent=2) + "\n")
        print(f"selfhost-stage2: {error}", file=sys.stderr)
        return 2

    equivalent, tests_passed = decide(report)
    report["equivalent"] = equivalent
    report["testsPassed"] = tests_passed
    replace_text(work / "stage2-report.json", json.dumps(report, indent=2) + "\n")
    for row in report["comparison"]:
        verdict = "EQUAL" if row["contentEqual"] else "DIFFERENT"
        print(f"{verdict:9} {row['assembly']}: stage1 {row['stage1']['content'][:16]} "
              f"stage2 {row['stage2']['content'][:16]} (bytes {'equal' if row['bytesEqual'] else 'differ'})")
    for test in report["tests"]:
        print(f"tests {test['project']} [{test['filter']}]: exit {test['exitCode']}, "
              f"executed {test['executedTests']} {' | '.join(test['summary'])}"
              + (f"; {test['evidenceError']}" if test["evidenceError"] else ""))
    print("self-host stage 2: " + ("EQUIVALENT" if equivalent else "NOT EQUIVALENT")
          + ("" if tests_passed else "; TESTS FAILED"))
    return 0 if equivalent and tests_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
