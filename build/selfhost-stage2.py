#!/usr/bin/env python3
"""ADR-0198 isolated stage-2 self-host certification controller.

The controller owns every mutable root, snapshots the caller tree once, runs
MSBuild in a bubblewrap boundary, produces stage 1 inside the run, and accepts
stage outputs only after graph, command, and byte evidence revalidation.
"""

from __future__ import annotations

import argparse
import base64
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
_PACKER_SPEC = importlib.util.spec_from_file_location(
    "selfhost_pack_stage1", HERE / "selfhost-pack-stage1.py")
if _PACKER_SPEC is None or _PACKER_SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-pack-stage1.py")
packer = importlib.util.module_from_spec(_PACKER_SPEC)
_PACKER_SPEC.loader.exec_module(packer)

from selfhost_pe import PeError, compare as compare_pe

SDK_ID = "Gsharp.NET.Sdk"
PACKAGE_COMPONENT_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*$")
DEFAULT_PROJECTS = ("src/Core/Core.gsproj", "src/Compiler/Compiler.gsproj")
DEFAULT_ASSEMBLIES = (
    "Core/GSharp.Core.dll",
    "Compiler/gsc.dll",
)
PACK_DEPENDENCIES = (
    Path("src/Compiler/Compiler.gsproj"),
    Path("src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj"),
    Path("src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"),
    Path("src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj"),
    Path("tools/gsgen/Gsgen.Cli/Gsgen.Cli.gsproj"),
)
INPUT_ITEMS = (
    "Compile", "Reference", "Analyzer", "GsharpCodeAnalyzer",
    "AdditionalFiles", "EmbeddedResource", "Content", "None",
    "ProjectReference",
)
PROTECTED_PROPERTIES = {
    "buildprojectreferences", "customaftermicrosoftcommontargets",
    "gsharpcompilerfullpath", "gsharptoolfullpath",
    "baseoutputpath", "baseintermediateoutputpath",
    "outdir", "outputpath", "intermediateoutputpath",
    "msbuildprojectextensionspath", "restorepackagespath",
    "restoreprojectreferences", "restorerecursive",
    "vstesttestcasefilter", "vstestlogger", "vstesttestadapterpath",
}
ALLOWED_PROJECT_TARGETS = {
    ("src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj",
     "_GsharpExtensionsResetCompileItems"),
    *{
        ("src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj", name)
        for name in (
            "PackGsharpBuildTask", "PackGsharpCompiler", "PackGsharpFormatter",
            "PackGsgen", "PackGsharpHotReloadRuntime",
            "PackGsharpChannelsRuntime", "PackGsharpValuesRuntime",
            "PackGsharpExtensions",
        )
    },
}
ALLOWED_IMPORT_TARGETS = {
    ("build/gsharp.props", "InitGsharpProps"),
    ("build/notest.targets", "VSTest"),
    *{
        ("src/Sdk/Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets", name)
        for name in (
            "_GsharpCreateCoreCompileInputsCache", "CoreCompile",
            "_PopulateGsharpDocFileItems", "CreateManifestResourceNames",
        )
    },
}
ALLOWED_IMPORT_TASKS = {
    (
        "src/Sdk/Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets",
        "Gsharp.NET.Sdk.Tools.BuildTask",
    ),
}


class CertificationError(Exception):
    pass


@dataclass(frozen=True)
class FileIdentity:
    path: str
    mode: int
    size: int
    sha256: str


@dataclass(frozen=True)
class CommandResult:
    receipt: str
    exit_code: int
    duration_seconds: float
    stdout_sha256: str
    events: str | None = None
    event_key: bytes | None = None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def authenticated_events(data: bytes, key: bytes) -> list[dict[str, Any]]:
    events = []
    for expected_sequence, line in enumerate(data.splitlines()):
        try:
            envelope = json.loads(line)
            sequence = int(envelope["sequence"])
            payload_json = envelope["payload"]
            mac = envelope["mac"]
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise CertificationError("invalid authenticated test event") from error
        if not isinstance(payload_json, str):
            raise CertificationError("invalid authenticated test event payload")
        payload_bytes = payload_json.encode()
        expected = hmac.new(
            key, str(sequence).encode() + b"\n" + payload_bytes,
            hashlib.sha256).hexdigest()
        if sequence != expected_sequence or not hmac.compare_digest(mac, expected):
            raise CertificationError("forged or replayed test supervisor event")
        events.append(json.loads(payload_json))
    return events


def verify_receipt_set(
    run_id: str, paths: list[Path],
    expected_hashes: dict[str, str] | None = None,
    expectations: dict[str, dict[str, Any]] | None = None,
) -> None:
    seen_paths: set[Path] = set()
    seen_nonces: set[str] = set()
    for path in paths:
        if path in seen_paths:
            raise CertificationError(f"replayed command receipt: {path}")
        seen_paths.add(path)
        if not path.is_file():
            raise CertificationError(f"command receipt is missing: {path}")
        expected_hash = (expected_hashes or {}).get(str(path))
        if expected_hash is not None and sha256_file(path) != expected_hash:
            raise CertificationError(f"command receipt changed: {path}")
        receipt = json.loads(path.read_text(encoding="utf-8"))
        if receipt.get("runId") != run_id or receipt.get("exitCode") != 0:
            raise CertificationError(f"stale or failed command receipt: {path}")
        expected = (expectations or {}).get(str(path))
        if expected is not None and any(
                receipt.get(key) != value for key, value in expected.items()):
            raise CertificationError(f"mismatched command receipt: {path}")
        nonce = receipt.get("nonceCommitment")
        if (not isinstance(nonce, str) or len(nonce) != 64
                or nonce in seen_nonces):
            raise CertificationError(f"replayed command receipt: {path}")
        seen_nonces.add(nonce)
        if (not isinstance(receipt.get("pid"), int) or receipt["pid"] <= 0
                or not isinstance(receipt.get("arguments"), list)
                or not receipt["arguments"]
                or not receipt.get("sandboxArgumentsSha256")
                or not receipt.get("graphIdentity")
                or receipt.get("completedNs", 0) < receipt.get("startedNs", 0)):
            raise CertificationError(f"incomplete command receipt: {path}")
        stdout = receipt.get("stdout", {})
        stdout_path = Path(stdout.get("path", ""))
        if (not stdout_path.is_file()
                or sha256_file(stdout_path) != stdout.get("sha256")):
            raise CertificationError(f"command log changed: {stdout_path}")
        for output in receipt.get("outputs", []):
            target = Path(output["path"])
            if (not target.is_file()
                    or target.stat().st_size != output["size"]
                    or sha256_file(target) != output["sha256"]):
                raise CertificationError(
                    f"receipt output changed after command: {target}")
        events = receipt.get("events")
        if events is not None:
            event_path = Path(events["path"])
            if (not event_path.is_file()
                    or sha256_file(event_path) != events["sha256"]):
                raise CertificationError(
                    f"test supervisor evidence changed: {event_path}")


def atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise CertificationError(f"refusing unsafe controller destination {path}")
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.new")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path: Path, value: Any) -> None:
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def real(path: Path) -> Path:
    return Path(os.path.realpath(path))


def reject_path_alias(label: str, path: Path) -> None:
    lexical = Path(os.path.abspath(path))
    for component in (lexical, *lexical.parents):
        if component.is_symlink():
            raise CertificationError(f"{label} uses a symbolic-link path: {component}")


def contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def reject_root_collisions(named: dict[str, Path]) -> None:
    resolved = {name: real(path) for name, path in named.items()}
    for name, path in resolved.items():
        if path.exists() and path.is_symlink():
            raise CertificationError(f"{name} is a symbolic link: {path}")
    pairs = list(resolved.items())
    for index, (left_name, left) in enumerate(pairs):
        for right_name, right in pairs[index + 1:]:
            if left == right or contains(left, right) or contains(right, left):
                raise CertificationError(
                    f"{left_name} and {right_name} are not disjoint: {left} / {right}")


def git_snapshot_paths(tree: Path) -> tuple[list[Path], dict[str, str] | None]:
    probe = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True)
    if probe.returncode != 0 or real(Path(probe.stdout.strip())) != real(tree):
        paths = [
            path for path in tree.rglob("*")
            if ".git" not in path.relative_to(tree).parts and path.is_file()
        ]
        return sorted(paths), None
    status_result = subprocess.run(
        ["git", "-C", str(tree), "status", "--porcelain=v1", "--untracked-files=all"],
        capture_output=True, text=True, check=True)
    if status_result.stdout:
        raise CertificationError(
            "caller tree is dirty or has untracked files:\n" + status_result.stdout.rstrip())
    names = subprocess.run(
        ["git", "-C", str(tree), "ls-files", "-z", "--recurse-submodules"],
        capture_output=True, check=True).stdout.split(b"\0")
    paths = [tree / os.fsdecode(name) for name in names if name]
    commit = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True).stdout.strip()
    git_tree = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", "HEAD^{tree}"],
        capture_output=True, text=True, check=True).stdout.strip()
    return paths, {"commit": commit, "tree": git_tree}


def identity(tree: Path, path: Path) -> FileIdentity:
    relative = path.relative_to(tree).as_posix()
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise CertificationError(f"symbolic links are unsupported in v1: {relative}")
    if not stat.S_ISREG(info.st_mode):
        raise CertificationError(f"non-regular participating input: {relative}")
    if info.st_nlink != 1:
        raise CertificationError(f"hard-linked participating input: {relative}")
    return FileIdentity(
        relative, stat.S_IMODE(info.st_mode), info.st_size, sha256_file(path))


def owned_file(path: Path, label: str) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise CertificationError(f"{label} is not a single-link regular file: {path}")
    return info


def freeze_source(caller: Path, snapshot: Path) -> tuple[list[FileIdentity], dict[str, str] | None]:
    paths, git_identity = git_snapshot_paths(caller)
    manifest = [identity(caller, path) for path in paths]
    snapshot.mkdir()
    for row in manifest:
        source = caller / row.path
        destination = snapshot / row.path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        os.chmod(destination, row.mode)
    copied = [identity(snapshot, snapshot / row.path) for row in manifest]
    if copied != manifest:
        raise CertificationError("caller tree changed while the immutable snapshot was copied")
    make_read_only(snapshot)
    frozen = [identity(snapshot, snapshot / row.path) for row in manifest]
    verify_manifest(snapshot, frozen)
    return frozen, git_identity


def verify_manifest(root: Path, expected: list[FileIdentity]) -> None:
    try:
        actual = [identity(root, root / row.path) for row in expected]
    except OSError as error:
        raise CertificationError(
            f"immutable source manifest changed under {root}") from error
    if actual != expected:
        raise CertificationError(f"immutable source manifest changed under {root}")


def make_read_only(root: Path) -> None:
    for path in sorted(root.rglob("*"), reverse=True):
        mode = path.stat().st_mode
        os.chmod(path, mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
    os.chmod(root, root.stat().st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def clone_snapshot(snapshot: Path, destination: Path) -> None:
    shutil.copytree(snapshot, destination, copy_function=shutil.copyfile)
    for path in [destination, *destination.rglob("*")]:
        if path.is_dir():
            os.chmod(path, path.stat().st_mode | stat.S_IWUSR)
        elif path.is_file():
            os.chmod(path, path.stat().st_mode | stat.S_IWUSR)


def package_version(path: Path) -> str:
    try:
        return packer.package_version(path)
    except packer.SelfHostError as error:
        raise CertificationError(str(error)) from error


def package_component(value: Any, label: str) -> str:
    if not isinstance(value, str) or not PACKAGE_COMPONENT_RE.fullmatch(value):
        raise CertificationError(f"unsafe package {label}: {value!r}")
    return value


def extract_verified_package(
    source: Path, destination: Path, content_hash: str | None = None,
) -> Path:
    nupkgs = list(source.glob("*.nupkg"))
    hash_files = list(source.glob("*.nupkg.sha512"))
    if len(nupkgs) != 1 or len(hash_files) != 1:
        raise CertificationError(
            f"package cache entry must contain one nupkg and hash: {source}")
    package_hash = base64.b64encode(
        hashlib.sha512(nupkgs[0].read_bytes()).digest()).decode()
    if hash_files[0].read_text(encoding="utf-8").strip() != package_hash:
        raise CertificationError(f"package archive hash is invalid: {source}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    with zipfile.ZipFile(nupkgs[0]) as archive:
        for info in archive.infolist():
            name = Path(packer.entry_name(info.filename))
            if info.is_dir():
                continue
            if name.is_absolute() or ".." in name.parts:
                raise CertificationError(f"unsafe package entry {info.filename}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))
    atomic_bytes(destination / nupkgs[0].name, nupkgs[0].read_bytes())
    atomic_bytes(
        destination / hash_files[0].name, (package_hash + "\n").encode())
    atomic_json(destination / ".nupkg.metadata", {
        "version": 2,
        "contentHash": content_hash or package_hash,
        "source": "adr0198-controller",
    })
    return nupkgs[0]


def probe_sandbox(tree: Path, writable: Path, denied: list[Path]) -> None:
    state = writable.parent / "controller-probe"
    toolchain = state / "toolchains" / "probe"
    offline_feed = state / "mutable" / "probe" / "offline-feed"
    temp = state / "mutable" / "probe" / "runtime" / "temp"
    for path in (writable, toolchain, offline_feed, temp):
        path.mkdir(parents=True, exist_ok=True)
    controller = object.__new__(Controller)
    controller.mutable = state / "mutable"
    controller.toolchains = state / "toolchains"
    script = [
        "set -eu",
        f"! touch {shlex.quote(str(tree / 'forbidden-write'))}",
        'test -z "${ADR0198_PROBE_SECRET-}"',
        f"touch {shlex.quote(str(writable / 'allowed-write'))}",
    ]
    for path in denied:
        script.append(f"test ! -e {shlex.quote(str(path))}")
        script.append(f"! touch {shlex.quote(str(path))}")
    script.append(
        "! /usr/bin/python3 -c "
        + shlex.quote(
            "import socket; socket.create_connection(('1.1.1.1', 53), 0.2)"))
    command = ["/bin/sh", "-c", "; ".join(script)]
    env = {
        "ADR0198_STAGE": "probe",
        "PATH": "/usr/bin:/bin",
        "HOME": str(writable),
        "TMPDIR": str(temp),
        "TEMP": str(temp),
        "TMP": str(temp),
    }
    result = subprocess.run(
        controller.sandbox_command(tree, [writable], command, env),
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "ADR0198_PROBE_SECRET": "must-not-cross"})
    if result.returncode != 0:
        raise CertificationError(
            "sandbox probe failed:\n" + result.stdout + result.stderr)


def package_payload_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as archive:
        names = sorted(name for name in archive.namelist() if not name.endswith("/"))
        for name in names:
            encoded = name.encode()
            data = archive.read(name)
            digest.update(len(encoded).to_bytes(4, "little"))
            digest.update(encoded)
            digest.update(len(data).to_bytes(8, "little"))
            digest.update(hashlib.sha256(data).digest())
    return digest.hexdigest()


def verify_resolved_sdk_payload(package: Path, resolved: Path) -> str:
    expected: dict[str, str] = {}
    with zipfile.ZipFile(package) as archive:
        for info in archive.infolist():
            name = packer.entry_name(info.filename).lstrip("/")
            if info.is_dir() or not name.startswith(("Sdk/", "tools/", "build/")):
                continue
            expected[name] = sha256_bytes(archive.read(info))
    actual: dict[str, str] = {}
    for root in ("Sdk", "tools", "build"):
        directory = resolved / root
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if path.is_file():
                actual[path.relative_to(resolved).as_posix()] = sha256_file(path)
    if expected != actual:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(
            name for name in expected.keys() & actual.keys()
            if expected[name] != actual[name])
        details = [
            *(f"missing {name}" for name in missing),
            *(f"extra {name}" for name in extra),
            *(f"changed {name}" for name in changed),
        ]
        raise CertificationError(
            "resolved Gsharp.NET.Sdk payload differs from the accepted package:\n  "
            + "\n  ".join(details))
    return sha256_bytes(
        json.dumps(actual, sort_keys=True, separators=(",", ":")).encode())


def pin_matches(tree: Path, version: str) -> None:
    path = tree / "global.json"
    if not path.is_file():
        raise CertificationError("source snapshot has no global.json")
    try:
        document = json.loads(packer.strip_json_comments(path.read_text(encoding="utf-8-sig")))
        pins = document["msbuild-sdks"]
    except (KeyError, TypeError, ValueError) as error:
        raise CertificationError("global.json has no usable msbuild-sdks map") from error
    selected = [value for name, value in pins.items() if name.casefold() == SDK_ID.casefold()]
    if selected != [version]:
        raise CertificationError(
            f"source global.json must already pin {SDK_ID}/{version}; got {selected}")


def atomic_pin(tree: Path, version: str) -> None:
    path = tree / "global.json"
    if path.is_symlink() or path.stat().st_nlink != 1:
        raise CertificationError("global.json is aliased")
    raw = path.read_bytes()
    document = json.loads(packer.strip_json_comments(raw.decode("utf-8-sig")))
    pins = document.setdefault("msbuild-sdks", {})
    if not isinstance(pins, dict):
        raise CertificationError("global.json msbuild-sdks is not an object")
    for name in [name for name in pins if name.casefold() == SDK_ID.casefold()]:
        del pins[name]
    pins[SDK_ID] = version
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    atomic_bytes(path, bom + (json.dumps(document, indent=2) + "\n").encode())


def stage_package(tree: Path, package: Path) -> Path:
    feed = tree / ".nugs"
    feed.mkdir(exist_ok=True)
    destination = feed / package.name
    if destination.exists() and (destination.is_symlink() or destination.stat().st_nlink != 1):
        raise CertificationError(f"package feed destination is aliased: {destination}")
    atomic_bytes(destination, package.read_bytes())
    return destination


def reject_secret_restore_configuration(tree: Path) -> None:
    secret_words = re.compile(
        r"(ClearTextPassword|Password|Token|ApiKey|Username|ValidAuthenticationTypes)",
        re.IGNORECASE)
    for name in ("nuget.config", "NuGet.Config"):
        for path in tree.rglob(name):
            text = path.read_text(encoding="utf-8-sig", errors="replace")
            if secret_words.search(text):
                raise CertificationError(
                    f"secret-bearing restore configuration is unsupported in v1: {path.relative_to(tree)}")


def inspect_sdk_declarations(relative: str, root: ET.Element) -> None:
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        declarations = element.attrib.get("Sdk", "").split(";")
        if tag == "Sdk":
            declarations.append(element.attrib.get("Name", ""))
        for declaration in declarations:
            name, slash, selected = declaration.strip().partition("/")
            version = selected if slash else element.attrib.get("Version", "")
            if name.casefold() == SDK_ID.casefold() and version:
                raise CertificationError(
                    f"{relative} overrides the global SDK pin with {name}/{version}")


def inspect_project_xml(tree: Path, path: Path) -> None:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        raise CertificationError(f"cannot inspect {path}: {error}") from error
    local = {
        name.strip().casefold()
        for name in root.attrib.get("TreatAsLocalProperty", "").split(";")
        if name.strip()
    }
    forbidden = sorted(local & PROTECTED_PROPERTIES)
    if forbidden:
        raise CertificationError(
            f"{path.relative_to(tree)} exempts protected properties: {', '.join(forbidden)}")
    relative = path.relative_to(tree).as_posix()
    inspect_sdk_declarations(relative, root)
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "UsingTask":
            raise CertificationError(f"unmodeled project task in {relative}")
        if tag == "Target":
            target = element.attrib.get("Name", "")
            if (relative, target) not in ALLOWED_PROJECT_TARGETS:
                raise CertificationError(f"unmodeled project target {target!r} in {relative}")

def inspect_repository_import(
    tree: Path, path: Path, external: bool = False,
) -> dict[str, list[dict[str, str]]]:
    relative = str(path) if external else path.relative_to(tree).as_posix()
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        raise CertificationError(f"cannot inspect import {relative}: {error}") from error
    inspect_sdk_declarations(relative, root)
    inventory: dict[str, list[dict[str, str]]] = {"targets": [], "tasks": []}
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "Target":
            target = element.attrib.get("Name", "")
            if not external and (relative, target) not in ALLOWED_IMPORT_TARGETS:
                raise CertificationError(
                    f"unmodeled imported target {target!r} in {relative}")
            inventory["targets"].append({"name": target})
        elif tag == "UsingTask":
            task = element.attrib.get("TaskName", "")
            if not external and (relative, task) not in ALLOWED_IMPORT_TASKS:
                raise CertificationError(f"unmodeled imported task {task!r} in {relative}")
            inventory["tasks"].append({
                "name": task,
                "assemblyFile": element.attrib.get("AssemblyFile", ""),
                "assemblyName": element.attrib.get("AssemblyName", ""),
            })
    return inventory


def dotnet_root() -> Path:
    executable = real(Path(shutil.which("dotnet") or ""))
    if not executable.is_file():
        raise CertificationError("dotnet executable not found")
    return executable.parent


class Controller:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.lexical_roots = {
            "caller tree": args.tree,
            "bootstrap package": args.bootstrap,
            "package cache": args.package_cache,
            "controller work": args.work,
        }
        self.caller = real(args.tree)
        self.bootstrap = real(args.bootstrap)
        self.package_cache = real(args.package_cache)
        self.work = real(args.work)
        self.source = self.work / "source"
        self.stage1 = self.work / "stage-1"
        self.stage2 = self.work / "stage-2"
        self.evidence = self.work / "evidence"
        self.reports = self.work / "reports"
        self.logs = self.work / "logs"
        self.mutable = self.work / "mutable"
        self.toolchains = self.work / "toolchains"
        self.dotnet = real(Path(shutil.which("dotnet") or ""))
        self.run_id = secrets.token_hex(16)
        self.report: dict[str, Any] = {
            "schema": 1, "runId": self.run_id, "configuration": args.config,
            "projects": args.project or list(DEFAULT_PROJECTS),
            "assemblies": args.assembly or list(DEFAULT_ASSEMBLIES),
            "tests": args.test,
        }
        self.stage_packages: dict[str, Path] = {}
        self.accepted_restore_outputs: dict[str, dict[str, str]] = {}
        self.accepted_build_outputs: dict[str, dict[str, dict[str, str]]] = {}
        self.receipts: list[tuple[Path, str]] = []
        self.receipt_expectations: dict[str, dict[str, Any]] = {}

    def preflight(self) -> None:
        for label, path in self.lexical_roots.items():
            reject_path_alias(label, path)
        if not self.caller.is_dir():
            raise CertificationError(f"caller tree does not exist: {self.caller}")
        if not self.bootstrap.is_file():
            raise CertificationError(f"bootstrap package does not exist: {self.bootstrap}")
        if self.args.stage1_version is not None:
            if not packer.VERSION_RE.fullmatch(self.args.stage1_version):
                raise CertificationError(
                    f"--stage1-version {self.args.stage1_version!r} "
                    "is not a valid package version")
        if self.bootstrap.stat().st_nlink != 1:
            raise CertificationError("bootstrap package is hard-linked")
        if self.work.exists():
            raise CertificationError("--work must name a new controller-owned directory")
        if self.work.parent.is_symlink():
            raise CertificationError("--work parent is a symbolic link")
        reject_root_collisions({
            "caller tree": self.caller,
            "bootstrap package": self.bootstrap,
            "package cache": self.package_cache,
            "controller work": self.work,
        })
        if not self.package_cache.is_dir():
            raise CertificationError(f"package cache does not exist: {self.package_cache}")
        if shutil.which("bwrap") is None:
            raise CertificationError("bubblewrap is required for the ADR-0198 restricted boundary")
        for name in self.report["assemblies"]:
            path = Path(name)
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise CertificationError(
                    f"assembly path must be relative to the stage output root: {name}")
        for label, values in (
            ("project", self.report["projects"]),
            ("assembly", self.report["assemblies"]),
            ("test", self.report["tests"]),
        ):
            if len(values) != len(set(values)):
                raise CertificationError(f"repeated --{label} values are not allowed")
        self.work.mkdir(mode=0o700)
        for path in (self.evidence, self.reports, self.logs, self.mutable, self.toolchains):
            path.mkdir(mode=0o700)
        self.freeze_bootstrap()
        if self.args.stage1_version == package_version(self.bootstrap):
            raise CertificationError(
                "the stage-1 version must differ from the bootstrap version")

    def freeze_bootstrap(self) -> None:
        source = self.bootstrap
        destination = self.toolchains / "controller-inputs" / source.name
        atomic_bytes(destination, source.read_bytes())
        make_read_only(destination.parent)
        self.bootstrap = destination
        self.report["bootstrap"] = {
            "source": str(source),
            "snapshot": str(destination),
            "sha256": sha256_file(destination),
        }

    def writable(self, stage: str, purpose: str) -> Path:
        path = self.mutable / stage / purpose
        path.mkdir(parents=True, exist_ok=True)
        return path

    def stage_toolchain(self, stage: str) -> Path:
        return self.toolchains / stage

    def stage_dotnet(self, stage: str) -> Path:
        return self.stage_toolchain(stage) / "dotnet"

    def offline_feed(self, stage: str) -> Path:
        path = self.mutable / stage / "offline-feed"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def write_offline_config(self, stage: str) -> Path:
        feed = self.offline_feed(stage)
        config = feed / "NuGet.Config"
        atomic_bytes(config, (
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
            "<configuration><packageSources><clear />"
            f"<add key=\"adr0198\" value=\"{feed}\" />"
            "</packageSources></configuration>\n"
        ).encode())
        return config

    def sandbox_command(
        self, tree: Path, writable: list[Path], command: list[str],
        env: dict[str, str], network: bool = False,
        read_only: list[Path] | None = None,
        protected_read_only: list[Path] | None = None,
    ) -> list[str]:
        arguments = [
            "bwrap", "--clearenv", "--die-with-parent", "--new-session", "--unshare-user",
            "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
        ]
        if not network:
            arguments.append("--unshare-net")
        for path in (Path("/usr"), Path("/bin"), Path("/lib"), Path("/lib64")):
            if path.exists():
                arguments.extend(("--ro-bind", str(path), str(path)))
        arguments.extend(("--dir", "/etc"))
        for path in (
            Path("/etc/passwd"), Path("/etc/group"), Path("/etc/nsswitch.conf"),
            Path("/etc/ssl"), Path("/etc/ca-certificates"),
        ):
            if path.exists():
                arguments.extend(("--ro-bind", str(path), str(path)))
        arguments.extend(("--ro-bind", str(tree), str(tree)))
        toolchain = self.stage_toolchain(env["ADR0198_STAGE"])
        arguments.extend(("--ro-bind", str(toolchain), str(toolchain)))
        test_supervisor = self.toolchains / "test-supervisor"
        if test_supervisor.is_dir():
            arguments.extend(("--ro-bind", str(test_supervisor), str(test_supervisor)))
        for path in read_only or []:
            arguments.extend(("--ro-bind", str(path), str(path)))
        for path in writable:
            arguments.extend(("--bind", str(path), str(path)))
        for path in protected_read_only or []:
            arguments.extend(("--ro-bind", str(path), str(path)))
        offline_feed = self.offline_feed(env["ADR0198_STAGE"])
        arguments.extend(("--ro-bind", str(offline_feed), str(offline_feed)))
        sandbox_temp = self.mutable / env["ADR0198_STAGE"] / "runtime" / "temp"
        arguments.extend(("--bind", str(sandbox_temp), "/tmp"))
        arguments.extend(("--proc", "/proc", "--dev", "/dev", "--chdir", str(tree)))
        for name, value in sorted(env.items()):
            arguments.extend(("--setenv", name, value))
        arguments.extend(("--", *command))
        return arguments

    def command(
        self, stage: str, purpose: str, tree: Path, command: list[str],
        graph_identity: str, writable: list[Path], env: dict[str, str],
        outputs: list[Path] | None = None, network: bool = False,
        capture_test_events: bool = False,
        read_only: list[Path] | None = None,
    ) -> CommandResult:
        nonce = secrets.token_hex(32)
        receipt_name = f"{stage}-{purpose}-{secrets.token_hex(8)}.json"
        log = self.logs / receipt_name.replace(".json", ".log")
        event_chunks: list[bytes] = []
        event_reader: threading.Thread | None = None
        read_fd = write_fd = -1
        command_env = dict(env)
        pass_fds: tuple[int, ...] = ()
        event_key: bytes | None = None
        if capture_test_events:
            read_fd, write_fd = os.pipe()
            event_key = secrets.token_bytes(32)
            command_env["ADR0198_TEST_EVENT_FD"] = str(write_fd)
            command_env["ADR0198_TEST_EVENT_KEY"] = event_key.hex()
            pass_fds = (write_fd,)

            def read_events() -> None:
                with os.fdopen(read_fd, "rb", closefd=True) as handle:
                    for chunk in iter(lambda: handle.read(65536), b""):
                        event_chunks.append(chunk)

            event_reader = threading.Thread(target=read_events, daemon=True)
            event_reader.start()
        protected = [
            Path(path)
            for path in self.accepted_restore_outputs.get(stage, {})
        ]
        sandboxed = self.sandbox_command(
            tree, writable, command, command_env, network, read_only, protected)
        started = time.time_ns()
        process = subprocess.Popen(
            sandboxed, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True, pass_fds=pass_fds)
        if write_fd >= 0:
            os.close(write_fd)
        try:
            captured, _ = process.communicate(timeout=self.args.command_timeout)
        except subprocess.TimeoutExpired as error:
            process.kill()
            captured, _ = process.communicate()
            atomic_bytes(log, captured)
            raise CertificationError(
                f"{stage} {purpose} exceeded {self.args.command_timeout} seconds; "
                f"see {log}") from error
        if event_reader is not None:
            event_reader.join(timeout=10)
            if event_reader.is_alive():
                raise CertificationError("test supervisor event channel did not close")
        completed = time.time_ns()
        atomic_bytes(log, captured)
        events_path = None
        if capture_test_events:
            events_path = self.evidence / receipt_name.replace(".json", ".events.jsonl")
            atomic_bytes(events_path, b"".join(event_chunks))
        output_rows = []
        if process.returncode == 0:
            for path in outputs or []:
                info = owned_file(path, "command output")
                output_rows.append({
                    "path": str(path), "size": info.st_size,
                    "sha256": sha256_file(path),
                })
        receipt = {
            "runId": self.run_id,
            "nonceCommitment": sha256_bytes((self.run_id + nonce).encode()),
            "stage": stage, "purpose": purpose,
            "pid": process.pid, "arguments": command,
            "sandboxArgumentsSha256": sha256_bytes("\0".join(sandboxed).encode()),
            "graphIdentity": graph_identity,
            "startedNs": started, "completedNs": completed,
            "exitCode": process.returncode,
            "stdout": {"path": str(log), "sha256": sha256_bytes(captured)},
            "outputs": output_rows,
            "events": ({
                "path": str(events_path),
                "sha256": sha256_file(events_path),
            } if events_path is not None else None),
        }
        receipt_path = self.evidence / receipt_name
        atomic_json(receipt_path, receipt)
        self.receipts.append((receipt_path, sha256_file(receipt_path)))
        self.receipt_expectations[str(receipt_path)] = {
            key: receipt[key] for key in (
                "nonceCommitment", "pid", "arguments", "sandboxArgumentsSha256",
                "graphIdentity", "startedNs", "completedNs",
            )
        }
        if process.returncode != 0:
            tail = captured.decode(errors="replace").splitlines()[-40:]
            raise CertificationError(
                f"{stage} {purpose} failed with exit {process.returncode}; see {log}\n"
                + "\n".join(tail))
        return CommandResult(
            str(receipt_path), process.returncode,
            (completed - started) / 1_000_000_000,
            sha256_bytes(captured),
            str(events_path) if events_path is not None else None, event_key,
        )

    def environment(self, stage: str) -> tuple[dict[str, str], list[Path]]:
        root = self.writable(stage, "runtime")
        home = root / "home"
        temp = root / "temp"
        packages = self.writable(stage, "packages")
        http = self.writable(stage, "http-cache")
        plugins = self.writable(stage, "plugins-cache")
        for path in (home, temp, packages, http, plugins):
            path.mkdir(parents=True, exist_ok=True)
        env = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "HOME": str(home),
            "TMPDIR": str(temp), "TEMP": str(temp), "TMP": str(temp),
            "DOTNET_CLI_HOME": str(home),
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "MSBUILDDISABLENODEREUSE": "1",
            "NUGET_PACKAGES": str(packages),
            "NUGET_HTTP_CACHE_PATH": str(http),
            "NUGET_PLUGINS_CACHE_PATH": str(plugins),
            "NUGET_CERT_REVOCATION_MODE": "offline",
            "ADR0198_STAGE": stage,
        }
        return env, [home, temp, http, plugins]

    def command_stdout(
        self, stage: str, purpose: str, tree: Path, command: list[str],
        graph_identity: str, writable: list[Path], env: dict[str, str],
        read_only: list[Path] | None = None,
    ) -> bytes:
        result = self.command(
            stage, purpose, tree, command, graph_identity, writable, env,
            read_only=read_only)
        receipt = json.loads(Path(result.receipt).read_text(encoding="utf-8"))
        return Path(receipt["stdout"]["path"]).read_bytes()

    def seed_sdk_cache(self, stage: str, package: Path) -> dict[str, Any]:
        version = package_version(package)
        destination = self.writable(stage, "packages") / SDK_ID.casefold() / version.casefold()
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        with zipfile.ZipFile(package) as archive:
            for info in archive.infolist():
                normalized = Path(packer.entry_name(info.filename))
                if info.is_dir():
                    continue
                if normalized.is_absolute() or ".." in normalized.parts:
                    raise CertificationError(f"unsafe package entry {info.filename}")
                target = destination / normalized
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        nuspecs = list(destination.glob("*.nuspec"))
        if len(nuspecs) != 1:
            raise CertificationError("accepted SDK package must contain one nuspec")
        lower_nuspec = destination / f"{SDK_ID.casefold()}.nuspec"
        if nuspecs[0] != lower_nuspec:
            os.replace(nuspecs[0], lower_nuspec)
        package_name = f"{SDK_ID.casefold()}.{version.casefold()}.nupkg"
        cached_package = destination / package_name
        atomic_bytes(cached_package, package.read_bytes())
        content_hash = base64.b64encode(hashlib.sha512(package.read_bytes()).digest()).decode()
        atomic_bytes(
            destination / f"{package_name}.sha512",
            content_hash.encode())
        atomic_json(destination / ".nupkg.metadata", {
            "version": 2, "contentHash": content_hash,
            "source": str(self.stage1 / ".nugs"),
        })
        atomic_bytes(self.offline_feed(stage) / package.name, package.read_bytes())
        self.write_offline_config(stage)
        return {
            "id": SDK_ID, "version": version, "sha256": sha256_file(package),
            "payloadSha256": verify_resolved_sdk_payload(package, destination),
        }

    def seed_sdk_resolution(self, stage: str, package: Path) -> dict[str, Any]:
        version_result = subprocess.run(
            [str(self.dotnet), "--version"], capture_output=True, text=True, check=True)
        installed_root = dotnet_root()
        destination = self.stage_dotnet(stage)
        destination.parent.mkdir(parents=True, exist_ok=True)
        copied = subprocess.run(
            ["cp", "-a", "--reflink=auto", str(installed_root) + "/.", str(destination)],
            capture_output=True, text=True)
        if copied.returncode != 0:
            raise CertificationError(f"cannot copy trusted dotnet toolchain: {copied.stderr}")
        resolution = destination / "sdk" / version_result.stdout.strip() / "Sdks"
        if not resolution.is_dir():
            raise CertificationError(f"copied MSBuild SDK root not found: {resolution}")
        package_root = resolution / SDK_ID
        package_root.mkdir()
        with zipfile.ZipFile(package) as archive:
            for info in archive.infolist():
                name = Path(packer.entry_name(info.filename))
                if info.is_dir() or not name.parts or name.parts[0] not in {"Sdk", "build", "tools"}:
                    continue
                if name.is_absolute() or ".." in name.parts:
                    raise CertificationError(f"unsafe SDK payload entry {info.filename}")
                target = package_root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        payload = verify_resolved_sdk_payload(package, package_root)
        make_read_only(self.stage_toolchain(stage))
        return {
            "version": package_version(package), "root": str(package_root),
            "payloadSha256": payload,
        }

    def seed_locked_packages(
        self, stage: str, tree: Path, projects: list[str],
    ) -> list[dict[str, str]]:
        requested: dict[tuple[str, str], str] = {}
        locks = {
            tree / Path(project).parent / "packages.lock.json"
            for project in projects
        }
        for lock in sorted(locks):
            if not lock.is_file():
                raise CertificationError(f"participating project has no lock file: {lock}")
            try:
                document = json.loads(lock.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise CertificationError(f"cannot read {lock}: {error}") from error
            for target in document.get("dependencies", {}).values():
                for package_id, details in target.items():
                    if details.get("type") == "Project":
                        continue
                    package_id = package_component(package_id, "id")
                    version = package_component(details.get("resolved"), "version")
                    if not version:
                        raise CertificationError(f"{lock} has an unresolved package {package_id}")
                    key = (package_id.casefold(), version.casefold())
                    expected_hash = details.get("contentHash")
                    if not isinstance(expected_hash, str) or not expected_hash:
                        raise CertificationError(
                            f"{lock} has no content hash for {package_id}/{version}")
                    previous = requested.get(key)
                    if previous is not None and previous != expected_hash:
                        raise CertificationError(
                            f"lock files disagree on {package_id}/{version} content")
                    requested[key] = expected_hash
        destination_root = self.writable(stage, "packages")
        rows = []
        for (package_id, version), expected_hash in sorted(requested.items()):
            if package_id == SDK_ID.casefold() and version == package_version(
                    self.stage_packages[stage]).casefold():
                continue
            source = self.package_cache / package_id / version
            if not source.is_dir():
                raise CertificationError(
                    f"offline package cache lacks {package_id}/{version}")
            source_packages = list(source.glob("*.nupkg"))
            source_hashes = list(source.glob("*.nupkg.sha512"))
            if len(source_packages) != 1 or len(source_hashes) != 1:
                raise CertificationError(
                    f"package cache entry must contain one nupkg and hash: {source}")
            archive_bytes = source_packages[0].read_bytes()
            archive_hash = base64.b64encode(
                hashlib.sha512(archive_bytes).digest()).decode()
            if source_hashes[0].read_text(encoding="utf-8").strip() != archive_hash:
                raise CertificationError(f"package archive hash is invalid: {source}")
            archive_root = (
                self.writable(stage, "verified-archives") / package_id / version)
            archive_root.mkdir(parents=True)
            archive = archive_root / source_packages[0].name
            atomic_bytes(archive, archive_bytes)
            atomic_bytes(
                archive_root / source_hashes[0].name,
                (archive_hash + "\n").encode())
            make_read_only(archive_root)
            destination = destination_root / package_id / version
            actual_hash = self.package_content_hash(archive)
            if not hmac.compare_digest(actual_hash, expected_hash):
                raise CertificationError(
                    f"package content hash differs from the lock: {package_id}/{version}")
            nupkg = extract_verified_package(
                archive_root, destination, expected_hash)
            feed_package = self.offline_feed(stage) / nupkg.name
            if feed_package.exists() and sha256_file(feed_package) != sha256_file(nupkg):
                raise CertificationError(
                    f"ambiguous package bytes for {package_id}/{version}")
            atomic_bytes(feed_package, nupkg.read_bytes())
            files = [
                FileIdentity(
                    path.relative_to(destination_root).as_posix(),
                    stat.S_IMODE(path.stat().st_mode), path.stat().st_size,
                    sha256_file(path))
                for path in sorted(destination.rglob("*")) if path.is_file()
            ]
            rows.append({
                "id": package_id, "version": version,
                "lockContentHash": expected_hash,
                "manifestSha256": sha256_bytes(
                    json.dumps([asdict(row) for row in files], sort_keys=True).encode()),
            })
        atomic_json(self.evidence / f"{stage}-package-inputs.json", rows)
        self.write_offline_config(stage)
        return rows

    def package_content_hash(self, package: Path) -> str:
        output = self.toolchains / "package-content-hash"
        assembly = output / "Adr0198.PackageContentHash.dll"
        if not assembly.is_file():
            obj = self.mutable / "controller" / "package-content-hash-obj"
            obj.mkdir(parents=True, exist_ok=True)
            result = subprocess.run([
                str(self.dotnet), "build",
                str(HERE / "selfhost" / "PackageContentHash.csproj"),
                "--configuration", "Release", "--nologo",
                "-p:ImportDirectoryBuildProps=false",
                "-p:ImportDirectoryBuildTargets=false",
                f"-p:BaseIntermediateOutputPath={obj}{os.sep}",
                f"-p:MSBuildProjectExtensionsPath={obj}{os.sep}",
                "-o", str(output),
            ], capture_output=True, text=True)
            if result.returncode != 0 or not assembly.is_file():
                raise CertificationError(
                    "cannot build the trusted package hash helper:\n"
                    + result.stdout + result.stderr)
            make_read_only(output)
            atomic_json(self.evidence / "package-content-hash.json", {
                "path": str(assembly), "sha256": sha256_file(assembly),
                "sourceSha256": sha256_file(
                    HERE / "selfhost" / "PackageContentHash.cs"),
            })
        result = subprocess.run(
            [str(self.dotnet), str(assembly), str(package)],
            capture_output=True, text=True)
        if result.returncode != 0 or not result.stdout.strip():
            raise CertificationError(
                f"cannot compute the NuGet content hash for {package}: "
                + result.stderr.strip())
        return result.stdout.strip()

    def properties(self, stage: str, project: Path) -> dict[str, str]:
        key = hashlib.sha256(project.as_posix().encode()).hexdigest()[:16]
        output = self.writable(stage, "out")
        obj = self.writable(stage, "obj") / key
        obj.mkdir(parents=True, exist_ok=True)
        return {
            "Configuration": self.args.config,
            "Platform": "AnyCPU",
            "BaseOutputPath": str(output) + os.sep,
            "BaseIntermediateOutputPath": str(obj) + os.sep,
            "MSBuildProjectExtensionsPath": str(obj) + os.sep,
            "DocumentationFile": str(obj / f"{project.stem}.xml"),
            "ErrorLog": str(obj / f"{project.stem}.sarif"),
            "ProduceReferenceAssembly": "false",
            "RestorePackagesPath": str(self.writable(stage, "packages")),
            "RestoreConfigFile": str(self.write_offline_config(stage)),
            "BuildProjectReferences": "false",
            "RestoreProjectReferences": "false",
            "RestoreRecursive": "false",
        }

    def evaluate_one(
        self, stage: str, tree: Path, project: Path, isolated: bool,
        extra_properties: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        inspect_project_xml(tree, project)
        relative = project.relative_to(tree)
        properties = self.properties(stage, relative)
        properties.update(extra_properties or {})
        properties["BuildProjectReferences"] = "false" if isolated else "true"
        property_args = [f"-p:{name}={value}" for name, value in sorted(properties.items())]
        env, writable = self.environment(stage)
        obj = Path(properties["BaseIntermediateOutputPath"])
        writable = [*writable, obj]
        read_only = [
            self.writable(stage, "packages"),
            self.writable(stage, "out"),
        ]
        get_command = [
            str(self.stage_dotnet(stage) / "dotnet"), "msbuild", str(relative), "-nologo",
            "-getProperty:MSBuildProjectFullPath,MSBuildAllProjects,MSBuildToolsPath,"
            "NETCoreSdkVersion,GsharpCompilerFullPath,GsharpToolFullPath,"
            "TargetFramework,TargetFrameworks,RuntimeIdentifier,SelfContained,"
            "BuildProjectReferences,TargetPath,TargetRefPath,OutDir,TargetName,"
            "TargetExt,TargetFileName,ProjectAssetsFile",
            "-getItem:" + ",".join(INPUT_ITEMS),
            *property_args, "-nodeReuse:false",
        ]
        graph_hint = sha256_bytes(json.dumps({
            "project": str(relative), "properties": properties,
        }, sort_keys=True).encode())
        suffix = f"{sha256_bytes(str(relative).encode())[:8]}-{'isolated' if isolated else 'ordinary'}"
        evaluated_bytes = self.command_stdout(
            stage, f"graph-evaluate-{suffix}", tree, get_command,
            graph_hint, writable, env, read_only)
        try:
            evaluated = json.loads(evaluated_bytes)
        except json.JSONDecodeError as error:
            raise CertificationError(f"invalid MSBuild evaluation for {relative}: {error}") from error
        preprocess = [
            str(self.stage_dotnet(stage) / "dotnet"), "msbuild", str(relative), "-nologo", "-preprocess",
            *property_args, "-nodeReuse:false",
        ]
        preprocessed = self.command_stdout(
            stage, f"graph-preprocess-{suffix}", tree, preprocess,
            graph_hint, writable, env, read_only)
        imports = sorted({
            item.strip()
            for item in re.findall(
                r"(?:^|\r?\n)[ \t]*([^\r\n]+)\r?\n[ \t]*={20,}(?:\r?\n|$)",
                preprocessed.decode(errors="replace"))
            if Path(item.strip()).is_absolute() and Path(item.strip()).is_file()
        })
        properties_out = evaluated.get("Properties", {})
        item_sets = {
            name: list(evaluated.get("Items", {}).get(name, []))
            for name in INPUT_ITEMS
        }
        assets = properties_out.get("ProjectAssetsFile")
        if assets and Path(assets).is_file():
            out_dir = Path(properties_out.get("OutDir", ""))
            output_root = self.writable(stage, "out")
            if not out_dir.is_absolute() or not contains(output_root, out_dir):
                raise CertificationError(
                    f"resolved output directory is outside controller storage: {out_dir}")
            out_dir.mkdir(parents=True, exist_ok=True)
            resolved_names = (
                "ReferencePath", "Analyzer", "GsharpCodeAnalyzer",
                "AdditionalFiles", "EmbeddedResource", "Content",
            )
            resolve_properties = dict(properties)
            resolve_properties["BuildProjectReferences"] = "false"
            resolve_property_args = [
                f"-p:{name}={value}"
                for name, value in sorted(resolve_properties.items())
            ]
            resolve_command = [
                str(self.stage_dotnet(stage) / "dotnet"), "msbuild",
                str(relative), "-nologo", "-target:ResolveReferences",
                "-getItem:" + ",".join(resolved_names),
                *resolve_property_args, "-nodeReuse:false",
            ]
            resolved_bytes = self.command_stdout(
                stage, f"graph-resolve-{suffix}", tree, resolve_command,
                graph_hint, writable, env, read_only)
            try:
                resolved = json.loads(resolved_bytes)
            except json.JSONDecodeError as error:
                raise CertificationError(
                    f"invalid resolved input inventory for {relative}: {error}") from error
            for name in resolved_names:
                item_sets.setdefault(name, []).extend(
                    resolved.get("Items", {}).get(name, []))
        inputs: list[dict[str, str]] = []
        for item_name, items in item_sets.items():
            for item in items:
                value = item.get("FullPath") or item.get("Identity")
                if not value:
                    continue
                path = Path(value)
                if not path.is_absolute():
                    path = project.parent / path
                path = real(path)
                producer_name = item.get("MSBuildSourceProjectFile")
                producer = real(Path(producer_name)) if producer_name else None
                if (producer is not None and producer.is_file()
                        and contains(tree, producer) and producer != project):
                    if not path.exists():
                        continue
                    accepted = self.accepted_build_outputs.get(stage, {}).get(str(path))
                    actual = sha256_file(path) if path.is_file() else None
                    if accepted is None or actual != accepted["sha256"]:
                        raise CertificationError(
                            f"producer input is not an accepted build output: {path}")
                    inputs.append({
                        "kind": item_name, "path": str(path),
                        "sha256": actual,
                        "producerProject": producer.relative_to(tree).as_posix(),
                        "producerReceipt": accepted["receipt"],
                        "logicalPath": path.relative_to(
                            self.writable(stage, "out")).as_posix(),
                    })
                    continue
                elif path.exists() and path.is_file():
                    inputs.append({
                        "kind": item_name, "path": str(path),
                        "sha256": sha256_file(path),
                    })
                elif item_name in {
                    "ReferencePath", "Analyzer", "GsharpCodeAnalyzer",
                    "AdditionalFiles", "EmbeddedResource", "Content",
                }:
                    raise CertificationError(
                        f"resolved compilation input is missing: {path}")
        if properties_out.get("TargetFrameworks"):
            raise CertificationError(f"{relative} is multitargeted")
        references = []
        non_compiling_references = []
        for item in evaluated.get("Items", {}).get("ProjectReference", []):
            if str(item.get("BuildReference", "")).casefold() == "false":
                raise CertificationError(f"{relative} has a build-disabled ProjectReference")
            context = {
                name: item.get(name) for name in (
                    "AdditionalProperties", "Properties", "SetConfiguration",
                    "SetPlatform", "SetTargetFramework", "GlobalPropertiesToRemove",
                    "Targets",
                ) if item.get(name)
            }
            if context:
                raise CertificationError(
                    f"{relative} has a context-changing ProjectReference: {context}")
            path = real(Path(item.get("FullPath") or item["Identity"]))
            if not contains(tree, path):
                raise CertificationError(f"{relative} references outside the snapshot: {path}")
            output_item_type = str(item.get("OutputItemType", "")).casefold()
            if (str(item.get("ReferenceOutputAssembly", "")).casefold() == "false"
                    and output_item_type not in {"analyzer", "gsharpcodeanalyzer"}):
                non_compiling_references.append({
                    "path": str(path.relative_to(tree)),
                    "sha256": sha256_file(path),
                })
                references.append(str(path.relative_to(tree)))
                continue
            references.append(str(path.relative_to(tree)))
        import_rows = []
        for value in imports:
            path = real(Path(value))
            accepted_restore_hash = self.accepted_restore_outputs.get(
                stage, {}).get(str(path))
            accepted_restore = (
                accepted_restore_hash is not None
                and path.is_file()
                and sha256_file(path) == accepted_restore_hash
            )
            if not (contains(tree, path)
                    or contains(self.writable(stage, "packages"), path)
                    or contains(self.stage_toolchain(stage), path)
                    or accepted_restore):
                raise CertificationError(f"import outside accepted roots: {path}")
            if contains(tree, path) and path != project:
                definitions = inspect_repository_import(tree, path)
            elif (contains(self.writable(stage, "packages"), path)
                  or accepted_restore):
                definitions = inspect_repository_import(tree, path, external=True)
            else:
                definitions = {"targets": [], "tasks": []}
            import_rows.append({
                "path": str(path), "sha256": sha256_file(path),
                "definitions": definitions,
            })
        plan = {
            "project": str(relative), "isolated": isolated,
            "properties": properties, "effectiveProperties": properties_out,
            "references": sorted(references), "imports": import_rows,
            "nonCompilingReferences": sorted(
                non_compiling_references, key=lambda row: row["path"]),
            "inputs": sorted(inputs, key=lambda row: (row["kind"], row["path"])),
            "evaluationCommand": get_command, "preprocessCommand": preprocess,
            "hint": graph_hint,
        }
        plan["identity"] = sha256_bytes(
            json.dumps(plan, sort_keys=True, separators=(",", ":")).encode())
        return plan

    def graph(
        self, stage: str, tree: Path, roots: list[str],
        extra_properties: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        pending = list(roots)
        ordinary: dict[str, dict[str, Any]] = {}
        isolated: dict[str, dict[str, Any]] = {}
        while pending:
            relative = Path(pending.pop())
            key = relative.as_posix()
            if key in ordinary:
                continue
            project = real(tree / relative)
            if not contains(tree, project) or not project.is_file():
                raise CertificationError(f"project is outside the stage tree: {relative}")
            ordinary[key] = self.evaluate_one(
                stage, tree, project, False, extra_properties)
            isolated[key] = self.evaluate_one(
                stage, tree, project, True, extra_properties)
            left = dict(ordinary[key])
            right = dict(isolated[key])
            left.pop("identity", None)
            right.pop("identity", None)
            left["isolated"] = right["isolated"] = False
            left["properties"] = dict(left["properties"])
            right["properties"] = dict(right["properties"])
            left["properties"].pop("BuildProjectReferences", None)
            right["properties"].pop("BuildProjectReferences", None)
            left["effectiveProperties"] = dict(left["effectiveProperties"])
            right["effectiveProperties"] = dict(right["effectiveProperties"])
            left["effectiveProperties"].pop("BuildProjectReferences", None)
            right["effectiveProperties"].pop("BuildProjectReferences", None)
            left.pop("evaluationCommand", None)
            right.pop("evaluationCommand", None)
            left.pop("preprocessCommand", None)
            right.pop("preprocessCommand", None)
            left.pop("hint", None)
            right.pop("hint", None)
            if left != right:
                raise CertificationError(
                    f"ordinary and isolated graph identities differ for {relative}")
            pending.extend(ordinary[key]["references"])
        package = self.stage_packages.get(stage)
        if package is None:
            raise CertificationError(f"no accepted SDK package is bound to {stage}")
        version = package_version(package)
        sdk_version = subprocess.run(
            [str(self.stage_dotnet(stage) / "dotnet"), "--version"],
            capture_output=True, text=True, check=True).stdout.strip()
        resolved_sdk = (
            self.stage_dotnet(stage) / "sdk" / sdk_version / "Sdks" / SDK_ID)
        payload_identity = verify_resolved_sdk_payload(package, resolved_sdk)
        expected_compiler = real(resolved_sdk / "tools/compiler/gsc.dll")
        expected_task = real(resolved_sdk / "tools/task/Gsharp.NET.Sdk.dll")
        for name, node in ordinary.items():
            properties = node["effectiveProperties"]
            compiler = properties.get("GsharpCompilerFullPath")
            task = properties.get("GsharpToolFullPath")
            if Path(name).suffix.casefold() == ".gsproj" or compiler or task:
                if not compiler or real(Path(compiler)) != expected_compiler:
                    raise CertificationError(
                        f"{name} selected unexpected compiler {compiler!r}")
                if not task or real(Path(task)) != expected_task:
                    raise CertificationError(f"{name} selected unexpected build task {task!r}")
        value = {
            "ordinary": ordinary, "isolated": isolated,
            "toolchain": {
                "package": str(package),
                "packageSha256": sha256_file(package),
                "payloadIdentity": payload_identity,
                "resolved": str(resolved_sdk),
                "compilerSha256": sha256_file(expected_compiler),
                "taskSha256": sha256_file(expected_task),
            },
        }
        self.validate_output_ownership(stage, value)
        value["identity"] = sha256_bytes(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
        return value

    def revalidate(
        self, stage: str, tree: Path, roots: list[str], frozen: dict[str, Any], boundary: str,
        extra_properties: dict[str, str] | None = None,
    ) -> None:
        current = self.graph(stage, tree, roots, extra_properties)
        if current["identity"] != frozen["identity"]:
            raise CertificationError(f"{stage} graph changed at {boundary}")
        atomic_json(self.evidence / f"{stage}-{boundary}-graph.json", current)

    @staticmethod
    def verify_plan_files(plan: dict[str, Any]) -> None:
        for node in plan["ordinary"].values():
            for row in [*node["inputs"], *node["imports"]]:
                path = Path(row["path"])
                if not path.is_file() or sha256_file(path) != row["sha256"]:
                    raise CertificationError(f"frozen graph input changed: {path}")

    def accept_restore_outputs(
        self, stage: str, plan: dict[str, Any],
    ) -> dict[str, list[dict[str, Any]]]:
        accepted: dict[str, list[dict[str, Any]]] = {}
        for project, node in plan["ordinary"].items():
            assets = node["effectiveProperties"].get("ProjectAssetsFile")
            if not assets:
                raise CertificationError(f"{project} has no planned restore assets path")
            path = Path(assets)
            if not path.is_file():
                raise CertificationError(f"restore did not produce {path}")
            directory = path.parent
            rows = []
            for output in sorted(directory.rglob("*")):
                if output.is_symlink() or (output.is_file() and output.stat().st_nlink != 1):
                    raise CertificationError(f"unsafe restore output {output}")
                if output.is_file():
                    rows.append({
                        "path": str(output), "size": output.stat().st_size,
                        "sha256": sha256_file(output),
                    })
            if not rows:
                raise CertificationError(f"restore output directory is empty: {directory}")
            accepted[project] = rows
        atomic_json(self.evidence / f"{stage}-restore-outputs.json", accepted)
        self.accepted_restore_outputs[stage] = {
            row["path"]: row["sha256"]
            for rows in accepted.values() for row in rows
        }
        return accepted

    def restore(self, stage: str, tree: Path, roots: list[str], plan: dict[str, Any]) -> None:
        env, runtime_writable = self.environment(stage)
        for root in self.topological_order(plan):
            project = Path(root)
            properties = self.properties(stage, project)
            effective = plan["isolated"][root]["effectiveProperties"]
            for name in ("TargetFramework", "RuntimeIdentifier", "SelfContained"):
                if effective.get(name):
                    properties[name] = effective[name]
            command = [
                str(self.stage_dotnet(stage) / "dotnet"), "restore", root,
                f"-p:Configuration={self.args.config}",
                "-p:NuGetAudit=false",
                *[f"-p:{name}={value}" for name, value in sorted(properties.items())],
                "--configfile", str(self.write_offline_config(stage)),
                "--disable-build-servers", "--no-dependencies", "--locked-mode",
                "-nodeReuse:false",
            ]
            assets = Path(plan["isolated"][root]["effectiveProperties"]["ProjectAssetsFile"])
            writable = [
                *runtime_writable,
                Path(properties["BaseIntermediateOutputPath"]),
            ]
            self.command(
                stage, "restore", tree, command, plan["identity"], writable, env,
                outputs=[assets], read_only=[
                    self.writable(stage, "packages"),
                    self.writable(stage, "out"),
                ])

    def build(
        self, stage: str, tree: Path, roots: list[str], plan: dict[str, Any],
    ) -> dict[str, Any]:
        env, runtime_writable = self.environment(stage)
        order = self.topological_order(plan)
        for root in order:
            project_plan = self.graph(stage, tree, [root])
            self.revalidate(
                stage, tree, [root], project_plan,
                f"before-build-{sha256_bytes(root.encode())[:8]}")
            properties = self.properties(stage, Path(root))
            effective = project_plan["isolated"][root]["effectiveProperties"]
            for name in ("TargetFramework", "RuntimeIdentifier", "SelfContained"):
                if effective.get(name):
                    properties[name] = effective[name]
            command = [
                str(self.stage_dotnet(stage) / "dotnet"), "build", root, "--configuration", self.args.config,
                "--no-restore", "--no-dependencies", "--disable-build-servers",
                *[f"-p:{name}={value}" for name, value in sorted(properties.items())],
                "-nodeReuse:false",
            ]
            node = project_plan["isolated"][root]["effectiveProperties"]
            outputs = [self.planned_target(node)]
            if node.get("TargetRefPath"):
                outputs.append(Path(node["TargetRefPath"]))
            writable = [
                *runtime_writable,
                Path(properties["BaseIntermediateOutputPath"]),
                outputs[0].parent,
            ]
            receipt = self.command(
                stage, "build", tree, command, project_plan["identity"], writable, env,
                outputs=outputs, read_only=[
                    self.writable(stage, "packages"),
                    self.writable(stage, "out"),
                ])
            document = json.loads(Path(receipt.receipt).read_text(encoding="utf-8"))
            accepted = self.accepted_build_outputs.setdefault(stage, {})
            for output in document["outputs"]:
                accepted[output["path"]] = {
                    "sha256": output["sha256"],
                    "receipt": receipt.receipt,
                    "project": root,
                }
            self.revalidate(
                stage, tree, [root], project_plan,
                f"after-build-{sha256_bytes(root.encode())[:8]}")
        return self.graph(stage, tree, roots)

    @staticmethod
    def topological_order(plan: dict[str, Any]) -> list[str]:
        nodes = plan["isolated"]
        order: list[str] = []
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node: str) -> None:
            if node in visited:
                return
            if node in visiting:
                raise CertificationError(f"project graph has a cycle at {node}")
            visiting.add(node)
            for dependency in nodes[node]["references"]:
                if dependency not in nodes:
                    raise CertificationError(f"project graph omits dependency {dependency}")
                visit(dependency)
            visiting.remove(node)
            visited.add(node)
            order.append(node)

        for node in nodes:
            visit(node)
        return order

    @staticmethod
    def planned_target(properties: dict[str, Any]) -> Path:
        out_dir = properties.get("OutDir")
        target_name = properties.get("TargetName")
        target_ext = properties.get("TargetExt")
        target_file = f"{target_name}{target_ext}" if target_name and target_ext else None
        if not out_dir or not target_file or Path(target_file).name != target_file:
            raise CertificationError("frozen plan has no unambiguous output owner")
        return Path(out_dir) / target_file

    def validate_output_ownership(self, stage: str, plan: dict[str, Any]) -> None:
        output_root = self.writable(stage, "out")
        owners: list[tuple[str, Path, Path]] = []
        for project, node in plan["isolated"].items():
            target = real(self.planned_target(node["effectiveProperties"]))
            directory = target.parent
            if not contains(output_root, target):
                raise CertificationError(
                    f"{project} output is outside its controller-owned root: {target}")
            for other_project, other_directory, other_target in owners:
                if (target == other_target or directory == other_directory
                        or contains(directory, other_directory)
                        or contains(other_directory, directory)):
                    raise CertificationError(
                        "projects do not have disjoint output ownership: "
                        f"{project} / {other_project}")
            owners.append((project, directory, target))

    def project_target(self, plan: dict[str, Any], project: str) -> Path:
        try:
            properties = plan["isolated"][project]["effectiveProperties"]
        except KeyError as error:
            raise CertificationError(f"frozen plan has no output owner for {project}") from error
        path = self.planned_target(properties)
        if not path.is_file():
            raise CertificationError(f"accepted project output is missing: {path}")
        return path

    def accepted_output_hash(self, stage: str, path: Path) -> str:
        actual = sha256_file(path) if path.is_file() else None
        expected = self.accepted_build_outputs.get(stage, {}).get(str(path))
        if expected is None or actual != expected["sha256"]:
            raise CertificationError(f"not an accepted {stage} build output: {path}")
        return actual

    def publish_project(
        self, project: str, plan: dict[str, Any], destination: Path,
    ) -> None:
        stage = "stage-1"
        env, runtime_writable = self.environment(stage)
        destination.mkdir(parents=True, exist_ok=True)
        properties = self.properties(stage, Path(project))
        properties.update({
            "PublishDir": str(destination) + os.sep,
            "SelfContained": "false",
            "PublishReadyToRun": "false",
            "PublishSingleFile": "false",
        })
        base_properties = self.properties(stage, Path(project))
        publish_properties = {
            key: value for key, value in properties.items()
            if key not in base_properties
        }
        publish_plan = self.graph(
            stage, self.stage1, [project], publish_properties)
        token = sha256_bytes(project.encode())[:8]
        atomic_json(
            self.evidence / f"stage-1-publish-{token}-plan.json", publish_plan)
        self.revalidate(
            stage, self.stage1, [project], publish_plan,
            f"before-publish-{token}", publish_properties)
        command = [
            str(self.stage_dotnet(stage) / "dotnet"), "publish", project,
            "--configuration", self.args.config, "--no-restore", "--no-build",
            "--disable-build-servers",
            *[f"-p:{name}={value}" for name, value in sorted(properties.items())],
            "-nodeReuse:false",
        ]
        writable = [
            *runtime_writable,
            Path(properties["BaseIntermediateOutputPath"]),
            destination,
        ]
        receipt = self.command(
            stage, "publish-" + Path(project).stem,
            self.stage1, command, publish_plan["identity"], writable, env,
            read_only=[
                self.writable(stage, "packages"),
                self.writable(stage, "out"),
            ])
        published = []
        for path in sorted(destination.rglob("*")):
            if path.is_symlink():
                raise CertificationError(f"published payload is aliased: {path}")
            if path.is_file():
                info = owned_file(path, "published payload")
                published.append({
                    "path": str(path), "size": info.st_size,
                    "sha256": sha256_file(path),
                })
        if not published:
            raise CertificationError(f"publish produced no files for {project}")
        atomic_json(
            self.evidence / f"stage-1-publish-{token}-outputs.json",
            {"receipt": receipt.receipt, "files": published})
        self.revalidate(
            stage, self.stage1, [project], publish_plan,
            f"after-publish-{token}", publish_properties)

    def pack_stage1(self, plan: dict[str, Any]) -> Path:
        stage = "stage-1"
        published = self.writable("stage-1", "published")
        compiler = published / "compiler"
        self.publish_project("src/Compiler/Compiler.gsproj", plan, compiler)
        formatter = published / "formatter"
        self.publish_project(
            "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj", plan, formatter)
        gsgen = published / "gsgen"
        self.publish_project("tools/gsgen/Gsgen.Cli/Gsgen.Cli.gsproj", plan, gsgen)
        extensions = published / "extensions"
        self.publish_project(
            "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj", plan, extensions)

        bootstrap_version = package_version(self.bootstrap)
        version = self.args.stage1_version or packer.default_stage1_version(bootstrap_version)
        produced = self.writable(stage, "accepted") / f"{SDK_ID}.{version}.nupkg"
        produced.parent.mkdir(parents=True, exist_ok=True)
        replacements: dict[str, bytes] = {}

        def add_directory(prefix: str, directory: Path) -> None:
            for path in sorted(directory.rglob("*")):
                if path.is_symlink():
                    raise CertificationError(f"package payload is aliased: {path}")
                if path.is_file():
                    owned_file(path, "package payload")
                    replacements[prefix + path.relative_to(directory).as_posix()] = path.read_bytes()

        add_directory("tools/compiler/", compiler)
        add_directory("tools/formatter/", formatter)
        add_directory("tools/gsgen/", gsgen)
        add_directory("tools/extensions/", extensions)
        sdk_target = self.project_target(
            plan, "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj")
        self.accepted_output_hash(stage, sdk_target)
        for path in sdk_target.parent.glob(sdk_target.stem + ".*"):
            if path.is_file():
                replacements["tools/task/" + path.name] = path.read_bytes()
        for project, prefix in (
            ("src/Sdk/Gsharp.HotReload.Runtime/Gsharp.HotReload.Runtime.gsproj", "tools/hotreload/"),
            ("src/Sdk/Gsharp.Runtime.Channels/Gsharp.Runtime.Channels.gsproj", "tools/channels/"),
            ("src/Sdk/Gsharp.Runtime.Values/Gsharp.Runtime.Values.gsproj", "tools/values/"),
        ):
            if project not in plan["isolated"]:
                continue
            target = self.project_target(plan, project)
            self.accepted_output_hash(stage, target)
            for path in target.parent.glob(target.stem + ".*"):
                if path.is_file():
                    owned_file(path, "package payload")
                    replacements[prefix + path.name] = path.read_bytes()
        static = {
            "Sdk/Sdk.props": "src/Sdk/Gsharp.NET.Sdk/Sdk/Sdk.props",
            "Sdk/Sdk.targets": "src/Sdk/Gsharp.NET.Sdk/Sdk/Sdk.targets",
            "build/Gsharp.NET.Sdk.props": "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Sdk.props",
            "build/Gsharp.NET.Current.Sdk.targets":
                "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Current.Sdk.targets",
            "build/Gsharp.NET.Core.Sdk.targets":
                "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets",
            "build/Gsharp.File.xaml": "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.File.xaml",
            "build/Gsharp.CollectedPackageReference.xaml":
                "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.CollectedPackageReference.xaml",
            "build/Gsharp.ProjectItemsSchema.xaml":
                "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.ProjectItemsSchema.xaml",
        }
        for package_path, source_path in static.items():
            replacements[package_path] = (self.stage1 / source_path).read_bytes()
        replaced_prefixes = (
            "tools/compiler/", "tools/task/",
            "tools/hotreload/", "tools/channels/", "tools/values/",
            "tools/formatter/", "tools/gsgen/", "tools/extensions/",
            "Sdk/", "build/",
        )
        temporary = produced.with_suffix(".new")
        with zipfile.ZipFile(self.bootstrap) as source, zipfile.ZipFile(
                temporary, "w", zipfile.ZIP_DEFLATED) as sink:
            for info in source.infolist():
                normalized = packer.entry_name(info.filename)
                if normalized == ".signature.p7s" or normalized in replacements:
                    continue
                if normalized.startswith(replaced_prefixes):
                    continue
                data = source.read(info.filename)
                if normalized.endswith(".nuspec"):
                    text, count = re.subn(
                        r"<(version)>[^<]*</version>",
                        f"<version>{version}</version>",
                        data.decode("utf-8"), count=1)
                    if count != 1:
                        raise CertificationError("bootstrap package nuspec has no version")
                    data = text.encode()
                sink.writestr(info, data)
            for name, data in sorted(replacements.items()):
                sink.writestr(name, data)
        os.replace(temporary, produced)
        if packer.gsharp_provenance(produced).get("tools/compiler/gsc") != "gs":
            raise CertificationError("produced stage-1 package lacks G# compiler provenance")
        return produced

    def compare_outputs(self) -> list[dict[str, Any]]:
        rows = []
        for name in self.report["assemblies"]:
            left = self.writable("stage-1", "out") / name
            right = self.writable("stage-2", "out") / name
            for stage, path in (("stage-1", left), ("stage-2", right)):
                expected = self.accepted_build_outputs.get(stage, {}).get(str(path))
                if (expected is None or not path.is_file()
                        or sha256_file(path) != expected["sha256"]):
                    raise CertificationError(
                        f"selected PE is not an accepted build output: {path}")
            first, second, equal = compare_pe(left, right)
            rows.append({
                "assembly": name,
                "stage1": asdict(first), "stage2": asdict(second),
                "normalizedEqual": equal,
                "rawEqual": first.raw_sha256 == second.raw_sha256,
            })
        if not rows or not all(row["normalizedEqual"] for row in rows):
            raise CertificationError("stage-1 and stage-2 PE outputs are not equivalent")
        return rows

    def source_logical_graph(self, plan: dict[str, Any], tree: Path) -> dict[str, Any]:
        logical: dict[str, Any] = {}
        for name, node in plan["ordinary"].items():
            effective = {
                key: value for key, value in node["effectiveProperties"].items()
                if key.casefold() not in {
                    "buildprojectreferences", "baseoutputpath",
                    "baseintermediateoutputpath", "msbuildprojectextensionspath",
                    "restorepackagespath", "gsharpcompilerfullpath",
                    "gsharptoolfullpath", "projectassetsfile", "targetpath",
                    "targetrefpath", "msbuildallprojects",
                    "msbuildprojectfullpath", "msbuildtoolspath", "outdir",
                }
            }
            logical_inputs = []
            for row in node["inputs"]:
                if row["kind"] == "ProjectReference":
                    continue
                if row.get("producerProject"):
                    logical_inputs.append({
                        "kind": row["kind"],
                        "path": row["logicalPath"],
                        "producerProject": row["producerProject"],
                    })
                elif contains(tree, Path(row["path"])):
                    logical_inputs.append({
                        "kind": row["kind"],
                        "path": Path(row["path"]).relative_to(tree).as_posix(),
                        "sha256": row["sha256"],
                    })
            logical[name] = {
                "project": name,
                "properties": {
                    key: value for key, value in node["properties"].items()
                    if key.casefold() not in {
                        "buildprojectreferences", "baseoutputpath",
                        "baseintermediateoutputpath", "msbuildprojectextensionspath",
                        "restorepackagespath", "restoreconfigfile",
                        "documentationfile", "errorlog",
                    }
                },
                "effectiveProperties": effective,
                "references": node["references"],
                "nonCompilingReferences": node["nonCompilingReferences"],
                "imports": sorted((
                    {
                        "path": Path(row["path"]).relative_to(tree).as_posix(),
                        "sha256": row["sha256"],
                        "definitions": row["definitions"],
                    }
                    for row in node["imports"]
                    if contains(tree, Path(row["path"]))
                ), key=lambda row: row["path"]),
                "inputs": sorted(
                    logical_inputs, key=lambda row: (row["kind"], row["path"])),
            }
        return logical

    def ensure_test_supervisor(self) -> Path:
        output = self.toolchains / "test-supervisor"
        assembly = output / "Adr0198.TestLogger.dll"
        if assembly.is_file():
            return assembly
        obj = self.mutable / "controller" / "test-supervisor-obj"
        obj.mkdir(parents=True, exist_ok=True)
        command = [
            str(self.dotnet), "build",
            str(HERE / "selfhost" / "TestSupervisorLogger.csproj"),
            "--configuration", "Release", "--nologo",
            "-p:ImportDirectoryBuildProps=false",
            "-p:ImportDirectoryBuildTargets=false",
            f"-p:BaseIntermediateOutputPath={obj}{os.sep}",
            f"-p:MSBuildProjectExtensionsPath={obj}{os.sep}",
            "-o", str(output),
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not assembly.is_file():
            raise CertificationError(
                "cannot build the trusted test supervisor logger:\n"
                + result.stdout + result.stderr)
        make_read_only(output)
        atomic_json(self.evidence / "test-supervisor.json", {
            "path": str(assembly), "sha256": sha256_file(assembly),
            "sourceSha256": sha256_file(HERE / "selfhost" / "TestSupervisorLogger.cs"),
        })
        return assembly

    def run_tests(
        self, tree: Path, plan: dict[str, Any], roots: list[str],
    ) -> list[dict[str, Any]]:
        if not self.args.test:
            return []
        logger = self.ensure_test_supervisor()
        rows = []
        for index, specification in enumerate(self.args.test):
            project, separator, test_filter = specification.partition("::")
            if project not in plan["isolated"]:
                raise CertificationError(
                    f"test project is not in the frozen closure: {project}")
            scratch = self.writable("stage-2", f"test-{index}")
            test_properties = {
                "VSTestLogger": "ADR0198",
                "VSTestTestAdapterPath": str(logger.parent),
                "VSTestResultsDirectory": str(scratch),
            }
            if separator:
                test_properties["VSTestTestCaseFilter"] = test_filter
            test_plan = self.graph(
                "stage-2", tree, [project], test_properties)
            atomic_json(self.evidence / f"stage-2-test-{index}-plan.json", test_plan)
            self.revalidate(
                "stage-2", tree, [project], test_plan, f"before-test-{index}",
                test_properties)
            env, runtime_writable = self.environment("stage-2")
            properties = self.properties("stage-2", Path(project))
            properties.update(test_properties)
            command = [
                str(self.stage_dotnet("stage-2") / "dotnet"), "test", project,
                "--configuration", self.args.config, "--no-restore", "--no-build",
                "--logger", "ADR0198",
                "--test-adapter-path", str(logger.parent),
                "--results-directory", str(scratch),
                *[f"-p:{name}={value}" for name, value in sorted(properties.items())],
                "-nodeReuse:false",
            ]
            if separator:
                command.extend(("--filter", test_filter))
            test_target = self.project_target(test_plan, project)
            test_target_hash = self.accepted_output_hash("stage-2", test_target)
            before = {
                name: sha256_file(self.writable("stage-2", "out") / name)
                for name in self.report["assemblies"]
            }
            receipt = self.command(
                "stage-2", "test", tree, command, test_plan["identity"],
                [*runtime_writable, scratch], env, capture_test_events=True,
                read_only=[
                    self.writable("stage-2", "packages"),
                    self.writable("stage-2", "out"),
                ])
            after = {
                name: sha256_file(self.writable("stage-2", "out") / name)
                for name in self.report["assemblies"]
            }
            if before != after:
                raise CertificationError("test execution changed a certified output")
            if self.accepted_output_hash("stage-2", test_target) != test_target_hash:
                raise CertificationError("test execution changed its accepted test assembly")
            if receipt.events is None:
                raise CertificationError("test command produced no supervisor events")
            try:
                if receipt.event_key is None:
                    raise CertificationError("test command has no event authentication key")
                events = authenticated_events(
                    Path(receipt.events).read_bytes(), receipt.event_key)
            except (OSError, CertificationError) as error:
                raise CertificationError(f"invalid test supervisor evidence: {error}") from error
            starts = [event for event in events if event.get("type") == "started"]
            completed = [event for event in events if event.get("type") == "completed"]
            results = [event for event in events if event.get("type") == "result"]
            if len(starts) != 1 or len(completed) != 1:
                raise CertificationError("test supervisor did not observe one complete run")
            summary = completed[0]
            total = int(summary.get("total", 0))
            failed = int(summary.get("failed", 0))
            if (total <= 0 or total != len(results) or failed != 0
                    or summary.get("canceled") or summary.get("aborted")
                    or any(result.get("outcome") != "Passed" for result in results)):
                raise CertificationError(
                    f"test evidence is not a positive completed pass: "
                    f"total={total}, observed={len(results)}, failed={failed}")
            self.revalidate(
                "stage-2", tree, [project], test_plan, f"after-test-{index}",
                test_properties)
            rows.append({
                "project": project, "filter": test_filter, "executed": total,
                "failed": failed, "outcome": "Completed",
                "assemblySha256": before, "receipt": receipt.receipt,
                "testAssembly": {
                    "path": str(test_target), "sha256": test_target_hash,
                },
                "eventSha256": sha256_file(Path(receipt.events)),
                "loggerSha256": sha256_file(logger),
            })
        return rows

    def verify_receipts(self) -> None:
        hashes = {str(path): expected for path, expected in self.receipts}
        verify_receipt_set(
            self.run_id, [path for path, _ in self.receipts],
            hashes, self.receipt_expectations)

    def certify(self) -> int:
        try:
            self.preflight()
            manifest, git_identity = freeze_source(self.caller, self.source)
            self.report["source"] = {
                "manifestSha256": sha256_bytes(
                    json.dumps([asdict(row) for row in manifest], sort_keys=True).encode()),
                "files": len(manifest), "git": git_identity,
            }
            atomic_json(self.evidence / "source-manifest.json", [asdict(row) for row in manifest])
            clone_snapshot(self.source, self.stage1)
            clone_snapshot(self.source, self.stage2)
            bootstrap_version = package_version(self.bootstrap)
            pin_matches(self.stage1, bootstrap_version)
            reject_secret_restore_configuration(self.stage1)
            stage_package(self.stage1, self.bootstrap)
            self.stage_packages["stage-1"] = self.bootstrap
            self.seed_sdk_cache("stage-1", self.bootstrap)
            self.seed_sdk_resolution("stage-1", self.bootstrap)
            test_projects = [
                specification.partition("::")[0]
                for specification in self.args.test
            ]
            roots = list(dict.fromkeys([
                *self.report["projects"],
                *test_projects,
                *(str(path) for path in PACK_DEPENDENCIES if (self.stage1 / path).is_file()),
            ]))
            stage1_restore = self.graph("stage-1", self.stage1, roots)
            self.seed_locked_packages(
                "stage-1", self.stage1, list(stage1_restore["ordinary"]))
            stage1_restore = self.graph("stage-1", self.stage1, roots)
            atomic_json(self.evidence / "stage-1-restore-plan.json", stage1_restore)
            self.revalidate("stage-1", self.stage1, roots, stage1_restore, "before-restore")
            self.restore("stage-1", self.stage1, roots, stage1_restore)
            self.verify_plan_files(stage1_restore)
            self.accept_restore_outputs("stage-1", stage1_restore)
            stage1_build = self.graph("stage-1", self.stage1, roots)
            atomic_json(self.evidence / "stage-1-prebuild-plan.json", stage1_build)
            stage1_build = self.build("stage-1", self.stage1, roots, stage1_build)
            atomic_json(self.evidence / "stage-1-build-plan.json", stage1_build)
            stage1_package = self.pack_stage1(stage1_build)
            self.report["stage1Package"] = {
                "path": str(stage1_package),
                "sha256": sha256_file(stage1_package),
                "payloadSha256": package_payload_hash(stage1_package),
            }

            stage1_version = package_version(stage1_package)
            atomic_pin(self.stage2, stage1_version)
            stage_package(self.stage2, stage1_package)
            self.stage_packages["stage-2"] = stage1_package
            self.seed_sdk_cache("stage-2", stage1_package)
            self.seed_sdk_resolution("stage-2", stage1_package)
            reject_secret_restore_configuration(self.stage2)
            stage2_restore = self.graph("stage-2", self.stage2, roots)
            self.seed_locked_packages(
                "stage-2", self.stage2, list(stage2_restore["ordinary"]))
            stage2_restore = self.graph("stage-2", self.stage2, roots)
            atomic_json(self.evidence / "stage-2-restore-plan.json", stage2_restore)
            self.revalidate("stage-2", self.stage2, roots, stage2_restore, "before-restore")
            self.restore("stage-2", self.stage2, roots, stage2_restore)
            self.verify_plan_files(stage2_restore)
            self.accept_restore_outputs("stage-2", stage2_restore)
            stage2_build = self.graph("stage-2", self.stage2, roots)
            atomic_json(self.evidence / "stage-2-prebuild-plan.json", stage2_build)
            stage2_build = self.build("stage-2", self.stage2, roots, stage2_build)
            atomic_json(self.evidence / "stage-2-build-plan.json", stage2_build)
            if (self.source_logical_graph(stage1_build, self.stage1)
                    != self.source_logical_graph(stage2_build, self.stage2)):
                raise CertificationError(
                    "stage-1 and stage-2 source-logical closures differ")

            verify_manifest(self.source, manifest)
            self.verify_receipts()
            self.report["comparison"] = self.compare_outputs()
            self.report["tests"] = self.run_tests(
                self.stage2, stage2_build, roots)
            self.revalidate("stage-1", self.stage1, roots, stage1_build, "final")
            self.revalidate("stage-2", self.stage2, roots, stage2_build, "final")
            self.verify_receipts()
            self.report["certified"] = True
            atomic_json(self.reports / "stage2-report.json", self.report)
            print(f"self-host stage 2: CERTIFIED ({self.reports / 'stage2-report.json'})")
            return 0
        except (CertificationError, OSError, PeError, zipfile.BadZipFile) as error:
            self.report["certified"] = False
            self.report["error"] = str(error)
            if self.reports.is_dir():
                try:
                    atomic_json(self.reports / "stage2-report.json", self.report)
                except (CertificationError, OSError):
                    pass
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tree", type=Path)
    parser.add_argument("--bootstrap", type=Path)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--project", action="append")
    parser.add_argument("--assembly", action="append")
    parser.add_argument("--test", action="append", default=[])
    parser.add_argument("--config", default="Release")
    parser.add_argument("--stage1-version")
    parser.add_argument(
        "--package-cache", type=Path,
        default=Path.home() / ".nuget" / "packages",
        help="read-only source cache copied into each controller-owned stage cache")
    parser.add_argument("--command-timeout", type=int, default=900)
    parser.add_argument(
        "--compare-pe", nargs=2, metavar=("STAGE1", "STAGE2"), type=Path,
        help="run the controller's exact ADR-0198 PE comparison only")
    parser.add_argument(
        "--validate-project", nargs=2, metavar=("TREE", "PROJECT"), type=Path,
        help="run the controller's fail-closed project XML validation only")
    parser.add_argument(
        "--validate-import", nargs=2, metavar=("TREE", "IMPORT"), type=Path,
        help="run the controller's external import inventory only")
    parser.add_argument(
        "--verify-receipts", nargs="+", metavar="VALUE",
        help="verify a controller receipt set")
    parser.add_argument(
        "--sandbox-probe", nargs="+", type=Path,
        metavar="PATH",
        help="prove caller, controller, environment, and network isolation")
    parser.add_argument(
        "--verify-events", nargs=2, metavar=("KEY_HEX", "EVENTS"),
        help="verify authenticated supervisor event evidence")
    parser.add_argument(
        "--verify-manifest", nargs=2, metavar=("ROOT", "MANIFEST"), type=Path,
        help="verify a frozen boundary manifest")
    parser.add_argument(
        "--verify-package-cache", nargs=2, metavar=("SOURCE", "DESTINATION"),
        type=Path, help="verify and extract one cached package archive")
    parser.add_argument(
        "--verify-package-content", nargs=3,
        metavar=("PACKAGE", "EXPECTED_HASH", "WORK"),
        help="verify one package against a lock-file content hash")
    parser.add_argument(
        "--validate-package-component", metavar="VALUE",
        help="validate one package path component")
    args = parser.parse_args(argv)
    if args.compare_pe:
        try:
            first, second, equal = compare_pe(*args.compare_pe)
        except (OSError, PeError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        print(json.dumps({
            "stage1": asdict(first), "stage2": asdict(second),
            "normalizedEqual": equal,
            "rawEqual": first.raw_sha256 == second.raw_sha256,
        }, indent=2))
        return 0 if equal else 1
    if args.validate_project:
        tree, project = (real(path) for path in args.validate_project)
        try:
            if not contains(tree, project):
                raise CertificationError("project is outside the source tree")
            inspect_project_xml(tree, project)
        except (CertificationError, OSError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.validate_import:
        tree, import_path = (real(path) for path in args.validate_import)
        try:
            print(json.dumps(
                inspect_repository_import(tree, import_path, external=True),
                sort_keys=True))
        except (CertificationError, OSError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.verify_receipts:
        run_id, *receipt_names = args.verify_receipts
        try:
            verify_receipt_set(run_id, [real(Path(name)) for name in receipt_names])
        except (CertificationError, OSError, json.JSONDecodeError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.sandbox_probe:
        if len(args.sandbox_probe) < 2:
            parser.error("--sandbox-probe requires TREE WRITABLE [DENIED ...]")
        tree, writable, *denied = (real(path) for path in args.sandbox_probe)
        try:
            probe_sandbox(tree, writable, denied)
        except (CertificationError, OSError, subprocess.TimeoutExpired) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.verify_events:
        key_hex, event_name = args.verify_events
        try:
            authenticated_events(Path(event_name).read_bytes(), bytes.fromhex(key_hex))
        except (CertificationError, OSError, ValueError, json.JSONDecodeError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.verify_manifest:
        root, manifest_path = args.verify_manifest
        try:
            rows = [
                FileIdentity(**row)
                for row in json.loads(manifest_path.read_text(encoding="utf-8"))
            ]
            verify_manifest(real(root), rows)
        except (CertificationError, OSError, TypeError, json.JSONDecodeError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.verify_package_cache:
        source, destination = args.verify_package_cache
        try:
            extract_verified_package(real(source), destination.resolve())
        except (CertificationError, OSError, zipfile.BadZipFile) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.verify_package_content:
        package_name, expected_hash, work_name = args.verify_package_content
        work = real(Path(work_name))
        try:
            work.mkdir(mode=0o700)
            controller = object.__new__(Controller)
            controller.dotnet = real(Path(shutil.which("dotnet") or ""))
            controller.toolchains = work / "toolchains"
            controller.mutable = work / "mutable"
            controller.evidence = work / "evidence"
            controller.toolchains.mkdir()
            controller.mutable.mkdir()
            controller.evidence.mkdir()
            actual_hash = controller.package_content_hash(real(Path(package_name)))
            if not hmac.compare_digest(actual_hash, expected_hash):
                raise CertificationError("package content hash differs from the lock")
        except (CertificationError, OSError) as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.validate_package_component:
        try:
            package_component(args.validate_package_component, "component")
        except CertificationError as error:
            print(f"selfhost-stage2: {error}", file=sys.stderr)
            return 2
        return 0
    if args.tree is None or args.bootstrap is None or args.work is None:
        parser.error("--tree, --bootstrap, and --work are required for certification")
    return Controller(args).certify()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
