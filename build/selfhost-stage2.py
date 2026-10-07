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
import re
import secrets
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
                     global_properties: dict[str, object] | None = None) -> dict:
    property_args = [f"-p:{name}={value}" for name, value in (global_properties or {}).items()]
    result = subprocess.run(
        ["dotnet", "msbuild", str(path.relative_to(tree)), "-nologo",
         "-getProperty:MSBuildAllProjects,GsharpCompilerFullPath,GsharpToolFullPath,"
         "TargetFrameworks,BuildProjectReferences,TargetPath,TargetRefPath,MSBuildToolsPath",
         "-getItem:ProjectReference,Compile,AdditionalFiles,EmbeddedResource,"
         "IntermediateAssembly,IntermediateRefAssembly",
         f"-p:Configuration={config}", *property_args, "-nodeReuse:false"],
        cwd=tree, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise Stage2Error(f"cannot evaluate participating project {path.relative_to(tree)}:\n"
                          + result.stdout + result.stderr)
    try:
        evaluation = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Stage2Error(f"invalid MSBuild evaluation for {path.relative_to(tree)}: {error}") from error
    preprocessed = subprocess.run(
        ["dotnet", "msbuild", str(path.relative_to(tree)), "-nologo", "-preprocess",
         f"-p:Configuration={config}", *property_args, "-nodeReuse:false"],
        cwd=tree, env=env, capture_output=True, text=True)
    if preprocessed.returncode != 0:
        raise Stage2Error(f"cannot preprocess participating project {path.relative_to(tree)}:\n"
                          + preprocessed.stdout + preprocessed.stderr)
    evaluation["_EvaluatedImports"] = [
        item.strip()
        for item in re.findall(
            r"(?:^|\r?\n)[ \t]*([^\r\n]+)\r?\n[ \t]*={20,}(?:\r?\n|$)",
            preprocessed.stdout)
        if Path(item.strip()).is_absolute() and Path(item.strip()).is_file()
    ]
    return evaluation


def inspect_msbuild_files(paths: list[Path], expected_sdk: Path,
                          msbuild_tools: Path | None = None,
                          trusted_files: set[Path] | None = None) -> None:
    immutable = {
        "BuildProjectReferences",
        "CustomAfterMicrosoftCommonTargets",
        "GsharpCompilerFullPath",
        "GsharpToolFullPath",
    }
    immutable_by_case = {name.casefold(): name for name in immutable}
    for path in paths:
        if not path.is_file():
            continue
        resolved = path.resolve()
        dotnet_root = msbuild_tools.parents[1] if msbuild_tools is not None else None
        trusted = (resolved.is_relative_to(expected_sdk)
                   or (dotnet_root is not None and resolved.is_relative_to(dotnet_root))
                   or resolved in (trusted_files or set()))
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError) as error:
            raise Stage2Error(f"cannot inspect evaluated MSBuild file {path}: {error}") from error
        local = {
            name.strip().casefold(): name.strip()
            for name in root.attrib.get("TreatAsLocalProperty", "").split(";")
            if name.strip()
        }
        forbidden = sorted(immutable_by_case[name] for name in local.keys() & immutable_by_case.keys())
        if forbidden:
            raise Stage2Error(
                f"{path} exempts immutable stage-2 properties via TreatAsLocalProperty: "
                + ", ".join(forbidden))
        if not trusted:
            target = next(
                (element for element in root.iter()
                 if element.tag.rsplit("}", 1)[-1] == "Target"),
                None)
            if target is not None:
                raise Stage2Error(
                    f"{path} defines untrusted MSBuild target {target.attrib.get('Name', '')!r}; "
                    "stage-2 certification permits targets only from trusted SDK inputs")
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "UsingTask":
                continue
            task_name = element.attrib.get("TaskName", "").strip()
            if not trusted:
                raise Stage2Error(
                    f"{path} registers untrusted MSBuild task {task_name}")
            short_name = task_name.rsplit(".", 1)[-1].casefold()
            if short_name not in {"buildtask", "error", "getfilehash", "writelinestofile"}:
                continue
            allowed = (expected_sdk if short_name == "buildtask" else msbuild_tools)
            if allowed is None or not path.resolve().is_relative_to(allowed):
                raise Stage2Error(
                    f"{path} registers {task_name} outside the verified SDK")


def validate_participating_projects(tree: Path, roots: list[str], env: dict,
                                    config: str, sdk_version: str,
                                    global_properties: dict[str, object] | None = None,
                                    gsharp_projects_out: set[Path] | None = None,
                                    protected_inputs_out: set[Path] | None = None,
                                    target_paths_out: dict[Path, Path] | None = None,
                                    reference_paths_out: dict[Path, Path] | None = None,
                                    project_references_out: dict[Path, list[Path]] | None = None,
                                    allow_disabled_references: bool = False,
                                    trusted_files: set[Path] | None = None
                                    ) -> list[str]:
    cache = Path(env["NUGET_PACKAGES"])
    expected_sdk = (cache / packer.SDK_ID.lower() / sdk_version.lower()).resolve()
    pending = [tree / root for root in roots]
    seen = set()
    gsharp_projects = set()
    protected_inputs = set()
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        if not path.is_relative_to(tree) or not path.is_file():
            raise Stage2Error(f"participating project must be an existing file under --tree: {path}")
        seen.add(path)
        protected_inputs.add(path)
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
        target_path = properties.get("TargetPath")
        if target_path and target_paths_out is not None:
            target_paths_out[path] = Path(target_path).resolve()
        target_ref_path = properties.get("TargetRefPath")
        if target_ref_path and reference_paths_out is not None:
            reference_paths_out[path] = Path(target_ref_path).resolve()
        if properties.get("TargetFrameworks"):
            raise Stage2Error(
                f"{path.relative_to(tree)} is multi-targeted; stage-2 preflight requires "
                "a single effective project context")
        import_items = evaluation.get("_EvaluatedImports")
        if import_items is None:  # Unit fixtures predating authoritative preprocessing.
            import_items = [
                item for item in properties.get("MSBuildAllProjects", "").split(";") if item
            ]
        imports = [Path(item).resolve() for item in import_items]
        protected_inputs.update(item for item in imports if not item.is_relative_to(cache))
        msbuild_tools = properties.get("MSBuildToolsPath")
        inspect_msbuild_files(
            [path, *imports], expected_sdk,
            Path(msbuild_tools).resolve() if msbuild_tools else None,
            trusted_files)
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
            gsharp_projects.add(path)
        references = evaluation.get("Items", {}).get("ProjectReference", [])
        if (references and not allow_disabled_references
                and properties.get("BuildProjectReferences", "").strip().casefold() == "false"):
            raise Stage2Error(
                f"{path.relative_to(tree)} disables ProjectReference builds via "
                "BuildProjectReferences=false")
        if (allow_disabled_references
                and properties.get("BuildProjectReferences", "").strip().casefold() != "false"):
            raise Stage2Error(
                f"{path.relative_to(tree)} did not preserve immutable "
                "BuildProjectReferences=false")
        enabled_references = []
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
            reference_path = Path(full_path).resolve()
            enabled_references.append(reference_path)
            pending.append(reference_path)
        if project_references_out is not None:
            project_references_out[path] = enabled_references
        for item_name in ("Compile", "AdditionalFiles", "EmbeddedResource"):
            for item in evaluation.get("Items", {}).get(item_name, []):
                item_path = item.get("FullPath") or item.get("Identity")
                if item_path:
                    candidate = Path(item_path)
                    protected_inputs.add(
                        (candidate if candidate.is_absolute() else path.parent / candidate).resolve())
    if not gsharp_projects:
        raise Stage2Error("participating build closure contains no G# project")
    if gsharp_projects_out is not None:
        gsharp_projects_out.update(gsharp_projects)
    if protected_inputs_out is not None:
        protected_inputs_out.update(protected_inputs)
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


def install_sdk_task_guard(expected_sdk: Path,
                           evidence: dict[Path, tuple[Path, str]] | None = None,
                           payload_hashes: dict[Path, str] | None = None) -> Path:
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
        receipt_properties = ET.Element(tag("PropertyGroup"))
        for project_path, (evidence_path, nonce) in sorted((evidence or {}).items()):
            condition = (
                "'$([MSBuild]::Escape($(MSBuildProjectFullPath)))' == "
                f"'{msbuild_escape(str(project_path.resolve()))}'")
            ET.SubElement(
                receipt_properties, tag("_Stage2EvidencePath"),
                {"Condition": condition}).text = str(evidence_path)
            ET.SubElement(
                receipt_properties, tag("_Stage2EvidenceNonce"),
                {"Condition": condition}).text = nonce
        root.insert(list(root).index(target), receipt_properties)
        target.attrib["Outputs"] = (
            target.attrib.get("Outputs", "") + ";$(_Stage2EvidencePath)")
        children = list(target)
        for index, child in enumerate(children):
            if child.tag.rsplit("}", 1)[-1] != "BuildTask":
                continue
            holder = ET.Element(target.tag)
            add_toolchain_validation(holder, expected_sdk)
            payload = ET.SubElement(holder, tag("ItemGroup"))
            for payload_path, digest in sorted((payload_hashes or {}).items()):
                item = ET.SubElement(payload, tag("_Stage2Payload"), {"Include": str(payload_path)})
                ET.SubElement(item, tag("ExpectedHash")).text = digest
            get_payload_hash = ET.SubElement(
                holder, tag("GetFileHash"),
                {"Files": "@(_Stage2Payload)", "Algorithm": "SHA256"})
            ET.SubElement(
                get_payload_hash, tag("Output"),
                {"TaskParameter": "Items", "ItemName": "_Stage2HashedPayload"})
            ET.SubElement(
                holder, tag("Error"),
                {"Condition": "'%(_Stage2HashedPayload.FileHash)' != "
                              "'%(_Stage2HashedPayload.ExpectedHash)'",
                 "Text": "stage-2 gate: verified SDK payload changed before compiler invocation: "
                         "%(_Stage2HashedPayload.Identity)"})
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
            get_output_hash = ET.Element(
                tag("GetFileHash"),
                {"Files": "@(IntermediateAssembly);@(IntermediateRefAssembly)",
                 "Algorithm": "SHA256",
                 "Condition": "'$(_Stage2EvidencePath)' != ''"})
            ET.SubElement(
                get_output_hash, tag("Output"),
                {"TaskParameter": "Items", "ItemName": "_Stage2CompiledAssembly"})
            receipt_elements = (
                get_output_hash,
                ET.Element(
                    tag("WriteLinesToFile"),
                    {
                        "Condition": "'$(_Stage2EvidencePath)' != ''",
                        "File": "$(_Stage2EvidencePath)",
                        "Lines": "@(_Stage2CompiledAssembly->"
                                 "'$(_Stage2EvidenceNonce)|%(FullPath)|%(FileHash)')",
                        "Overwrite": "true",
                    }))
            for offset, receipt_element in enumerate(receipt_elements):
                target.insert(index + len(holder) + 1 + offset, receipt_element)
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


def reject_cleanup_overlap(tree: Path, assemblies: list[str], protected_inputs: set[Path],
                           cleanup_roots: list[Path] | None = None,
                           cleanup_files_extra: set[Path] | None = None) -> None:
    roots = [(tree / "out").resolve(), *(cleanup_roots or [])]
    cleanup_files = {
        path
        for assembly in assemblies
        for path in ((tree / assembly).resolve(), (tree / assembly).with_suffix(".pdb").resolve())
    }
    cleanup_files.update(cleanup_files_extra or set())
    endangered = sorted(
        path for path in protected_inputs
        if any(path.is_relative_to(root) for root in roots) or path in cleanup_files)
    if endangered:
        raise Stage2Error(
            "participating build inputs overlap cleaned outputs:\n  "
            + "\n  ".join(str(path) for path in endangered))


def verify_compiler_evidence(projects: set[Path],
                             evidence: dict[Path, tuple[Path, str]],
                             target_paths: dict[Path, Path],
                             reference_paths: dict[Path, Path] | None = None) -> dict[Path, str]:
    verified = {}
    failures = []
    for project in sorted(projects):
        evidence_path, nonce = evidence[project]
        try:
            records = [
                line.split("|", 2)
                for line in evidence_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            if not records or any(len(record) != 3 or record[0] != nonce for record in records):
                raise ValueError
            actual_hashes = []
            for _actual_nonce, assembly_text, expected_hash in records:
                assembly = Path(assembly_text).resolve()
                actual_hash = hashlib.sha256(assembly.read_bytes()).hexdigest().upper()
                if actual_hash != expected_hash.upper():
                    raise ValueError
                actual_hashes.append(actual_hash)
            target = target_paths[project]
            target_hash = hashlib.sha256(target.read_bytes()).hexdigest().upper()
            if target_hash != actual_hashes[0]:
                raise ValueError
            reference = (reference_paths or {}).get(project)
            if reference is not None:
                if len(actual_hashes) < 2:
                    raise ValueError
                reference_hash = hashlib.sha256(reference.read_bytes()).hexdigest().upper()
                if reference_hash != actual_hashes[1]:
                    raise ValueError
            verified[project] = target_hash
        except (OSError, KeyError, ValueError):
            failures.append(project)
    if failures:
        raise Stage2Error(
            "compiler execution/output evidence invalid for:\n  "
            + "\n  ".join(str(path) for path in failures))
    return verified


def build_stage(tree: Path, stage: str, nupkg: Path, projects: list[str], assemblies: list[str],
                work: Path, config: str, validation_projects: list[str] | None = None,
                cleanup_roots: list[Path] | None = None) -> dict:
    version = pin(tree, nupkg)
    env = stage_env(work, stage)
    cache = Path(env["NUGET_PACKAGES"])
    expected_sdk = cache / packer.SDK_ID.lower() / version.lower()
    compiler = expected_sdk / "tools/compiler/gsc.dll"
    task = expected_sdk / "tools/task/Gsharp.NET.Sdk.dll"
    driver_files = {
        (work / f"{stage}.toolchain-guard.targets").resolve(),
        (work / f"{stage}.restore.log").resolve(),
        (work / f"{stage}.build.log").resolve(),
        (work / "stage2-report.json").resolve(),
    }
    if validation_projects is not None:
        preflight_env = dict(env)
        preflight_id = secrets.token_hex(16)
        preflight_cache = work / f"nuget-{stage}-preflight-{preflight_id}"
        preflight_env["NUGET_PACKAGES"] = str(preflight_cache)
        preflight_sdk = preflight_cache / packer.SDK_ID.lower() / version.lower()
        preflight_guard = toolchain_guard(
            work, f"{stage}.preflight-{preflight_id}", preflight_sdk)
        preflight_properties = {
            "CustomAfterMicrosoftCommonTargets": preflight_guard,
            "GsharpCompilerFullPath": preflight_sdk / "tools/compiler/gsc.dll",
            "GsharpToolFullPath": preflight_sdk / "tools/task/Gsharp.NET.Sdk.dll",
        }
        preflight_inputs: set[Path] = set()
        try:
            validate_participating_projects(
                tree, validation_projects, preflight_env, config, version, preflight_properties,
                protected_inputs_out=preflight_inputs, trusted_files={preflight_guard.resolve()})
            validate_participating_projects(
                tree, validation_projects, preflight_env, config, version,
                {**preflight_properties, "BuildProjectReferences": "false"},
                protected_inputs_out=preflight_inputs, allow_disabled_references=True,
                trusted_files={preflight_guard.resolve()})
            reject_cleanup_overlap(
                tree, assemblies, preflight_inputs,
                [*(cleanup_roots or []), preflight_cache.resolve()], driver_files)
        finally:
            preflight_guard.unlink(missing_ok=True)
            shutil.rmtree(preflight_cache, ignore_errors=True)
    guard = toolchain_guard(work, stage, expected_sdk)
    global_properties = {
        "CustomAfterMicrosoftCommonTargets": guard,
        "GsharpCompilerFullPath": compiler,
        "GsharpToolFullPath": task,
    }
    build_properties = {**global_properties, "BuildProjectReferences": "false"}
    if cache.exists():
        shutil.rmtree(cache)
    clean_outputs(tree, assemblies)
    restore_log = work / f"{stage}.restore.log"
    replace_text(restore_log, "")
    for project in dict.fromkeys(validation_projects or []):
        code, _elapsed = run(
            ["dotnet", "restore", project, "-nodeReuse:false",
             f"-p:Configuration={config}",
             f"-p:CustomAfterMicrosoftCommonTargets={guard}",
             f"-p:GsharpCompilerFullPath={compiler}", f"-p:GsharpToolFullPath={task}"],
            tree, env, restore_log)
        if code != 0:
            raise Stage2Error(
                f"{stage}: dotnet restore {project} failed (exit {code}); see {restore_log}")
    gsharp_projects: set[Path] = set()
    protected_inputs: set[Path] = set()
    target_paths: dict[Path, Path] = {}
    reference_paths: dict[Path, Path] = {}
    project_references: dict[Path, list[Path]] = {}
    participating = (validate_participating_projects(
        tree, validation_projects, env, config, version, global_properties,
        gsharp_projects, protected_inputs, target_paths, reference_paths,
        trusted_files={guard.resolve()})
        if validation_projects is not None else [])
    if validation_projects is not None:
        reject_cleanup_overlap(tree, assemblies, protected_inputs, cleanup_roots)
        compile_inputs: set[Path] = set()
        validate_participating_projects(
            tree, validation_projects, env, config, version, build_properties,
            gsharp_projects, compile_inputs, target_paths, reference_paths,
            project_references, allow_disabled_references=True,
            trusted_files={guard.resolve()})
        reject_cleanup_overlap(tree, assemblies, compile_inputs, cleanup_roots)
    validation_closures: dict[str, set[Path]] = {}
    for project in validation_projects or []:
        closure: set[Path] = set()
        validate_participating_projects(
            tree, [project], env, config, version, build_properties, closure, None,
            target_paths, reference_paths, allow_disabled_references=True,
            trusted_files={guard.resolve()})
        validation_closures[project] = closure
    payload_files = (verify_resolved_sdk_payload(nupkg, expected_sdk)
                     if validation_projects is not None else 0)
    if validation_projects is not None:
        evidence_dir = work / f"{stage}.compiler-evidence"
        if evidence_dir.exists():
            shutil.rmtree(evidence_dir)
        evidence_dir.mkdir()
        evidence = {
            project: (evidence_dir / f"{index}.txt", secrets.token_hex(32))
            for index, project in enumerate(sorted(gsharp_projects))
        }
        payload_hashes = {
            path: hashlib.sha256(path.read_bytes()).hexdigest().upper()
            for directory in (compiler.parent, task.parent)
            for path in directory.rglob("*")
            if path.is_file()
        }
        install_sdk_task_guard(expected_sdk, evidence, payload_hashes)
        guard = toolchain_guard(work, stage, expected_sdk, gsharp_projects)
    else:
        evidence = {}
    log = work / f"{stage}.build.log"
    replace_text(log, "")
    seconds = 0.0
    built_gsharp_projects: set[Path] = set()
    scheduled: list[Path] = []
    scheduled_once: set[Path] = set()

    def schedule_dependencies(project_path: Path) -> None:
        for dependency in project_references.get(project_path, []):
            schedule_dependencies(dependency)
            if dependency not in scheduled_once:
                scheduled.append(dependency)
                scheduled_once.add(dependency)

    for project in validation_projects or []:
        schedule_dependencies((tree / project).resolve())
    scheduled.extend((tree / project).resolve() for project in projects)
    for project_path in scheduled:
        project = project_path.relative_to(tree).as_posix()
        closure = {project_path} if project_path in gsharp_projects else set()
        for evidence_project in closure:
            evidence[evidence_project][0].unlink(missing_ok=True)
        code, elapsed = run(
            ["dotnet", "build", project, "-c", config, "-t:Rebuild", "--no-restore",
             "-nodeReuse:false",
             "-p:BuildProjectReferences=false",
             f"-p:CustomAfterMicrosoftCommonTargets={guard}",
             f"-p:GsharpCompilerFullPath={compiler}", f"-p:GsharpToolFullPath={task}"],
            tree, env, log)
        seconds += elapsed
        if code != 0:
            raise Stage2Error(f"{stage}: dotnet build {project} failed (exit {code}); see {log}")
        verify_compiler_evidence(closure, evidence, target_paths, reference_paths)
        built_gsharp_projects.update(closure)
    verify_compiler_evidence(
        built_gsharp_projects, evidence, target_paths, reference_paths)
    target = work / stage
    if target.exists():
        shutil.rmtree(target)
    copied = {}
    output_hashes = {}
    for index, assembly in enumerate(assemblies):
        source = tree / assembly
        if not source.is_file():
            raise Stage2Error(f"{stage}: expected output {assembly} was not produced")
        root_targets = {
            target_paths[(tree / project).resolve()]
            for project in projects
            if (tree / project).resolve() in target_paths
        }
        if root_targets and source.resolve() not in root_targets:
            raise Stage2Error(
                f"{stage}: requested snapshot {source} is not a built root TargetPath")
        destination = target / f"{index}-{Path(assembly).name}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        pdb = source.with_suffix(".pdb")
        if pdb.is_file():
            shutil.copy2(pdb, destination.with_suffix(".pdb"))
        copied[assembly] = str(destination)
        output_hashes[str(source.resolve())] = file_sha256(str(destination))
    return {"sdkVersion": version, "sdkPayloadFiles": payload_files,
            "participatingProjects": participating,
            "buildSeconds": round(seconds, 1), "assemblies": copied,
            "compilerEvidence": {
                str(project): {"path": str(path), "nonce": nonce,
                               "targetPath": str(target_paths[project]),
                               "referencePath": str(reference_paths[project])
                               if project in reference_paths else None}
                for project, (path, nonce) in evidence.items()
            },
            "comparedOutputHashes": output_hashes,
            "gsharpClosures": {
                project: [str(path) for path in sorted(closure)]
                for project, closure in validation_closures.items()
            }}


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
              sdk_version: str, stage: dict | None = None) -> list[dict]:
    env = stage_env(work, "stage2")
    guard = work / "stage2.toolchain-guard.targets"
    if tests and not guard.is_file():
        raise Stage2Error(f"stage-2 toolchain guard is missing: {guard}")
    expected_sdk = Path(env["NUGET_PACKAGES"]) / packer.SDK_ID.lower() / sdk_version.lower()
    compiler = expected_sdk / "tools/compiler/gsc.dll"
    task = expected_sdk / "tools/task/Gsharp.NET.Sdk.dll"
    results = []
    evidence = {
        Path(project): (Path(item["path"]), item["nonce"])
        for project, item in (stage or {}).get("compilerEvidence", {}).items()
    }
    target_paths = {
        Path(project): Path(item["targetPath"])
        for project, item in (stage or {}).get("compilerEvidence", {}).items()
    }
    reference_paths = {
        Path(project): Path(item["referencePath"])
        for project, item in (stage or {}).get("compilerEvidence", {}).items()
        if item.get("referencePath")
    }
    compared_output_hashes = {
        Path(path): digest
        for path, digest in (stage or {}).get("comparedOutputHashes", {}).items()
    }
    closures = {
        project: {Path(path) for path in closure}
        for project, closure in (stage or {}).get("gsharpClosures", {}).items()
    }
    for index, spec in enumerate(tests):
        project, _, test_filter = spec.partition("::")
        results_dir = work / f"test-{index}"
        if results_dir.exists():
            shutil.rmtree(results_dir)
        results_dir.mkdir()
        log = results_dir / "test.log"
        replace_text(log, "")
        command = ["dotnet", "test", project, "-c", config, "--no-restore", "-nodeReuse:false",
                   "-p:BuildProjectReferences=false",
                   f"-p:CustomAfterMicrosoftCommonTargets={guard}",
                   f"-p:GsharpCompilerFullPath={compiler}", f"-p:GsharpToolFullPath={task}",
                   "--logger", "trx", "--results-directory", str(results_dir)]
        if test_filter:
            command += ["--filter", test_filter]
        closure = closures.get(project, set())
        root = (tree / project).resolve()
        if root in closure:
            evidence[root][0].unlink(missing_ok=True)
        code, elapsed = run(command, tree, env, log)
        if closure:
            verify_compiler_evidence(
                closure, evidence, target_paths, reference_paths)
        changed_outputs = [
            path for path, digest in compared_output_hashes.items()
            if not path.is_file() or file_sha256(str(path)) != digest
        ]
        if changed_outputs:
            raise Stage2Error(
                "test build changed compared stage-2 outputs:\n  "
                + "\n  ".join(str(path) for path in changed_outputs))
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
                             for name in ("stage1", "stage2", "nuget-stage1", "nuget-stage2",
                                          "stage1.compiler-evidence", "stage2.compiler-evidence"))
        cleanup_roots.extend((work / f"test-{index}").resolve()
                             for index in range(len(args.test)))
        cleanup_files = {
            path
            for assembly in assemblies
            for path in ((tree / assembly).resolve(), (tree / assembly).with_suffix(".pdb").resolve())
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
            tree, "stage1", bootstrap, projects, assemblies, work, args.config,
            [*projects, *test_projects], cleanup_roots)
        report["stage2Build"] = build_stage(
            tree, "stage2", stage1, projects, assemblies, work, args.config,
            [*projects, *test_projects], cleanup_roots)
        report["comparison"] = compare(report["stage1Build"], report["stage2Build"], work)
        report["tests"] = run_tests(
            tree, args.test, work, args.config, report["stage2Build"]["sdkVersion"],
            report["stage2Build"])
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
