// <copyright file="Issue528SliceToArrayConversionEmitTests.cs" company="GSharp">
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

/// Issue #528: a G# slice value `[]T` did not implicitly convert to a CLR
/// array `T[]`, so it could not be assigned to a CLR property/field of
/// type `T[]` nor passed as a parameter of type `T[]`. The binder
/// rejected the assignment with `GS0155: Cannot convert type '[]string' to
/// 'System.String[]'.` The spec is explicit that "slices are backed by CLR
/// arrays", so this direction must be implicit and a no-op at the CLR / IL
/// level — the runtime representation of a slice already is a one-dimensional
/// zero-based `T[]`. The reverse direction (CLR array → slice) already
/// worked; the regression guard below pins it.
open class Issue528SliceToArrayConversionEmitTests {
    @Fact
    func SliceLiteral_AssignsTo_ClrArrayProperty() {
        // The exact issue-body repro: a slice literal assigned to a C#
        // property typed `string[]`. Before the fix this reported
        // `GS0155 Cannot convert type '[]string' to 'System.String[]'`.
        let sibling = `namespace Probe.CSharp
{
    public sealed class LibraryItem
    {
        public string[] Authors { get; set; } = System.Array.Empty<string>();
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var item = LibraryItem()
item.Authors = []string{"Andy Weir"}
Console.WriteLine(item.Authors.Length)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_AssignsTo_ClrArrayField() {
        // Same conversion through a CLR public field rather than a property.
        // Catches a regression where the fix would route only through property
        // setters and miss field stores.
        let sibling = `namespace Probe.CSharp
{
    public sealed class LibraryItem
    {
        public string[] AuthorsField = System.Array.Empty<string>();
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var item = LibraryItem()
item.AuthorsField = []string{"a", "b", "c"}
Console.WriteLine(item.AuthorsField.Length)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func SliceArgument_PassedTo_ClrMethodWithArrayParameter() {
        // A `[]int32` slice passed as a `int[]` parameter to a CLR method.
        // Confirms element-type identity for value-typed elements (G# int32
        // ↔ CLR System.Int32) and the conversion rule applies to argument
        // position, not just assignment.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int Sum(int[] xs)
        {
            int s = 0;
            foreach (var x in xs)
            {
                s += x;
            }

            return s;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var nums = []int32{1, 2, 3, 4}
Console.WriteLine(Sink.Sum(nums))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func SliceReturned_FromGSharpFunctionLiteral_ToClrDelegateReturningArray() {
        // The implicit slice → array conversion must apply in return position
        // too. A G# `func` literal returning `[]string` is assigned to a CLR
        // `Func<string[]>` delegate-typed parameter, and the C# callee invokes
        // it and reads the array back. This is the "return a slice from a
        // function whose return type is `T[]`" scenario from the issue,
        // expressed through a delegate (G# can declare slice return types
        // syntactically but not CLR-array return types).
        let sibling = `namespace Probe.CSharp
{
    public static class Caller
    {
        public static int InvokeAndCount(System.Func<string[]> maker)
        {
            var arr = maker();
            return arr.Length;
        }

        public static string InvokeAndPick(System.Func<string[]> maker, int index)
        {
            return maker()[index];
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var n = Caller.InvokeAndCount(func() []string { return []string{"a", "b", "c"} })
Console.WriteLine(n)
Console.WriteLine(Caller.InvokeAndPick(func() []string { return []string{"alpha", "beta", "gamma"} }, 1))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}beta${Environment.NewLine}", output)
    }

    @Fact
    func RoundTrip_Slice_To_Array_To_Slice_PreservesLength() {
        // Round-trip: a G# slice is handed to a C# helper that takes a
        // `string[]` parameter and returns the same `string[]`. The returned
        // CLR array is then bound back to a G# `[]string` slice. Both
        // conversions are implicit and the round-tripped length matches the
        // original. (G# has no syntax for a CLR array TYPE-CLAUSE locally, so
        // the array round-trips through a C# helper.)
        let sibling = `namespace Probe.CSharp
{
    public static class RoundTripHelper
    {
        public static string[] Echo(string[] xs)
        {
            return xs;
        }

        public static int LengthOf(string[] xs)
        {
            return xs.Length;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var slice = []string{"x", "y", "z"}
var slice2 []string = RoundTripHelper.Echo(slice)
Console.WriteLine(slice.Length)
Console.WriteLine(slice2.Length)
Console.WriteLine(RoundTripHelper.LengthOf(slice))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}3${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func ClrArray_FromMethod_ConvertsImplicitlyTo_Slice_RegressionGuard() {
        // Regression guard for the reverse direction (CLR array → slice),
        // which already worked before this PR. A C# method returns `int[]`
        // and the result binds to a G# `[]int32` slice variable; range/append
        // must continue to work on it.
        let sibling = `namespace Probe.CSharp
{
    public static class Maker
    {
        public static int[] Range(int n)
        {
            var r = new int[n];
            for (int i = 0; i < n; i++)
            {
                r[i] = i;
            }

            return r;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var s []int32 = Maker.Range(4)
var total int32 = 0
for _, v in s {
    total = total + v
}

Console.WriteLine(total)
Console.WriteLine(s.Length)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("6${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func SliceVariance_StringToObjectArray_StillRejected() {
        // Variance regression guard: G# slices are invariant in their
        // element type, and the new slice → CLR array rule must follow the
        // same invariance. `[]string → object[]` is therefore not implicit
        // (even though the CLR would allow the reference upcast). If a
        // future spec relaxes this, the test should be updated explicitly.
        //
        // Issue #3685: the rejection is unchanged — what moved is the
        // diagnostic. Now that the covariant array upcast has an EXPLICIT
        // spelling (`cast[[]object](...)`), the classifier reports GS0156
        // ("an explicit conversion exists") instead of the dead-end GS0155,
        // pointing the author at the cast. Assert GS0156 and assert GS0155
        // is absent, so this still fails loudly if the conversion ever
        // becomes implicit.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Bag
    {
        public object[] Items { get; set; } = System.Array.Empty<object>();
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var b = Bag()
b.Items = []string{"a"}`
        let diags = CompileAndCollectDiagnosticsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Contains("GS0156", diags)
        Assert.DoesNotContain("GS0155", diags)
    }

    @Fact
    func SliceToSlice_Assignment_StillWorks_RegressionGuard() {
        // Slice → slice (same element type) was already identity; ensure the
        // new branch did not perturb that path.
        let gsource = `package Probe.Tests
import System

var a = []int32{1, 2, 3}
var b []int32 = a
Console.WriteLine(b.Length)`
        let output = CompileAndRun(gsource)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue528_").FullName
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

        private func CompileAndCollectDiagnosticsWithSiblingCs(
            csSource string,
            gSource string,
            siblingName string
        ) string {
            let (_, stdout, stderr, _, tempDir, _) = CompileWithSiblingCs(csSource, gSource, siblingName)
            try {
                return stdout + "\n" + stderr
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue528_sib_").FullName
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
            let stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
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
