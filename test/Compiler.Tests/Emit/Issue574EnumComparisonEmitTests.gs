// <copyright file="Issue574EnumComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #574 ("same family as #534"): the equality (== / !=) and ordering
/// (< / <= / > / >=) operators must be defined for CLR enum
/// types, mirroring the bitwise lowering shipped in PR #562. Previously
/// the binder only matched user-defined `EnumSymbol == EnumSymbol`;
/// imported BCL enums (which surface as `ImportedTypeSymbol` whose
/// `ClrType.IsEnum`) tripped `GS0129 Binary operator '==' is not
/// defined …`.
///
/// These tests pin the new behaviour:
/// - `==` / `!=` on imported BCL enums (`ConsoleKey`, `FileShare`) and on a user-defined C# probe enum.
/// - `<` / `<=` / `>` / `>=` on signed-backed (int32) and unsigned-backed (byte) enums, the latter
/// exercising the `clt_un` / `cgt_un` dispatch path.
/// - Regression: the user-defined `EnumSymbol == EnumSymbol` arm still works (it now flows through the
/// same generalized `IsEnumType` helper).
/// - Negative: mixed-enum `==` and enum + int `==` still produce diagnostics.
/// Each test compiles via `gsc`, runs `ilverify` against the
/// produced PE, then executes the assembly under `dotnet exec` and
/// asserts on the captured stdout.
open class Issue574EnumComparisonEmitTests {
    // ── Positive: imported BCL enum equality ────────────────────────────
    @Fact
    func ConsoleKey_Equality_True() {
        let source = `package P
import System

var k = ConsoleKey.L
Console.WriteLine(k == ConsoleKey.L)
Console.WriteLine(k != ConsoleKey.L)`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ConsoleKey_Equality_False() {
        let source = `package P
import System

var k = ConsoleKey.L
Console.WriteLine(k == ConsoleKey.A)
Console.WriteLine(k != ConsoleKey.A)`
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FileShare_Equality_RoundTrips() {
        let source = `package P
import System
import System.IO

var a = FileShare.Read
var b = FileShare.Read
var c = FileShare.Write
Console.WriteLine(a == b)
Console.WriteLine(a == c)
Console.WriteLine(a != c)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ── Positive: ordering on signed-backed (int) CLR enum ─────────────
    @Fact
    func ConsoleKey_Ordering_Less() {
        let source = `package P
import System

var a = ConsoleKey.A
var b = ConsoleKey.B
Console.WriteLine(a < b)
Console.WriteLine(b < a)
Console.WriteLine(a <= a)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ConsoleKey_Ordering_Greater() {
        let source = `package P
import System

var a = ConsoleKey.A
var b = ConsoleKey.B
Console.WriteLine(b > a)
Console.WriteLine(a > b)
Console.WriteLine(b >= b)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ── Positive: ordering on unsigned-backed (byte) enum — exercises clt_un / cgt_un ──
    @Fact
    func ByteBackedEnum_Ordering_UnsignedSemantics() {
        let csSource = `using System;

namespace Probe574
{
    public enum SmallEnum : byte
    {
        A = 1,
        B = 200,
    }
}`
        let gsSource = `package P
import System
import Probe574

var a = SmallEnum.A
var b = SmallEnum.B
Console.WriteLine(a < b)
Console.WriteLine(b > a)
Console.WriteLine(a <= a)
Console.WriteLine(b >= b)
Console.WriteLine(b == SmallEnum.B)
Console.WriteLine(b != a)`
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "Probe574")
        )
    }

    // ── Positive: user-defined G# enum equality (regression) ─────────────
    @Fact
    func UserDefinedGSharpEnum_EqualityStillWorks() {
        let source = `package P
import System

enum Color {
    Red,
    Green,
    Blue,
}

var c = Color.Green
Console.WriteLine(c == Color.Green)
Console.WriteLine(c == Color.Red)
Console.WriteLine(c != Color.Red)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ── Positive: user-defined G# enum ordering ─────────────────────────
    @Fact
    func UserDefinedGSharpEnum_Ordering() {
        let source = `package P
import System

enum Color {
    Red,
    Green,
    Blue,
}

var r = Color.Red
var g = Color.Green
var b = Color.Blue
Console.WriteLine(r < g)
Console.WriteLine(g < b)
Console.WriteLine(b > r)
Console.WriteLine(g >= g)
Console.WriteLine(r <= g)`
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ── Negative: mixed-enum equality is still rejected ─────────────────
    @Fact
    func MixedEnumTypes_Equality_ProducesDiagnostic() {
        let source = `package P
import System
import System.IO

var bad = FileShare.Read == FileAccess.Read`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(
            diagnostics,
            (d string) -> d.Contains("'=='") && d.Contains("FileShare") && d.Contains("FileAccess")
        )
    }

    // ── Negative: enum + integer equality is still rejected ─────────────
    @Fact
    func EnumAndInt_Equality_ProducesDiagnostic() {
        let source = `package P
import System
import System.IO

var bad = FileShare.Read == 1`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("'=='") && d.Contains("FileShare"))
    }

    shared {
        // ── Helpers ────────────────────────────────────────────────────────
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue574_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue574_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, (`expected gsc to report errors but it succeeded
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue574_sib_").FullName
            try {
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
    <RootNamespace>` + "$siblingName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
                let siblingDll = BuildCsProject(csDir, siblingName)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingDll
                }
                for reference in BclReferences.Value {
                    gscArgs.Add("/reference:" + reference)
                }
                gscArgs.Add("/nowarn:GS9100")
                gscArgs.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(gscArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{siblingDll})
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func BuildCsProject(csDir string, siblingName string) string {
            RunDotnet(csDir, "restore")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
