#!/usr/bin/env python3
"""Check Source Link through dotnet build and real Portable PDB metadata."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "out" / "test" / f"sourcelink-e2e-{os.getpid()}"
ENV = dict(os.environ, MSBUILDDISABLENODEREUSE="1")
PUBLIC_REPOSITORY = "https://github.com/DavidObando/gsharp"
SDK_PACKAGE = os.environ.get("GSHARP_SOURCELINK_SDK_PACKAGE")


def run(*arguments, cwd=WORK, success=True):
    result = subprocess.run(
        [str(argument) for argument in arguments],
        cwd=cwd, env=ENV, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=180,
    )
    if success and result.returncode:
        raise AssertionError(result.stdout)
    return result


def project(directory, *, executable=False):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "Directory.Build.props").write_text("<Project />")
    (directory / "Directory.Build.targets").write_text("<Project />")
    document = ET.Element("Project")
    ET.SubElement(document, "Import", Project="Sdk.props", Sdk="Gsharp.NET.Sdk")
    properties = ET.SubElement(document, "PropertyGroup")
    for name, value in {
        "TargetFramework": "net10.0",
        "OutputType": "Exe" if executable else "Library",
        "DebugType": "portable",
        "Deterministic": "true",
        "GenerateDocumentationFile": "false",
        "IncludeSourceRevisionInInformationalVersion": "false",
        "PublishRepositoryUrl": "true",
        "IncludeSymbols": "true",
        "SymbolPackageFormat": "snupkg",
    }.items():
        ET.SubElement(properties, name).text = value
    if not SDK_PACKAGE:
        ET.SubElement(properties, "GsharpToolFullPath").text = str(
            ROOT / "out/bin/Release/Gsharp.NET.Sdk/Gsharp.NET.Sdk.dll"
        )
    ET.SubElement(document, "Import", Project="Sdk.targets", Sdk="Gsharp.NET.Sdk")
    if not SDK_PACKAGE:
        # Use the pinned compiler and the built task with the SDK targets under test.
        ET.SubElement(
            document, "Import",
            Project=str(ROOT / "src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets"),
        )
    ET.ElementTree(document).write(directory / "Probe.gsproj", encoding="unicode")
    return directory / "Probe.gsproj"


def build(path, *properties, success=True):
    return run(
        "dotnet", "build", path, "-c", "Release", "--nologo", "-v:q",
        "-nr:false", *properties, success=success,
    )


def inspect(path):
    return json.loads(run("dotnet", WORK / "inspect/bin/Release/net10.0/inspect.dll", path).stdout)


def output(project_path, suffix):
    return project_path.parent / f"bin/Release/net10.0/Probe.{suffix}"


def check_source(info, directory, revision, source):
    assert info["sourceLink"] is not None, "The PDB has no Source Link payload."
    mappings = json.loads(info["sourceLink"])["documents"]
    document = next(item for item in info["documents"] if item["name"].endswith(source))
    matches = [
        url.replace("*", document["name"][len(key) - 1:])
        for key, url in mappings.items()
        if key.endswith("*") and document["name"].startswith(key[:-1])
    ]
    assert len(matches) == 1, (document, mappings)
    expected = f"https://raw.githubusercontent.com/DavidObando/gsharp/{revision}/{source}"
    assert matches[0].replace("\\", "/") == expected, (matches[0], expected)
    committed = subprocess.check_output(
        ["git", "show", f"{revision}:{source}"], cwd=directory, env=ENV,
    )
    assert document["hash"] == hashlib.sha256(committed).hexdigest(), document
    assert document["hashAlgorithm"] == "8829d00f-11b8-4213-878b-770e8597ac16"
    assert not info["embeddedSources"], "Source Link must not embed source files."
    assert document["name"] in info["sequenceDocuments"], "The source has no sequence points."
    return matches[0]


def repository(name):
    directory = WORK / name
    run("git", "clone", "--quiet", "--shared", "--no-checkout", ROOT, directory)
    run("git", "remote", "set-url", "origin", PUBLIC_REPOSITORY, cwd=directory)
    source = "samples/HelloWorld.gs"
    run("git", "read-tree", "HEAD", cwd=directory)
    run("git", "checkout", "HEAD", "--", source, cwd=directory)
    path = project(directory, executable=True)
    revision = run("git", "rev-parse", "HEAD", cwd=directory).stdout.strip()
    return directory, path, revision, source


def incremental():
    directory, path, revision, source = repository("repository")
    build(path)
    first = inspect(output(path, "pdb"))
    print("public source:", check_source(first, directory, revision, source), flush=True)
    original = {suffix: output(path, suffix).read_bytes() for suffix in ("dll", "pdb")}
    build(path, "-t:Rebuild")
    for suffix, content in original.items():
        assert output(path, suffix).read_bytes() == content, f"Non-deterministic {suffix}"
        print(f"deterministic {suffix}: {hashlib.sha256(content).hexdigest()}", flush=True)

    # Move only Git metadata. No project, source, or reference timestamp changes.
    time.sleep(1.1)
    run(
        "git", "-c", "user.name=Source Link test", "-c", "user.email=test@example.invalid",
        "commit", "--quiet", "--allow-empty", "-m", "Move source revision", cwd=directory,
    )
    revision = run("git", "rev-parse", "HEAD", cwd=directory).stdout.strip()
    build(path)
    current = inspect(output(path, "pdb"))
    check_source(current, directory, revision, source)
    assert current["sourceLink"] != first["sourceLink"], "An incremental build kept the old source revision."
    run("dotnet", "pack", path, "-c", "Release", "--no-build", "--nologo", "-v:q", "-nr:false")
    package = next((directory / "bin/Release").glob("*.nupkg"))
    with zipfile.ZipFile(package) as archive:
        manifest = ET.fromstring(archive.read(next(name for name in archive.namelist() if name.endswith(".nuspec"))))
        repository_element = next(item for item in manifest.iter() if item.tag.endswith("repository"))
        assert repository_element.attrib["commit"] == revision, repository_element.attrib
        assert repository_element.attrib["url"].rstrip("/") == PUBLIC_REPOSITORY
    symbols = next((directory / "bin/Release").glob("*.snupkg"))
    with zipfile.ZipFile(symbols) as archive:
        pdbs = [name for name in archive.namelist() if name.endswith(".pdb")]
        assert len(pdbs) == 1, pdbs
        assert archive.read(pdbs[0]) == output(path, "pdb").read_bytes()

    build(path, "-p:EnableSourceLink=false")
    assert inspect(output(path, "pdb"))["sourceLink"] is None, "Opt-out kept an old Source Link payload."
    build(path, "-p:DebugType=embedded")
    check_source(inspect(output(path, "dll")), directory, revision, source)
    build(path, "-p:DebugType=none")
    assert inspect(output(path, "dll"))["sourceLink"] is None


def manual():
    directory, path, revision, source = repository("manual")
    mappings = {"documents": {str(directory) + os.sep + "*":
                f"https://raw.githubusercontent.com/DavidObando/gsharp/{revision}/*"}}
    mapping_file = directory / "manual.json"
    mapping_file.write_text(json.dumps(mappings))
    properties = ("-p:EnableSourceLink=false", "-p:SourceLink=manual.json")
    build(path, *properties)
    check_source(inspect(output(path, "pdb")), directory, revision, source)
    time.sleep(1.1)
    mapping_file.write_text(json.dumps(mappings, indent=2))
    build(path, *properties)
    info = inspect(output(path, "pdb"))
    assert info["sourceLink"] == mapping_file.read_text(), "The PDB kept the previous mapping file contents."
    check_source(info, directory, revision, source)


def missing():
    directory = WORK / "missing"
    path = project(directory)
    (directory / "Probe.gs").write_text("public func Value() int32 -> 42\n")
    result = build(path, "-p:EnableSourceLink=false", "-p:SourceLink=missing.json", success=False)
    assert result.returncode != 0, "An explicit missing Source Link file silently built without Source Link."
    assert "Source Link file" in result.stdout and "missing.json" in result.stdout, result.stdout
    build(path, "-p:EnableSourceLink=false", "-p:SourceLink=missing.json", "-p:DebugType=none")
    assert inspect(output(path, "dll"))["sourceLink"] is None


def local():
    for committed in (False, True):
        directory = WORK / f"local-{committed}"
        path = project(directory)
        (directory / "Probe.gs").write_text("public func Value() int32 -> 42\n")
        run("git", "init", "--quiet", directory)
        if committed:
            run("git", "add", "Probe.gs", cwd=directory)
            run(
                "git", "-c", "user.name=Source Link test", "-c", "user.email=test@example.invalid",
                "commit", "--quiet", "-m", "Local source", cwd=directory,
            )
        build(path)
        info = inspect(output(path, "pdb"))
        assert info["sourceLink"] is None, "A local repository acquired a remote source mapping."
        assert info["documents"], "The local control did not produce source documents."
        assert not info["embeddedSources"], "A local build embedded source files without opt-in."
        build(path, "-p:SuppressImplicitGitSourceLink=true")
        assert inspect(output(path, "pdb"))["sourceLink"] is None


def native():
    rid = re.search(r"^\s*RID:\s*(\S+)", run("dotnet", "--info").stdout, re.MULTILINE).group(1)
    packages = list((ROOT / "out/bin/Release/nupkgs").glob(f"Gsharp.NET.Sdk.Compiler.{rid}.*.nupkg"))
    assert packages, f"Build the SDK graph first. No {rid} compiler package was found."
    package = max(packages, key=lambda item: item.stat().st_mtime_ns)
    directory, path, revision, source = repository("native")
    compiler = WORK / "native-compiler"
    with zipfile.ZipFile(package) as archive:
        prefix = f"tools/net10.0/{rid}/"
        for name in archive.namelist():
            if name.startswith(prefix) and not name.endswith("/"):
                destination = compiler / name[len(prefix):]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(name))
    assert inspect(compiler / "gsc.dll")["nativeCode"], "The native compiler has no ReadyToRun code."
    check_source(
        inspect(ROOT / "out/bin/Release/Compiler/gsc.pdb"),
        ROOT, revision, "src/Compiler/Program.gs",
    )
    properties = (f"-p:GsharpCompilerFullPath={compiler / 'gsc.dll'}",)
    build(path, *properties)
    check_source(inspect(output(path, "pdb")), directory, revision, source)
    original = {suffix: output(path, suffix).read_bytes() for suffix in ("dll", "pdb")}
    previous = ENV.get("DOTNET_ReadyToRun")
    ENV["DOTNET_ReadyToRun"] = "0"
    try:
        build(path, "-t:Rebuild", *properties)
    finally:
        if previous is None:
            ENV.pop("DOTNET_ReadyToRun")
        else:
            ENV["DOTNET_ReadyToRun"] = previous
    for suffix, content in original.items():
        assert output(path, suffix).read_bytes() == content, f"Native/JIT mismatch: {suffix}"
        print(f"native/JIT {suffix}: {hashlib.sha256(content).hexdigest()}", flush=True)


INSPECTOR = r"""
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Json;

using var stream = File.OpenRead(args[0]);
using var pe = args[0].EndsWith(".dll") ? new PEReader(stream) : null;
using var provider = pe == null
    ? MetadataReaderProvider.FromPortablePdbStream(stream)
    : pe.ReadDebugDirectory().Where(e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb)
        .Select(e => pe.ReadEmbeddedPortablePdbDebugDirectoryData(e)).SingleOrDefault();
var documents = new List<object>();
var sequenceDocuments = new HashSet<string>();
string sourceLink = null;
var embeddedSources = 0;
if (provider != null) {
    var reader = provider.GetMetadataReader();
    foreach (var handle in reader.Documents) {
        var document = reader.GetDocument(handle);
        documents.Add(new {
            name = reader.GetString(document.Name),
            hash = Convert.ToHexString(reader.GetBlobBytes(document.Hash)).ToLowerInvariant(),
            hashAlgorithm = reader.GetGuid(document.HashAlgorithm).ToString()
        });
    }
    foreach (var handle in reader.CustomDebugInformation) {
        var row = reader.GetCustomDebugInformation(handle);
        var kind = reader.GetGuid(row.Kind);
        if (kind == new Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A")) {
            if (sourceLink != null || row.Parent.Kind != HandleKind.ModuleDefinition)
                throw new Exception("Source Link must have one module parent.");
            sourceLink = Encoding.UTF8.GetString(reader.GetBlobBytes(row.Value));
        }
        if (kind == new Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE")) embeddedSources++;
    }
    foreach (var handle in reader.MethodDebugInformation) {
        var method = reader.GetMethodDebugInformation(handle);
        foreach (var point in method.GetSequencePoints()) {
            var document = point.Document.IsNil ? method.Document : point.Document;
            if (!point.IsHidden && !document.IsNil)
                sequenceDocuments.Add(reader.GetString(reader.GetDocument(document).Name));
        }
    }
}
var nativeCode = pe?.PEHeaders.CorHeader?.ManagedNativeHeaderDirectory.Size > 0;
Console.WriteLine(JsonSerializer.Serialize(new { sourceLink, documents, sequenceDocuments, embeddedSources, nativeCode }));
"""


def main():
    WORK.mkdir(parents=True)
    scratch = WORK / "scratch"
    scratch.mkdir()
    ENV.update(TMPDIR=str(scratch), TEMP=str(scratch), TMP=str(scratch))
    configuration = json.loads((ROOT / "global.json").read_text())
    if SDK_PACKAGE:
        package = Path(SDK_PACKAGE).resolve()
        with zipfile.ZipFile(package) as archive:
            manifest = ET.fromstring(archive.read(next(name for name in archive.namelist() if name.endswith(".nuspec"))))
            version = next(item.text for item in manifest.iter() if item.tag.endswith("}version"))
            assert "build/Gsharp.NET.SourceLink.targets" in archive.namelist()
        configuration["msbuild-sdks"]["Gsharp.NET.Sdk"] = version
        ENV["NUGET_PACKAGES"] = str(WORK / "packages")
        config = ET.Element("configuration")
        sources = ET.SubElement(config, "packageSources")
        ET.SubElement(sources, "clear")
        ET.SubElement(sources, "add", key="local", value=str(package.parent))
        ET.SubElement(sources, "add", key="nuget.org", value="https://api.nuget.org/v3/index.json")
        ET.ElementTree(config).write(WORK / "NuGet.config", encoding="unicode")
        print(f"packed SDK: {package.name}", flush=True)
    else:
        print("source-target SDK with released compiler:", configuration["msbuild-sdks"]["Gsharp.NET.Sdk"], flush=True)
    (WORK / "global.json").write_text(json.dumps(configuration))
    helper = WORK / "inspect"
    helper.mkdir()
    (helper / "Directory.Build.props").write_text("<Project />")
    (helper / "Directory.Build.targets").write_text("<Project />")
    (helper / "inspect.csproj").write_text(
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
        '<OutputType>Exe</OutputType></PropertyGroup></Project>'
    )
    (helper / "Program.cs").write_text(INSPECTOR)
    run("dotnet", "build", helper / "inspect.csproj", "-c", "Release", "--nologo", "-v:q", "-nr:false")
    failures = []
    for test in (incremental, manual, missing, local, native):
        try:
            test()
            print(f"PASS: {test.__name__}", flush=True)
        except (AssertionError, subprocess.SubprocessError, StopIteration) as error:
            failures.append(test.__name__)
            print(f"FAIL: {test.__name__}: {error}", flush=True)
    if failures:
        print("Evidence workspace:", WORK)
        return 1
    shutil.rmtree(WORK)
    return 0


if __name__ == "__main__":
    sys.exit(main())
