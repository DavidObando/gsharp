// <copyright file="Issue611SliceArrayParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import Xunit

/// Issue #611: audit and close slice-vs-array surface gaps. These tests pin
/// the parity fixes introduced in this PR so regressions are caught early.
open class Issue611SliceArrayParityTests {
    // ---------------------------------------------------------------
    // Category (b) fix: type-parameter inference — slice → interface
    // ---------------------------------------------------------------
    @Fact
    func TypeInference_SlicePassedToClrGenericMethod_InfersT() {
        // Validates that slice → CLR generic method inference works end-to-end.
        // System.Linq.Enumerable.Count<T>(IEnumerable<T>) must infer T from a
        // []string argument. This exercises the CLR-level inference path
        // (ClrOverloadResolution.UnifyForInference → FindClosedGeneric) which walks
        // the array's interfaces to find IEnumerable<string>.
        let gsource = `package Probe.Tests
import System
import System.Linq

var s = []string{"a", "b", "c"}
Console.WriteLine(Enumerable.Count(s))`
        let output = CompileAndRun(gsource)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func TypeInference_SlicePassedToClrGenericMethod_Contains() {
        // Enumerable.Contains<T>(IEnumerable<T>, T) — two args, T inferred
        // from the slice element type.
        let gsource = `package Probe.Tests
import System
import System.Linq

var s = []int32{10, 20, 30}
Console.WriteLine(Enumerable.Contains(s, 20))`
        let output = CompileAndRun(gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func TypeInference_SlicePassedToClrGenericMethod_First() {
        // Enumerable.First<T>(IEnumerable<T>) infers T from slice element.
        let gsource = `package Probe.Tests
import System
import System.Linq

var s = []string{"hello", "world"}
Console.WriteLine(Enumerable.First(s))`
        let output = CompileAndRun(gsource)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func TypeInference_GSharpGenericFunc_SliceParam_InfersT() {
        // A GSharp generic function with a []T parameter. The argument is a
        // []string literal (reference type avoids value-type array cast issues
        // in the type-erased model), so T infers to string. This exercises the
        // GSharp-level InferTypeArguments branch (SliceTypeSymbol ps &&
        // SliceTypeSymbol asym).
        let gsource = `package Probe.Tests
import System

func Size[T any](items []T) int32 {
    return items.Length
}

var s = []string{"a", "b", "c"}
Console.WriteLine(Size(s))`
        let output = CompileAndRun(gsource)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Category (b) fix: documentation ID — slice type encoding
    // ---------------------------------------------------------------
    @Fact
    func DocumentationId_SliceParam_MatchesArrayEncoding() {
        // Verify that compiling a function with a slice parameter does not
        // crash the documentation-ID provider. (The actual ID value is
        // checked at the unit level; this integration test ensures no
        // runtime failures.)
        let gsource = `package Probe.Tests
import System

func Sum(values []int32) int32 {
    var total = 0
    for _, v in values {
        total = total + v
    }
    return total
}

Console.WriteLine(Sum([]int32{1, 2, 3}))`
        let output = CompileAndRun(gsource)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    // ---------------------------------------------------------------
    // Category (c) pin: intentional asymmetries (executable behavior)
    // ---------------------------------------------------------------
    @Fact
    func PatternMatch_ListPattern_WorksOnSlice() {
        // Pattern matching on slices already works (verified in #611
        // audit as category-a). Pin the behaviour.
        let gsource = `package Probe.Tests
import System

var s = []int32{1, 2, 3}
let r = switch s { case [1, 2, 3]: "matched" default: "no match" }
Console.WriteLine(r)`
        let output = CompileAndRun(gsource)
        Assert.Equal("matched${Environment.NewLine}", output)
    }

    @Fact
    func PatternMatch_ListPattern_WorksOnFixedArray() {
        // Pattern matching on fixed-arrays also works. Pin the behaviour.
        let gsource = `package Probe.Tests
import System

var a = [3]int32{1, 2, 3}
let r = switch a { case [1, 2, 3]: "matched" default: "no match" }
Console.WriteLine(r)`
        let output = CompileAndRun(gsource)
        Assert.Equal("matched${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_Slice_YieldsElementsAndIndices() {
        // for-range on a slice — already correct, pinned here.
        let gsource = `package Probe.Tests
import System

var s = []string{"a", "b"}
for i, v in s {
    Console.WriteLine(i.ToString() + ":" + v)
}`
        let output = CompileAndRun(gsource)
        Assert.Equal("0:a${Environment.NewLine}1:b${Environment.NewLine}", output)
    }

    @Fact
    func Intrinsic_Len_WorksOnSlice() {
        // .Length on a slice — already correct, pinned here.
        let gsource = `package Probe.Tests
import System

var s = []int32{10, 20, 30, 40}
Console.WriteLine(s.Length)`
        let output = CompileAndRun(gsource)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func Intrinsic_Len_WorksOnFixedArray() {
        // .Length on a fixed-array — already correct, pinned here.
        let gsource = `package Probe.Tests
import System

var a = [2]int32{5, 6}
Console.WriteLine(a.Length)`
        let output = CompileAndRun(gsource)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func SliceFieldStoredAs_IReadOnlyList_EmitsCorrectly() {
        // When a slice is stored in a field typed IReadOnlyList<T>,
        // the emitter must encode the field type as the interface, not
        // the array. Verify by round-tripping through a C# helper.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int Count(System.Collections.Generic.IReadOnlyList<int> items)
        {
            return items.Count;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import System.Collections.Generic
import Probe.CSharp

var items IReadOnlyList[int32] = []int32{7, 8, 9}
Console.WriteLine(Sink.Count(items))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        // ---------------------------------------------------------------
        // Helpers — same pattern as Issue570 tests
        // ---------------------------------------------------------------
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue611_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let (exit, stdout, stderr, outPath, tempDir, siblingDll) = CompileWithSiblingCs(
                csSource,
                gSource,
                siblingName
            )
            try {
                Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
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
                let runOut = proc.StandardOutput.ReadToEnd()
                let runErr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$runOut" + `
stderr:
` + "$runErr"))
                return runOut.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileWithSiblingCs(csSource string, gSource string, siblingName string)(
            Exit int32,
            Stdout string,
            Stderr string,
            OutPath string,
            TempDir string,
            SiblingDll string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue611_sib_").FullName
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
            if compileExit == 0 {
                File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true)
            }
            return (compileExit, compileOut.ToString(), compileErr.ToString(), outPath, tempDir, siblingDll)
        }

        private func BuildCsProject(csDir string, siblingName string) string {
            RunDotnet(csDir, "restore")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) string {
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
            return stdout
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
