#!/usr/bin/env python3
"""Release publish helper for the tag run in .github/workflows/build.yml (ADR-0218, issue #5530).

Commands:
  tag-kind <ref name>             print release, prerelease or none. The one definition of the three kinds.
  verify                          check the packages (and, with --tag, the tag and the VSIX files) before a push.
  nuget-push --group G            push one group of packages to nuget.org, primary package then symbol package.
  marketplace-version <id>        ask a marketplace whether an extension version is published.

Every destination is keyed by version and "already published" is success, so "Re-run failed jobs" on a tag
run is safe. The expected package list lives here, beside RIDS of check-rid-packages.py.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

RIDS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64", "osx-x64", "osx-arm64")
COMPILER_PACKAGES = tuple(f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in RIDS)
# Gsharp.NET.Sdk comes first: the group is pushed in this order.
SDK_PACKAGES = ("Gsharp.NET.Sdk", "Gsharp.Templates", "Gsharp.Repl", "Gsharp.Gsfmt", "Gsharp.Cs2Gs",
                "GSharp.CodeAnalysis.Analyzers.Testing")
# Gsharp.Templates has no symbols (Gsharp.Templates.gsproj) and the RID packages set IncludeSymbols=false.
SYMBOL_PACKAGES = tuple(p for p in SDK_PACKAGES if p != "Gsharp.Templates")
VSCODE_VSIX = "vscode-gsharp.vsix"
VISUAL_STUDIO_VSIX = "GSharp.VisualStudio.vsix"
PRERELEASE_PROPERTY = "Microsoft.VisualStudio.Code.PreRelease"
NUGET_SOURCE = "https://api.nuget.org/v3/index.json"
MARKETPLACE_QUERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"

NUMBER = r"(?:0|[1-9][0-9]*)"
CORE = rf"{NUMBER}\.{NUMBER}\.{NUMBER}"
# SemVer 2.0 prerelease: dot-separated identifiers; each is a number without leading zeros
# or a string of [0-9A-Za-z-] with at least one letter or hyphen. Build metadata (+x) is not allowed.
PRERELEASE_IDENTIFIER = rf"(?:{NUMBER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
TAG_PATTERN = re.compile(rf"v(?P<core>{CORE})(?:-(?P<pre>{PRERELEASE_IDENTIFIER}(?:\.{PRERELEASE_IDENTIFIER})*))?")
PACKAGE_FILE = re.compile(r"^(?P<id>.+?)\.(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.(?P<ext>nupkg|snupkg)$")
BUILD_VERSION = re.compile(r"^(?P<core>[0-9]+\.[0-9]+\.[0-9]+)(?:-g[0-9a-f]+)?$")


def tag_kind(ref_name: str) -> str:
    """release for v<core>, prerelease for v<core>-<SemVer prerelease>, none for everything else."""
    match = TAG_PATTERN.fullmatch(ref_name)
    if match is None:
        return "none"
    return "prerelease" if match.group("pre") else "release"


def tag_core(tag: str) -> str:
    match = TAG_PATTERN.fullmatch(tag)
    if match is None:
        raise ValueError(f"not a release tag: {tag}")
    return match.group("core")


def list_packages(nupkgs: Path) -> tuple[dict[str, list[str]], dict[str, list[str]], list[str]]:
    """Return {id: [versions]} for .nupkg and .snupkg files, and the names that match neither."""
    primary: dict[str, list[str]] = {}
    symbols: dict[str, list[str]] = {}
    unknown = []
    for path in sorted(nupkgs.iterdir()):
        match = PACKAGE_FILE.match(path.name)
        if not match:
            unknown.append(path.name)
            continue
        target = primary if match.group("ext") == "nupkg" else symbols
        target.setdefault(match.group("id"), []).append(match.group("version"))
    return primary, symbols, unknown


def check_nuget_packages(nupkgs: Path) -> tuple[list[str], str | None]:
    """The NuGet part of verify: inventory, one version, and the SDK's PackageDownload. Returns (errors, version)."""
    errors: list[str] = []
    if not nupkgs.is_dir():
        return [f"{nupkgs} is not a folder"], None
    primary, symbols, unknown = list_packages(nupkgs)
    errors += [f"unexpected file in {nupkgs}: {name}" for name in unknown]
    want_primary = set(COMPILER_PACKAGES) | set(SDK_PACKAGES)
    want_symbols = set(SYMBOL_PACKAGES)
    for label, found, wanted in (("package", primary, want_primary), ("symbol package", symbols, want_symbols)):
        errors += [f"missing {label}: {name}" for name in sorted(wanted - set(found))]
        errors += [f"unexpected {label}: {name}" for name in sorted(set(found) - wanted)]
        errors += [f"{label} {name} appears with versions {sorted(versions)}"
                   for name, versions in sorted(found.items()) if len(versions) > 1]
    versions = {v for found in (primary, symbols) for vs in found.values() for v in vs}
    if len(versions) != 1:
        errors.append(f"the packages carry {len(versions)} versions, expected one: {sorted(versions)}")
        return errors, None
    version = next(iter(versions))
    sdk_file = nupkgs / f"Gsharp.NET.Sdk.{version}.nupkg"
    if sdk_file.is_file():
        errors += check_sdk_props(sdk_file, version)
    return errors, version


def check_sdk_props(sdk_file: Path, version: str) -> list[str]:
    """The SDK restores Gsharp.NET.Sdk.Compiler.<rid> with PackageDownload (ADR-0207); it must ask for this version.

    The props file derives the version from the SDK's own folder name (`[$(GsharpSdkVersion)]`), which is the
    SDK package version, so the expression is right by construction. A literal version must equal `version`.
    """
    try:
        with zipfile.ZipFile(sdk_file) as archive:
            text = archive.read("build/Gsharp.NET.Sdk.props").decode("utf-8-sig")
    except (zipfile.BadZipFile, KeyError) as error:
        return [f"{sdk_file.name}: cannot read build/Gsharp.NET.Sdk.props: {error}"]
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        return [f"{sdk_file.name}: build/Gsharp.NET.Sdk.props is not valid XML: {error}"]
    versions = [e.get("Version", "") for e in root.iter()
                if local(e.tag) == "PackageDownload" and e.get("Include", "").startswith("Gsharp.NET.Sdk.Compiler.")]
    if not versions:
        return [f"{sdk_file.name}: build/Gsharp.NET.Sdk.props has no PackageDownload of Gsharp.NET.Sdk.Compiler"]
    return [f"{sdk_file.name}: PackageDownload version {found} is not [$(GsharpSdkVersion)] or [{version}]"
            for found in versions if found not in ("[$(GsharpSdkVersion)]", f"[{version}]")]


def vsix_manifest(vsix: Path) -> ET.Element:
    with zipfile.ZipFile(vsix) as archive:
        return ET.fromstring(archive.read("extension.vsixmanifest"))


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def manifest_identity_version(manifest: ET.Element) -> str:
    for element in manifest.iter():
        if local(element.tag) == "Identity":
            return element.get("Version", "")
    return ""


def manifest_has_property(manifest: ET.Element, name: str) -> bool:
    return any(local(e.tag) == "Property" and e.get("Id") == name for e in manifest.iter())


def check_tag_and_vsix(nupkgs_version: str | None, tag: str, vsix: Path) -> list[str]:
    errors: list[str] = []
    kind = tag_kind(tag)
    if kind == "none":
        return [f"{tag} is not a release tag (v<major>.<minor>.<patch> with an optional SemVer prerelease suffix)"]
    core = tag_core(tag)
    if nupkgs_version is not None:
        if kind == "release" and nupkgs_version != core:
            errors.append(f"tag {tag} needs package version {core}, found {nupkgs_version}")
        if kind == "prerelease" and not re.fullmatch(rf"{re.escape(core)}-g[0-9a-f]+", nupkgs_version):
            errors.append(f"tag {tag} needs package version {core}-g<sha>, found {nupkgs_version}")

    vscode = vsix / VSCODE_VSIX
    try:
        manifest = vsix_manifest(vscode)
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        errors.append(f"cannot read the manifest of {vscode}: {error}")
    else:
        found = manifest_identity_version(manifest)
        if found != core:
            errors.append(f"{VSCODE_VSIX} has version {found!r}, expected {core}")
        marked = manifest_has_property(manifest, PRERELEASE_PROPERTY)
        if marked != (kind == "prerelease"):
            errors.append(f"{VSCODE_VSIX} pre-release marker is {'present' if marked else 'absent'} for a {kind} tag")

    studio = vsix / VISUAL_STUDIO_VSIX
    try:
        manifest = vsix_manifest(studio)
        with zipfile.ZipFile(studio) as archive:
            sdk_pins = template_sdk_pins(archive)
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        errors.append(f"cannot read {studio}: {error}")
        return errors
    found = manifest_identity_version(manifest)
    parts = found.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts) or ".".join(parts[:3]) != core:
        errors.append(f"{VISUAL_STUDIO_VSIX} has version {found!r}, expected four numeric parts starting with {core}")
    if not sdk_pins:
        errors.append(f"{VISUAL_STUDIO_VSIX} has no project template")
    if nupkgs_version is not None:
        errors += [f"{VISUAL_STUDIO_VSIX}: {name} pins {pin!r}, expected Gsharp.NET.Sdk/{nupkgs_version}"
                   for name, pin in sorted(sdk_pins.items()) if pin != f"Gsharp.NET.Sdk/{nupkgs_version}"]
    return errors


def template_sdk_pins(archive: zipfile.ZipFile) -> dict[str, str | None]:
    """The Sdk attribute of every project template in a VSIX. VSIX packaging may leave a template as loose
    files (the layout of v0.5.212) or keep the template zip, so both are read."""
    pins: dict[str, str | None] = {}
    for name in archive.namelist():
        if not name.startswith("ProjectTemplates/"):
            continue
        if name.endswith(".gsproj"):
            pins[name] = ET.fromstring(archive.read(name)).get("Sdk")
        elif name.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(archive.read(name))) as template:
                for inner in template.namelist():
                    if inner.endswith(".gsproj"):
                        pins[f"{name}!{inner}"] = ET.fromstring(template.read(inner)).get("Sdk")
    return pins


def cmd_verify(args: argparse.Namespace) -> int:
    errors, version = check_nuget_packages(args.nupkgs)
    kind = None
    if not args.nuget_only:
        if not args.tag or args.vsix is None:
            print("verify needs --tag and --vsix unless --nuget-only is given", file=sys.stderr)
            return 2
        errors += check_tag_and_vsix(version, args.tag, args.vsix)
        kind = tag_kind(args.tag)
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    if errors:
        return 1
    print(f"verified {len(COMPILER_PACKAGES) + len(SDK_PACKAGES)} packages and {len(SYMBOL_PACKAGES)} symbol packages at {version}")
    output = os.environ.get("GITHUB_OUTPUT")
    if kind is not None and output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"version={version}\nprerelease={'true' if kind == 'prerelease' else 'false'}\n")
    return 0


def push_files(nupkgs: Path, group: str) -> list[Path]:
    """The files of a group in push order: each package, then its symbol package when it has one."""
    primary, symbols, _ = list_packages(nupkgs)
    names = COMPILER_PACKAGES if group == "compiler" else SDK_PACKAGES
    files = []
    for name in names:
        versions = primary.get(name, [])
        if len(versions) != 1:
            raise SystemExit(f"expected exactly one {name} package in {nupkgs}, found {versions}")
        files.append(nupkgs / f"{name}.{versions[0]}.nupkg")
        if name in symbols and name in SYMBOL_PACKAGES:
            files.append(nupkgs / f"{name}.{symbols[name][0]}.snupkg")
    return files


def cmd_nuget_push(args: argparse.Namespace, sleep=time.sleep) -> int:
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        print(f"{args.api_key_env} is not set", file=sys.stderr)
        return 1
    files = push_files(args.nupkgs, args.group)
    for path in files:
        command = [args.dotnet, "nuget", "push", str(path), "--api-key", api_key, "--source", args.source, "--skip-duplicate"]
        for attempt in range(1, args.attempts + 1):
            if subprocess.run(command, check=False).returncode == 0:
                break
            if attempt == args.attempts:
                print(f"push of {path.name} failed {args.attempts} times", file=sys.stderr)
                return 1
            sleep(args.pause)
    print(f"pushed {len(files)} files of group {args.group}")
    return 0


def published_versions(extension_id: str, url: str = MARKETPLACE_QUERY) -> dict[str, bool]:
    """Return {version: is_pre_release} of an extension from the public marketplace query. No credentials."""
    body = json.dumps({"filters": [{"criteria": [{"filterType": 7, "value": extension_id}]}], "flags": 17}).encode()
    request = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json", "Accept": "application/json;api-version=3.0-preview.1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        extensions = json.load(response)["results"][0]["extensions"]
    found: dict[str, bool] = {}
    for extension in extensions:
        for version in extension.get("versions", []):
            properties = {p["key"]: p["value"] for p in version.get("properties", [])}
            found[version["version"]] = properties.get(PRERELEASE_PROPERTY, "").lower() == "true"
    return found


def cmd_marketplace_version(args: argparse.Namespace, sleep=time.sleep, clock=time.monotonic) -> int:
    """Exit 0 when the version is published with the same pre-release flag, 1 when absent, 3 on a flag collision."""
    deadline = clock() + args.wait_minutes * 60
    wanted_pre = args.kind == "prerelease"
    while True:
        try:
            found = published_versions(args.extension_id, args.url)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as error:
            print(f"warning: marketplace query failed: {error}", file=sys.stderr)
            found = {}
        if args.version in found:
            if found[args.version] != wanted_pre and args.kind != "any":
                print(f"{args.extension_id} {args.version} is published as a "
                      f"{'pre-release' if found[args.version] else 'release'}, this run publishes a {args.kind}", file=sys.stderr)
                return 3
            print(f"{args.extension_id} {args.version} is published")
            return 0
        if clock() >= deadline:
            print(f"{args.extension_id} {args.version} is not published")
            return 1
        sleep(args.interval)


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    kind = sub.add_parser("tag-kind", help="print release, prerelease or none for a ref name")
    kind.add_argument("ref_name")

    verify = sub.add_parser("verify", help="check packages, tag and VSIX files before the first push")
    verify.add_argument("--nupkgs", type=Path, required=True, help="folder of the nuget-packages artifact")
    verify.add_argument("--vsix", type=Path, help="folder with vscode-gsharp.vsix and GSharp.VisualStudio.vsix")
    verify.add_argument("--tag", help="the tag name, for example v0.5.212")
    verify.add_argument("--nuget-only", action="store_true", help="check only the packages (no tag, no VSIX)")

    push = sub.add_parser("nuget-push", help="push one group of packages to nuget.org")
    push.add_argument("--group", choices=("compiler", "sdk"), required=True)
    push.add_argument("--nupkgs", type=Path, required=True)
    push.add_argument("--source", default=NUGET_SOURCE)
    push.add_argument("--api-key-env", default="NUGET_API_KEY", help="environment variable that holds the API key")
    push.add_argument("--attempts", type=positive_int, default=3)
    push.add_argument("--pause", type=float, default=30, help="seconds between two attempts")
    push.add_argument("--dotnet", default="dotnet")

    market = sub.add_parser("marketplace-version", help="ask whether an extension version is published")
    market.add_argument("extension_id", help="publisher.name, for example gsharplang.vscode-gsharp")
    market.add_argument("--version", required=True)
    market.add_argument("--kind", choices=("release", "prerelease", "any"), default="any")
    market.add_argument("--wait-minutes", type=float, default=0, help="keep asking this long while it is absent")
    market.add_argument("--interval", type=float, default=30)
    market.add_argument("--url", default=MARKETPLACE_QUERY)

    args = parser.parse_args(argv)
    if args.command == "tag-kind":
        print(tag_kind(args.ref_name))
        return 0
    if args.command == "verify":
        return cmd_verify(args)
    if args.command == "nuget-push":
        return cmd_nuget_push(args)
    return cmd_marketplace_version(args)


if __name__ == "__main__":
    sys.exit(main())
