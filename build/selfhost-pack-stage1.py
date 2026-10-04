#!/usr/bin/env python3
"""Pack a stage-1 Gsharp.NET.Sdk from a cs2gs-migrated (G#) repository tree.

Issue #4631 (C2). The compiler is moving to G# source. Bootstrapping that
needs three compilers:

  stage 0  the C#-built SDK (today: this repository's own nupkg; at the
           cut-over: the final released 0.4.x)
  stage 1  the migrated G# tree compiled by stage 0
  stage 2  the migrated G# tree compiled by stage 1

This script produces the stage-1 *package*: it builds and packs
`src/Sdk/Gsharp.NET.Sdk` inside the migrated tree with the stage-0 SDK, so
the packed `tools/compiler/gsc.dll`, `GSharp.Core.dll`, gsfmt, gsgen and the
MSBuild task are all compiled from G# source. Pointing a build at that
package (see build/selfhost-stage2.py) is stage 2.

What it changes in the tree (all idempotent, all recorded in the report):

* stages the stage-0 nupkg(s) into the tree's `.nugs` feed (the tree's own
  nuget.config already lists it);
* pins Gsharp.NET.Sdk once, under `msbuild-sdks` in the tree's
  `global.json`. A tree migrated with `cs2gs migrate --sdk-pin global-json`
  already has bare `Sdk="Gsharp.NET.Sdk"` attributes. A tree migrated with
  per-project pins (the nightly's) has its *generated* pin, the one on
  `src/Core/Core.gsproj`, rewritten to the bare name wherever it appears;
  other versioned pins (samples, templates) are intentional and left alone.
  MSBuild lets a versioned attribute silently override the global.json pin,
  so after normalization any versioned pin left on a project the SDK
  package builds is an error.

The mirror forces `GeneratePackageOnBuild=false`; this script runs
`dotnet pack` on the SDK project instead of editing it, so the project file
stays exactly as cs2gs wrote it (re-enabling the property is a cut-over
hand-fix, recorded in docs).

The package is verified before the script succeeds: it must carry the same
`tools/` and `Sdk/` payload as the stage-0 package, and its compiler
assemblies must have been compiled from `.gs` sources (their portable PDBs
name `.gs` documents and no `.cs` ones).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SDK_ID = "Gsharp.NET.Sdk"
SDK_PROJECT = Path("src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj")
CORE_PROJECT = Path("src/Core/Core.gsproj")
# Projects the SDK project builds through nested <MSBuild> calls (the Pack*
# targets). `dotnet pack` restores only the SDK project's own reference graph,
# so these are restored explicitly first; the C# repository gets the same
# effect from its solution-wide restore.
NESTED_PROJECTS = ("src/Compiler/Compiler.gsproj", "src/Formatting/Gsfmt.Cli/Gsfmt.Cli.gsproj",
                   "tools/gsgen/Gsgen.Cli/Gsgen.Cli.gsproj", "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj")
ANALYZER_VERIFIER_ID = "GSharp.CodeAnalysis.Analyzers.Testing"
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$")
# Only the Project element's own Sdk attribute; never an <Import Sdk=...>.
PROJECT_SDK_RE = re.compile(r'(<Project\b[^>]*?\bSdk=")([^"]*)(")', re.DOTALL)
# Directories whose project files the SDK package (transitively) builds.
TOOLCHAIN_ROOTS = ("src/Compiler", "src/Core", "src/Formatting", "src/Sdk/Gsharp.NET.Sdk",
                   "src/Sdk/Gsharp.Extensions", "src/Sdk/Gsharp.HotReload.Runtime",
                   "src/Sdk/Gsharp.Runtime.Channels", "src/Sdk/Gsharp.Runtime.Values",
                   "src/InternalAnalyzers", "tools/gsgen", "tools/cs2gs")
# Assemblies that must be compiled from G# in a stage-1 package, proven from
# their portable PDBs. (tools/task/Gsharp.NET.Sdk.dll ships without a PDB in
# both stages, so its provenance is not checkable this way.)
GSHARP_COMPILED = ("tools/compiler/gsc", "tools/compiler/GSharp.Core")


class SelfHostError(Exception):
    """A precondition or verification failure; reported, never swallowed."""


def package_version(nupkg: Path, package_id: str = SDK_ID) -> str:
    name = nupkg.name
    prefix = package_id + "."
    if not name.startswith(prefix) or not name.endswith(".nupkg"):
        raise SelfHostError(f"{nupkg} is not a {package_id} package")
    version = name[len(prefix):-len(".nupkg")]
    if not VERSION_RE.match(version):
        raise SelfHostError(f"cannot read a version from {nupkg.name}")
    return version


def default_stage1_version(bootstrap_version: str) -> str:
    base = bootstrap_version.split("-", 1)[0]
    return base + "-stage1"


def project_sdk(text: str) -> str | None:
    match = PROJECT_SDK_RE.search(text)
    return match.group(2) if match else None


def project_files(tree: Path, patterns=("*.gsproj", "*.csproj")):
    for pattern in patterns:
        for path in tree.rglob(pattern):
            if any(part in ("bin", "obj", "node_modules", ".git") for part in path.relative_to(tree).parts):
                continue
            yield path


def normalize_pins(tree: Path, rewritten: list[str] | None = None) -> list[str]:
    """Rewrites the generated per-project pin to the bare SDK name.

    Returns the tree-relative paths rewritten (empty for a global-json tree).
    """
    core = tree / CORE_PROJECT
    if not core.is_file():
        raise SelfHostError(f"{core} not found; is {tree} a migrated repository?")
    generated = project_sdk(core.read_text(encoding="utf-8-sig"))
    if generated is None or not (generated == SDK_ID or generated.startswith(SDK_ID + "/")):
        raise SelfHostError(f"{CORE_PROJECT} does not build with {SDK_ID} (Sdk={generated!r})")
    if generated == SDK_ID:
        return []

    rewritten = [] if rewritten is None else rewritten
    # Core carries the generated pin needed to retry after another project's I/O failure.
    for path in sorted(project_files(tree), key=lambda path: (path == core, path)):
        raw = path.read_bytes()
        bom = raw.startswith(b"\xef\xbb\xbf")
        text = raw.decode("utf-8-sig")
        if project_sdk(text) != generated:
            continue
        text = PROJECT_SDK_RE.sub(lambda m: m.group(1) + SDK_ID + m.group(3), text, count=1)
        path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
        rewritten.append(path.relative_to(tree).as_posix())
    return rewritten


def check_no_versioned_toolchain_pins(tree: Path) -> None:
    offenders = []
    for root in TOOLCHAIN_ROOTS:
        base = tree / root
        if not base.is_dir():
            continue
        for path in project_files(base):
            sdk = project_sdk(path.read_text(encoding="utf-8-sig"))
            if sdk is not None and sdk.startswith(SDK_ID + "/"):
                offenders.append(f"{path.relative_to(tree).as_posix()} (Sdk={sdk})")
    if offenders:
        raise SelfHostError(
            "versioned Gsharp.NET.Sdk pins would override the global.json pin:\n  "
            + "\n  ".join(sorted(offenders)))


def block_comment_end(text: str, start: int) -> int:
    end = text.find("*/", start + 2)
    if end < 0:
        raise json.JSONDecodeError("Unterminated block comment", text, start)
    return end + 2


def closes_next(text: str, start: int) -> bool:
    """Whether the next token after `start`, skipping whitespace and comments, closes an object or array."""
    i = start
    while i < len(text):
        if text[i].isspace():
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end + 1
        elif text.startswith("/*", i):
            i = block_comment_end(text, i)
        else:
            return text[i] in "}]"
    return False


def strip_json_comments(text: str) -> str:
    out, i, in_string = [], 0, False
    while i < len(text):
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif text.startswith("//", i):
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            i = block_comment_end(text, i)
            continue
        elif c == "," and closes_next(text, i + 1):
            # A trailing comma (outside any string): drop it.
            pass
        else:
            out.append(c)
        i += 1
    return "".join(out)


def pin_global_json(tree: Path, version: str) -> bool:
    path = tree / "global.json"
    raw = path.read_bytes() if path.exists() else b""
    bom = raw.startswith(b"\xef\xbb\xbf")
    try:
        document = json.loads(strip_json_comments(raw.decode("utf-8-sig"))) if path.exists() else {}
    except json.JSONDecodeError as error:
        raise SelfHostError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(document, dict):
        raise SelfHostError(f"{path} is not a JSON object")
    sdks = document.setdefault("msbuild-sdks", {})
    if not isinstance(sdks, dict):
        # Never discard configuration we do not understand.
        raise SelfHostError(f"{path} has an msbuild-sdks value that is not a JSON object")
    for key in [k for k in sdks if k.lower() == SDK_ID.lower()]:
        del sdks[key]
    sdks[SDK_ID] = version
    # Written as plain JSON: comments and formatting in the original are not kept.
    updated = (b"\xef\xbb\xbf" if bom else b"") + (json.dumps(document, indent=2) + "\n").encode("utf-8")
    changed = updated != raw
    if changed:
        path.write_bytes(updated)
    return changed


def stage_feed(tree: Path, nupkgs: list[Path], staged: list[dict] | None = None) -> list[dict]:
    """Copies `nupkgs` into the tree's .nugs feed; returns what was staged and whether it replaced a file."""
    feed = tree / ".nugs"
    feed.mkdir(exist_ok=True)
    staged = [] if staged is None else staged
    for nupkg in nupkgs:
        target = feed / nupkg.name
        replaced = target.exists()
        # A bootstrap already in the tree's feed (a natural input) is the target itself.
        if not (replaced and target.samefile(nupkg)):
            shutil.copy2(nupkg, target)
        staged.append({"package": nupkg.name, "replacedExisting": replaced})
    return staged


def analyzer_verifier_versions(tree: Path) -> list[str]:
    """Read literal, unconditional references; never guess an evaluated MSBuild version."""
    versions = set()
    unevaluated_defaults = []
    documents = []
    aliases = {}
    for path in sorted(project_files(tree, ("*.gsproj", "*.csproj", "*.props", "*.targets"))):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as error:
            raise SelfHostError(f"{path.relative_to(tree)}: invalid project XML: {error}") from error
        documents.append((path, root))
        for item in root.iter():
            tag = item.tag.rsplit("}", 1)[-1]
            if tag != "PackageReference" and any(name in item.attrib for name in ("Include", "Update", "Remove")):
                aliases.setdefault(tag.lower(), []).append(item.get("Include", ""))
    for path, root in documents:
        parents = {child: parent for parent in root.iter() for child in parent}
        for item in root.iter():
            tag = item.tag.rsplit("}", 1)[-1]
            if tag == "ManagePackageVersionsCentrally" and (item.text or "").strip().lower() != "false":
                unevaluated_defaults.append(f"{path.relative_to(tree)}: central package versions are unsupported")
            if tag != "PackageReference":
                continue
            identifiers = [item.get(name, "") for name in ("Include", "Update", "Remove")]
            if not any(identifiers):
                unevaluated_defaults.append(
                    f"{path.relative_to(tree)}: PackageReference defaults without an identity are unsupported")
                continue
            for index, value in enumerate(identifiers):
                if not any(token in value for token in ("$(", "@(", "%(")):
                    continue
                alias = re.fullmatch(r"@\(([A-Za-z_][\w.]*)\)", value)
                values = aliases.get(alias.group(1).lower(), []) if alias else []
                # The repository uses item aliases for unrelated package IDs.
                # Admit only their literal identities, not MSBuild expressions or verifier versions.
                if values and all(v and not any(token in v for token in ("$(", "@(", "%(")) for v in values):
                    identifiers[index] = ";".join(values)
                else:
                    raise SelfHostError(
                        f"{path.relative_to(tree)}: unresolved PackageReference identity; "
                        f"cannot determine whether it requires {ANALYZER_VERIFIER_ID}")
            if not any(ANALYZER_VERIFIER_ID.lower() in (part.strip().lower() for part in value.split(";"))
                       for value in identifiers):
                continue
            problem = (
                f"{path.relative_to(tree)}: {ANALYZER_VERIFIER_ID} requires an unconditional "
                "PackageReference Include with one literal Version; "
                "Update/Remove, central/property versions and conditional contexts are unsupported")
            if (item.get("Include", "").lower() != ANALYZER_VERIFIER_ID.lower()
                    or item.get("Update") is not None or item.get("Remove") is not None
                    or item.get("VersionOverride") is not None):
                raise SelfHostError(problem)
            current = item
            while current is not None:
                if (current.get("Condition") is not None
                        or current.tag.rsplit("}", 1)[-1] in ("Target", "Choose", "When", "Otherwise")):
                    raise SelfHostError(problem)
                current = parents.get(current)
            metadata = [child for child in item if child.tag.rsplit("}", 1)[-1] == "Version"]
            values = ([item.get("Version")] if item.get("Version") is not None else []) + [
                child.text or "" for child in metadata]
            if (len(values) != 1 or not VERSION_RE.fullmatch(values[0])
                    or any(child.attrib for child in metadata)
                    or any(child.tag.rsplit("}", 1)[-1] == "VersionOverride" for child in item)):
                raise SelfHostError(problem)
            versions.add(values[0])
    if versions and unevaluated_defaults:
        raise SelfHostError(f"{ANALYZER_VERIFIER_ID}: " + "; ".join(unevaluated_defaults))
    return sorted(versions)


def prepare_tree(tree: Path, bootstrap: Path, report: dict | None = None) -> dict:
    """Prepares the tree; records each mutation into `report` as it completes.

    A failure part-way (a leftover versioned pin, a missing sibling) therefore
    still leaves an audit trail of what was already changed.
    """
    report = {} if report is None else report
    version = package_version(bootstrap)
    if not (tree / SDK_PROJECT).is_file():
        raise SelfHostError(f"{tree / SDK_PROJECT} not found; is {tree} a migrated repository?")
    report["bootstrapVersion"] = version
    report["rewrittenPins"] = []
    normalize_pins(tree, report["rewrittenPins"])
    report["globalJsonUpdated"] = pin_global_json(tree, version)
    check_no_versioned_toolchain_pins(tree)
    required_versions = analyzer_verifier_versions(tree)
    report["requiredAnalyzerVerifierVersions"] = required_versions
    # With no reference, keep the bootstrap-version sibling optional as before.
    siblings = [bootstrap.with_name(f"{ANALYZER_VERIFIER_ID}.{v}.nupkg")
                for v in (required_versions or [version])]
    missing = [path.name for path in siblings if not path.is_file()]
    report["missingSiblings"] = missing
    if missing and required_versions:
        raise SelfHostError(
            f"{ANALYZER_VERIFIER_ID} is referenced as a PackageReference in the tree but "
            f"{', '.join(missing)} is not beside the bootstrap {bootstrap.name}")
    report["feed"] = str(tree / ".nugs")
    report["stagedPackages"] = []
    stage_feed(tree, [bootstrap] + [path for path in siblings if path.is_file()], report["stagedPackages"])
    return report


def entry_name(name: str) -> str:
    # The SDK's PackagePath values end in a separator, so entries are
    # written as `tools/compiler//gsc.dll`.
    return re.sub("/+", "/", name)


def payload(nupkg: Path) -> set[str]:
    with zipfile.ZipFile(nupkg) as archive:
        return {entry_name(name) for name in archive.namelist()
                if name.startswith(("tools/", "Sdk/", "build/")) and not name.endswith("/")}


def gsharp_provenance(nupkg: Path) -> dict[str, str]:
    """Maps each GSHARP_COMPILED assembly to 'gs', 'cs' or a problem string."""
    verdicts = {}
    with zipfile.ZipFile(nupkg) as archive:
        names = {entry_name(name): name for name in archive.namelist()}
        for stem in GSHARP_COMPILED:
            pdb = stem + ".pdb"
            if pdb not in names:
                verdicts[stem] = "no pdb"
                continue
            data = archive.read(names[pdb])
            # Portable PDB document names are stored as UTF-8 path parts in
            # the #Blob heap, so source file names appear verbatim.
            has_gs = re.search(rb"[A-Za-z0-9_]\.gs(?![A-Za-z0-9_])", data) is not None
            has_cs = re.search(rb"[A-Za-z0-9_]\.cs(?![A-Za-z0-9_])", data) is not None
            verdicts[stem] = "gs" if has_gs and not has_cs else ("cs" if has_cs and not has_gs else "mixed" if has_gs else "unknown")
    return verdicts


def verify(stage1: Path, bootstrap: Path) -> dict:
    expected = payload(bootstrap)
    actual = payload(stage1)
    missing = sorted(name for name in expected - actual if not name.endswith(".xml"))
    # XML documentation files are not executed; a missing one is reported,
    # not fatal (the G# SDK does not emit them for executables today).
    missing_docs = sorted(name for name in expected - actual if name.endswith(".xml"))
    extra = sorted(actual - expected)
    provenance = gsharp_provenance(stage1)
    problems = []
    if missing:
        problems.append("missing payload entries: " + ", ".join(missing))
    not_gs = {k: v for k, v in provenance.items() if v != "gs"}
    if not_gs:
        problems.append("not compiled from G#: " + ", ".join(f"{k} ({v})" for k, v in not_gs.items()))
    if problems:
        raise SelfHostError("stage-1 package verification failed:\n  " + "\n  ".join(problems))
    return {"payloadEntries": len(actual), "extraEntries": extra, "missingDocs": missing_docs,
            "provenance": provenance}


def pack(tree: Path, version: str, out: Path, work: Path, config: str) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # A stage-1 package must never be satisfied from (or poison) the global
    # package cache, which is keyed by id+version only.
    env["NUGET_PACKAGES"] = str(work / "nuget-packages")
    for name in ("TMPDIR", "TEMP", "TMP"):
        env[name] = str(work / "tmp")
    (work / "tmp").mkdir(parents=True, exist_ok=True)
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    log = work / "pack.log"
    log.write_text("", encoding="utf-8")
    # Pack into a fresh directory so the produced package is unambiguous
    # even when --out already holds packages from an earlier run.
    pack_out = work / "pack-out"
    shutil.rmtree(pack_out, ignore_errors=True)
    pack_out.mkdir(parents=True)
    commands = [["dotnet", "restore", str(tree / project), "-nodeReuse:false"]
                for project in NESTED_PROJECTS if (tree / project).is_file()]
    commands.append(["dotnet", "pack", str(tree / SDK_PROJECT), "-c", config,
                     f"-p:PackageVersion={version}", "-o", str(pack_out), "-nodeReuse:false"])
    for command in commands:
        with log.open("a", encoding="utf-8") as handle:
            handle.write("$ " + " ".join(command) + "\n")
            handle.flush()
            result = subprocess.run(command, cwd=tree, env=env, stdout=handle, stderr=subprocess.STDOUT)
        if result.returncode != 0:
            tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]
            raise SelfHostError(f"{' '.join(command[:2])} failed (exit {result.returncode}); see {log}\n"
                                + "\n".join(tail))
    produced = sorted(pack_out.glob(SDK_ID + ".*.nupkg"))
    if len(produced) != 1:
        raise SelfHostError(f"dotnet pack succeeded but produced {len(produced)} {SDK_ID} packages in {pack_out}")
    return reversion(produced[0], version, out)


def reversion(nupkg: Path, version: str, out: Path | None = None) -> Path:
    """Rewrites a package's nuspec version and file name to `version`.

    Nerdbank.GitVersioning computes the package version itself (and a tree
    outside git gets `<major>.<minor>.0-g`), ignoring -p:PackageVersion. A
    stage-1 package must have a version of its own, never shared with a
    stage-0 build (package caches are keyed by id+version), so the version
    is stamped after packing. Assembly versions inside are untouched.
    """
    target = (out or nupkg.parent) / f"{SDK_ID}.{version}.nupkg"
    # Always stamp, even when the file name already matches: the name alone
    # says nothing about the nuspec inside.
    stamp_package(nupkg, target, version, required=True)
    symbols = nupkg.with_suffix(".snupkg")
    if symbols.exists():
        # The symbol package travels with the package, under the same version.
        stamp_package(symbols, target.with_suffix(".snupkg"), version, required=True)
    return target


def stamp_package(nupkg: Path, target: Path, version: str, required: bool) -> None:
    temporary = target.with_suffix(".tmp")
    stamped = 0
    with zipfile.ZipFile(nupkg) as source, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as sink:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.endswith(".nuspec") or info.filename.endswith(".psmdcp"):
                text, count = re.subn(r"<(version)>[^<]*</version>", f"<version>{version}</version>",
                                      data.decode("utf-8"), count=1)
                stamped += count if info.filename.endswith(".nuspec") else 0
                data = text.encode("utf-8")
            sink.writestr(info, data)
    if stamped != 1 and required:
        temporary.unlink()
        raise SelfHostError(f"{nupkg.name} has no nuspec <version> to stamp")
    temporary.replace(target)
    if nupkg.resolve() != target.resolve():
        nupkg.unlink()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tree", required=True, type=Path, help="migrated repository tree (modified in place)")
    parser.add_argument("--bootstrap", required=True, type=Path, help="stage-0 Gsharp.NET.Sdk.<v>.nupkg")
    parser.add_argument("--version", help="stage-1 package version (default <major.minor.patch>-stage1)")
    parser.add_argument("--out", required=True, type=Path, help="directory to write the stage-1 nupkg into")
    parser.add_argument("--work", type=Path, help="scratch root for logs and the isolated package cache (default <out>/work)")
    parser.add_argument("--config", default="Release")
    parser.add_argument("--prepare-only", action="store_true", help="prepare the tree and stop")
    args = parser.parse_args(argv)

    tree, bootstrap = args.tree.resolve(), args.bootstrap.resolve()
    out = args.out.resolve()
    work = (args.work or out / "work").resolve()
    work.mkdir(parents=True, exist_ok=True)
    report: dict = {}
    try:
        if not bootstrap.is_file():
            raise SelfHostError(f"{bootstrap} does not exist")
        bootstrap_version = package_version(bootstrap)
        version = args.version or default_stage1_version(bootstrap_version)
        if not VERSION_RE.match(version):
            raise SelfHostError(f"--version {version!r} is not a valid package version")
        if version == bootstrap_version:
            raise SelfHostError("the stage-1 version must differ from the bootstrap version "
                                "(package caches are keyed by id+version)")
        report.update({"tree": str(tree), "bootstrap": str(bootstrap), "stage1Version": version})
        prepare_tree(tree, bootstrap, report)
        if not args.prepare_only:
            nupkg = pack(tree, version, out, work, args.config)
            report["stage1Package"] = str(nupkg)
            report.update(verify(nupkg, bootstrap))
    except (SelfHostError, OSError, UnicodeError) as error:
        # The tree may already be modified; the report still records how.
        report["error"] = str(error)
        print(f"selfhost-pack-stage1: {error}", file=sys.stderr)
        return 1
    finally:
        (work / "stage1-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
