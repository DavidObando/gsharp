#!/usr/bin/env python3
"""Publish and run bounded ADR-0210 carriers using the pinned released compiler."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parent.parent


def carrier(n: int, element: str = "int32") -> str:
    if n < 2:
        return f'{"Empty" if n == 0 else "Leaf"}[{element}]'
    return f"Branch[{element},{carrier(n // 2, element)},{carrier(n - n // 2, element)}]"


def slot(n: int, i: int) -> str:
    if n == 1:
        return ".Item"
    half = n // 2
    return ".Left" + slot(half, i) if i < half else ".Right" + slot(n - half, i - half)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rid", default="osx-arm64")
    parser.add_argument("--work", type=Path, default=Path("out/test-artifacts/fixed-array-f1-aot"))
    args = parser.parse_args()
    work = args.work.resolve()
    artifact_root = ROOT / "out/test-artifacts"
    if work == artifact_root or not work.is_relative_to(artifact_root):
        parser.error("--work must be a dedicated directory under out/test-artifacts")
    for path in work.rglob("*"):
        attributes = path.lstat()
        if (stat.S_ISLNK(attributes.st_mode) or path.resolve() != path
                or (stat.S_ISREG(attributes.st_mode) and attributes.st_nlink > 1)):
            parser.error("--work must not contain aliased files or directories")
    work.mkdir(parents=True, exist_ok=True)
    pin = json.loads((ROOT / "global.json").read_text())["msbuild-sdks"]["Gsharp.NET.Sdk"]
    packages = Path(os.environ.get("NUGET_PACKAGES", str(Path.home() / ".nuget/packages")))
    compiler = packages / "gsharp.net.sdk" / pin / "tools/compiler/gsc.dll"
    if not compiler.is_file():
        parser.error(f"published compiler missing: {compiler}; run the documented restore first")
    owner = ROOT / "out/bin/Release/Gsharp.Runtime.Values/Gsharp.Runtime.Values.dll"
    evidence = {
        "pin": pin, "compiler": str(compiler),
        "compilerSha256": hashlib.sha256(compiler.read_bytes()).hexdigest(),
        "host": platform.platform(), "hostMachine": platform.machine(), "rid": args.rid,
        "nativeLibraryPath": os.environ.get("LIBRARY_PATH", ""),
        "commands": [],
    }
    env = dict(os.environ, TMPDIR=str(work), MSBUILDDISABLENODEREUSE="1")

    def run(name: str, command: list[str]) -> int:
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
        (work / f"{name}.log").write_text(result.stdout + result.stderr)
        evidence["commands"].append({"command": command, "exitCode": result.returncode})
        (work / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(f"{name}: exit {result.returncode}", flush=True)
        return result.returncode

    compiler_property = f"-p:GsharpCompilerFullPath={compiler}"
    if run("owner-build", ["dotnet", "build", "src/Sdk/Gsharp.Runtime.Values/Gsharp.Runtime.Values.gsproj",
                           "--configuration", "Release", "--no-restore", "-graph", compiler_property]):
        return 1
    evidence["ownerSha256"] = hashlib.sha256(owner.read_bytes()).hexdigest()
    evidence["carrierSourceSha256"] = hashlib.sha256(
        (ROOT / "src/Sdk/Gsharp.Runtime.Values/FixedArrays.V1.gs").read_bytes()
    ).hexdigest()
    (work / "Directory.Build.props").write_text("<Project />\n")
    (work / "Directory.Build.targets").write_text("<Project />\n")
    for name in ("Producer", "Consumer"):
        folder = work / name
        folder.mkdir(exist_ok=True)
        reference = '<ProjectReference Include="../Producer/Producer.gsproj" />' if name == "Consumer" else ""
        (folder / f"{name}.gsproj").write_text(f"""<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>{"Exe" if name == "Consumer" else "Library"}</OutputType>
    <AssemblyName>FixedArrayAot{name}</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Gsharp.Runtime.Values"><HintPath>{escape(str(owner))}</HintPath></Reference>
    {reference}
  </ItemGroup>
</Project>
""")
    producer = ["package FixedAotProducer", "import System.Collections.Generic", "import System.Reflection",
                "import Gsharp.Values.FixedArrays.V1",
                '@assembly: AssemblyMetadata("GSharp.FixedArrays", "1")', "shared class Producer {",
                "func Echo[T](value T) T -> value"]
    consumer = ["package FixedAotConsumer", "import System", "import FixedAotProducer",
                "import Gsharp.Values.FixedArrays.V1",
                'func Require(ok bool) { if !ok { throw Exception("fixed-array AOT copy") } }',
                "func Main() {"]
    for n in range(33):
        producer += [f"func Make{n}() List[{carrier(n)}] {{", f"var value {carrier(n)} = default"]
        for i in range(n):
            producer.append(f"value{slot(n, i)} = {n * 100 + i}")
        producer += [f"return List[{carrier(n)}]{{value}}", "}"]
        consumer += [f"let items{n} = Producer.Make{n}()", f"var value{n} = items{n}[0]",
                     f"let copy{n} = Producer.Echo(value{n})"]
        if n:
            consumer.append(f"value{n}{slot(n, 0)} = -1")
            for i in range(n):
                consumer.append(f"Require(copy{n}{slot(n, i)} == {n * 100 + i})")
            consumer.append(f"Require(items{n}[0]{slot(n, 0)} == {n * 100})")
    producer.append("}")
    consumer += [
        "var nested Leaf[Leaf[int32]] = default",
        "nested.Item.Item = 7", "var nestedCopy = Producer.Echo(nested)",
        "nestedCopy.Item.Item = 9", "Require(nested.Item.Item == 7)",
        "var references Leaf[object?] = default", "let token = Object()",
        "references.Item = token", "let referenceCopy = Producer.Echo(references)",
        "GC.Collect()", "Require(Object.ReferenceEquals(referenceCopy.Item,token))",
        "var optional Leaf[int32?] = default", "Require(Producer.Echo(optional).Item == nil)",
        "optional.Item = 42", "Require(Producer.Echo(optional).Item == 42)",
        "var arrays Leaf[[]int32] = default", "arrays.Item = []int32{4}",
        "var arrayCopy = Producer.Echo(arrays)", "arrayCopy.Item[0] = 8",
        "Require(arrays.Item[0] == 8)",
        'Console.WriteLine("33 lengths; invariant exchange; generic/nested/reference/nullable/array copies")', "}",
    ]
    (work / "Producer/Main.gs").write_text("\n".join(producer) + "\n")
    (work / "Consumer/Main.gs").write_text("\n".join(consumer) + "\n")
    project = str(work / "Consumer/Consumer.gsproj")
    owner_property = f"-p:GsharpValuesRuntimeAssemblyFullPath={owner}"
    if run("aot-publish", ["dotnet", "publish", project, "--configuration", "Release", "--runtime", args.rid,
                           "-p:PublishAot=true", compiler_property, owner_property]):
        return 1
    executable = work / f"Consumer/bin/Release/net10.0/{args.rid}/publish/FixedArrayAotConsumer"
    if run("native-image", ["file", str(executable)]):
        return 1
    if run("native-run", [str(executable)]):
        return 1
    expected = "33 lengths; invariant exchange; generic/nested/reference/nullable/array copies\n"
    if (work / "native-run.log").read_text() != expected:
        raise RuntimeError("native output did not match the witness")
    evidence["nativeSha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    (work / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(expected, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
