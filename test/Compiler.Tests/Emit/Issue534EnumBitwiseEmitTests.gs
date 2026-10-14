// <copyright file="Issue534EnumBitwiseEmitTests.cs" company="GSharp">
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
import System.Reflection
import Xunit

/// Issue #534: bitwise operators |, &, ^, and unary ^ (ones complement)
/// must be defined for CLR enum types. Tests cover imported BCL enums
/// (FileShare, FileAccess, RegexOptions, UnixFileMode), a user-defined C#
/// probe enum with [Flags] and long underlying type, regression guards for
/// existing int32/bool operators, and negative tests for mixed-enum and
/// enum+int operand combinations.
open class Issue534EnumBitwiseEmitTests {
    // ── Positive: CLR enum bitwise OR ────────────────────────────────
    @Fact
    func FileShare_BitwiseOr_ProducesCorrectValue() {
        let source = `package P
import System
import System.IO

var mode = FileShare.ReadWrite | FileShare.Delete
Console.WriteLine(int32(mode))`
        // FileShare.ReadWrite = 3, FileShare.Delete = 4 → 3 | 4 = 7
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Positive: CLR enum bitwise AND ───────────────────────────────
    @Fact
    func FileAccess_BitwiseAnd_ProducesCorrectValue() {
        let source = `package P
import System
import System.IO

var result = FileAccess.Read & FileAccess.ReadWrite
Console.WriteLine(int32(result))`
        // FileAccess.Read = 1, FileAccess.ReadWrite = 3 → 1 & 3 = 1
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Positive: CLR enum bitwise XOR ───────────────────────────────
    @Fact
    func RegexOptions_BitwiseXor_ProducesCorrectValue() {
        let source = `package P
import System
import System.Text.RegularExpressions

var result = RegexOptions.IgnoreCase ^ RegexOptions.Multiline
Console.WriteLine(int32(result))`
        // RegexOptions.IgnoreCase = 1, RegexOptions.Multiline = 2 → 1 ^ 2 = 3
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Positive: CLR enum unary complement ──────────────────────────
    @Fact
    func FileShare_UnaryComplement_ProducesCorrectValue() {
        let source = `package P
import System
import System.IO

var result = ~FileShare.None
Console.WriteLine(int32(result))`
        // FileShare.None = 0 → ~0 = -1
        Assert.Equal("-1${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Positive: UnixFileMode (also int32-backed, different enum) ───
    @Fact
    func UnixFileMode_BitwiseOr_ProducesCorrectValue() {
        let source = `package P
import System
import System.IO

var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite
Console.WriteLine(int32(mode))`
        // UnixFileMode.UserRead = 256, UnixFileMode.UserWrite = 128 → 256 | 128 = 384
        Assert.Equal("384${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Positive: user-defined C# probe enum with [Flags] : long ────
    @Fact
    func LongBackedFlagsEnum_BitwiseOr_ProducesCorrectValue() {
        let csSource = `using System;

namespace Probe534
{
    [Flags]
    public enum LargeFlags : long
    {
        None = 0,
        Alpha = 1L,
        Beta  = 2L,
        Gamma = 4L,
        Big   = 1L << 40,
    }
}`
        let gsSource = `package P
import System
import Probe534

var combined = LargeFlags.Alpha | LargeFlags.Big
Console.WriteLine(int64(combined))`
        // Alpha = 1, Big = 1 << 40 = 1099511627776 → 1 | 1099511627776 = 1099511627777
        Assert.Equal("1099511627777${Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"))
    }

    @Fact
    func LongBackedFlagsEnum_BitwiseAnd_ProducesCorrectValue() {
        let csSource = `using System;

namespace Probe534
{
    [Flags]
    public enum LargeFlags : long
    {
        None = 0,
        Alpha = 1L,
        Beta  = 2L,
        Gamma = 4L,
        Big   = 1L << 40,
    }
}`
        let gsSource = `package P
import System
import Probe534

var all = LargeFlags.Alpha | LargeFlags.Beta | LargeFlags.Gamma
var mask = LargeFlags.Alpha | LargeFlags.Gamma
var result = all & mask
Console.WriteLine(int64(result))`
        // all = 7, mask = 5 → 7 & 5 = 5
        Assert.Equal("5${Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"))
    }

    @Fact
    func LongBackedFlagsEnum_UnaryComplement_ProducesCorrectValue() {
        let csSource = `using System;

namespace Probe534
{
    [Flags]
    public enum LargeFlags : long
    {
        None = 0,
        Alpha = 1L,
        Beta  = 2L,
        Gamma = 4L,
        Big   = 1L << 40,
    }
}`
        let gsSource = `package P
import System
import Probe534

var result = ~LargeFlags.None
Console.WriteLine(int64(result))`
        // ~0L = -1
        Assert.Equal("-1${Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"))
    }

    // ── Positive: byte-backed enum to exercise sub-i4 truncation ─────
    @Fact
    func ByteBackedEnum_BitwiseOr_ProducesCorrectValue() {
        let csSource = `using System;

namespace Probe534
{
    [Flags]
    public enum SmallFlags : byte
    {
        None = 0,
        A = 1,
        B = 2,
        C = 4,
    }
}`
        let gsSource = `package P
import System
import Probe534

var combined = SmallFlags.A | SmallFlags.C
Console.WriteLine(int32(combined))`
        // A = 1, C = 4 → 1 | 4 = 5
        Assert.Equal("5${Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "Probe534"))
    }

    // ── Regression: int32 | int32 still works ────────────────────────
    @Fact
    func Int32_BitwiseOr_StillWorks() {
        let source = `package P
import System

Console.WriteLine(3 | 4)`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Regression: bool | bool still works ──────────────────────────
    @Fact
    func Bool_BitwiseOr_StillWorks() {
        let source = `package P
import System

let a = true
let b = false
Console.WriteLine(a | b)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    // ── Negative: mixed enum types → diagnostic ──────────────────────
    @Fact
    func MixedEnumTypes_BitwiseOr_ProducesDiagnostic() {
        let source = `package P
import System
import System.IO

var bad = FileShare.Read | FileAccess.Read`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(
            diagnostics,
            (d string) -> d.Contains("'|'") && d.Contains("FileShare") && d.Contains("FileAccess")
        )
    }

    // ── Negative: enum + integer → diagnostic ────────────────────────
    @Fact
    func Enum_BitwiseOr_WithInt_ProducesDiagnostic() {
        let source = `package P
import System
import System.IO

var bad = FileShare.Read | 1`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("'|'") && d.Contains("FileShare"))
    }

    shared {
        // ── Helpers ──────────────────────────────────────────────────────
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue534_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue534_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue534_sib_").FullName
            try {
                // Step 1: compile the sibling C# library.
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
                // Step 2: compile the G# code referencing the sibling.
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingDll
                }
                for reference in TrustedPlatformAssemblies() {
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

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
