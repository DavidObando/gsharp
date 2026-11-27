#!/usr/bin/env python3
"""Verify packaged SDK symbols, scoped overrides, and symbol-only rebuilds."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def run(*arguments, cwd):
    result = subprocess.run(
        arguments, cwd=cwd, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, check=False,
        env={**os.environ, "NUGET_PACKAGES": str(cwd.parent / "packages")},
    )
    if result.returncode:
        raise RuntimeError(result.stdout.decode("utf-8", errors="replace"))
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk_package", type=Path)
    package = parser.parse_args().sdk_package.resolve(strict=True)
    with zipfile.ZipFile(package) as archive:
        nuspec = next(name for name in archive.namelist() if name.endswith(".nuspec"))
        metadata = ET.fromstring(archive.read(nuspec))
        version = next(node.text for node in metadata.iter()
                       if node.tag.rsplit("}", 1)[-1] == "version")
    cache = Path.home() / ".cache"
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gsharp-symbols-e2e-", dir=cache) as temporary:
        work = Path(temporary) / "app"
        work.mkdir()
        settings = json.loads((ROOT / "global.json").read_text())
        settings["msbuild-sdks"]["Gsharp.NET.Sdk"] = version
        (work / "global.json").write_text(json.dumps(settings))
        configuration = ET.Element("configuration")
        sources = ET.SubElement(configuration, "packageSources")
        ET.SubElement(sources, "clear")
        ET.SubElement(sources, "add", key="candidate", value=str(package.parent))
        ET.SubElement(sources, "add", key="nuget.org",
                      value="https://api.nuget.org/v3/index.json")
        ET.ElementTree(configuration).write(work / "nuget.config", encoding="utf-8")
        (work / "Probe.gsproj").write_text(
            '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup>'
            '<TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType>'
            '<DefineConstants>$(ExtraSymbols);OVERRIDE</DefineConstants>'
            '</PropertyGroup></Project>\n'
        )
        (work / "Program.gs").write_text(
            'import System\n'
            '@file:UndefineSymbol("OVERRIDE")\n'
            '@If(@defined("ACTIVE"))\n'
            'func message() string -> "on"\n'
            '@If(!@defined("ACTIVE"))\n'
            'func message() string -> "off"\n'
            '@If(@defined("OVERRIDE"))\n'
            'func rejected() MissingType -> missingValue\n'
            'Console.WriteLine(message())\n'
        )
        for symbol, expected in (("ACTIVE", "on"), ("INACTIVE", "off"), ("ACTIVE", "on")):
            run("dotnet", "build", "Probe.gsproj", "-graph", "--nologo",
                "-p:ExtraSymbols=" + symbol, cwd=work)
            actual = run("dotnet", str(work / "bin/Debug/net10.0/Probe.dll"), cwd=work)
            expected_bytes = (expected + os.linesep).encode("utf-8")
            assert actual == expected_bytes, (symbol, expected_bytes, actual)
            response = (work / "obj/Debug/net10.0/Probe.rsp").read_text()
            assert "/define:" in response and symbol in response, response
        print("PASS: packaged SDK symbol forwarding, scoped undefinition, and symbol-only rebuilds.")


if __name__ == "__main__":
    main()
