// <copyright file="Issue659DimOutParamEmitTests.cs" company="GSharp">
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

/// Issue #659: a G# class cannot implement a CLR interface that contains a
/// Default Interface Method (DIM) when the interface also has methods using
/// out/ref parameters. Two root causes:
/// 1) `DeclarationBinder.VerifyClrInterfaceImplementations` did not skip
/// DIM (non-abstract) methods — so it demanded implementations for them.
/// 2) `MemberLookup.FindMatchingMethodForClrSignature` compared
/// `callable[i].Type` against the CLR by-ref parameter type without
/// unwrapping the ByRef envelope or checking RefKind, so out/ref params
/// never matched.
open class Issue659DimOutParamEmitTests {
    @Fact
    func DimWithOutParam_AbstractMethodImplemented_CompilesAndRuns() {
        // Exact repro from the issue: interface with an abstract method taking
        // an out parameter and a DIM (non-abstract) overload.
        let sibling = `using System;
namespace Probe.CSharp
{
    public interface IKeyReader
    {
        bool TryReadKey(int millisecondsTimeout, out ConsoleKeyInfo key);
        bool TryReadKey(out ConsoleKeyInfo key) => TryReadKey(0, out key);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MyReader : IKeyReader {
    func TryReadKey(millisecondsTimeout int32, out key ConsoleKeyInfo) bool {
        key = ConsoleKeyInfo('A', ConsoleKey.A, false, false, false)
        return true
    }
}

var r = MyReader{}
var k ConsoleKeyInfo
var result = r.TryReadKey(100, out k)
if result {
    Console.WriteLine(k.KeyChar)
}`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("A${Environment.NewLine}", output)
    }

    @Fact
    func DimOnly_NoAbstractMembers_ClassNotRequiredToImplementAnything() {
        // Interface with ONLY a DIM (no abstract members) — the implementing
        // class should compile without providing any method body.
        let sibling = `namespace Probe.CSharp
{
    public interface IOptional
    {
        int GetValue() => 42;
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Empty : IOptional {
}

var o IOptional = Empty{}
Console.WriteLine(o.GetValue())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func DimExplicitlyOverridden_StillMatches() {
        // A G# class explicitly provides a body for a method that also has a
        // DIM. The class's implementation should take precedence.
        let sibling = `using System;
namespace Probe.CSharp
{
    public interface IKeyReader2
    {
        bool TryReadKey(int millisecondsTimeout, out ConsoleKeyInfo key);
        bool TryReadKey(out ConsoleKeyInfo key) => TryReadKey(0, out key);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class FullReader : IKeyReader2 {
    func TryReadKey(millisecondsTimeout int32, out key ConsoleKeyInfo) bool {
        key = ConsoleKeyInfo('B', ConsoleKey.B, false, false, false)
        return true
    }
    func TryReadKey(out key ConsoleKeyInfo) bool {
        key = ConsoleKeyInfo('C', ConsoleKey.C, false, false, false)
        return true
    }
}

var r = FullReader{}
var k ConsoleKeyInfo
var result = r.TryReadKey(out k)
if result {
    Console.WriteLine(k.KeyChar)
}`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("C${Environment.NewLine}", output)
    }

    @Fact
    func RefParam_MatchesCorrectly() {
        // Interface with a ref parameter — should compile and run correctly.
        let sibling = `namespace Probe.CSharp
{
    public interface ISwapper
    {
        void Swap(ref int a, ref int b);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MySwapper : ISwapper {
    func Swap(ref a int32, ref b int32) {
        var tmp = a
        a = b
        b = tmp
    }
}

var s ISwapper = MySwapper{}
var x = 1
var y = 2
s.Swap(ref x, ref y)
Console.WriteLine(x)
Console.WriteLine(y)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func MissingImplementation_StillRaisesGS0187() {
        // Regression guard: a genuine missing interface method must still
        // produce GS0187 after the DIM fix.
        let sibling = `namespace Probe.CSharp
{
    public interface IRequired
    {
        void DoWork();
        int GetCount();
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class Incomplete : IRequired {
    func DoWork() {
    }
}`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GetCount"))
    }

    @Fact
    func OutParam_WithoutDim_MatchesCorrectly() {
        // Interface with only an out parameter (no DIM) — verifies the
        // by-ref matching fix in isolation from the DIM fix.
        let sibling = `namespace Probe.CSharp
{
    public interface IParser
    {
        bool TryParse(string input, out int result);
    }
}`
        let gsource = `package Probe
import System
import Probe.CSharp

class MyParser : IParser {
    func TryParse(input string, out result int32) bool {
        result = 42
        return true
    }
}

var p = MyParser{}
var v int32
var ok = p.TryParse("hello", out v)
if ok {
    Console.WriteLine(v)
}`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue659_sib_").FullName
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

        private func CompileExpectingErrorsWithSiblingCs(csSource string, gSource string, siblingName string) List[
            string
        ] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue659_err_").FullName
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
                    "/target:library",
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
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
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
