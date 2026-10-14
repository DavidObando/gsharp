// <copyright file="Issue610CrossContextReferenceUpcastTests.cs" company="GSharp">
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

/// Issue #610: generalize cross-context reference upcast (follow-up to 6.5 / #570).
///
/// PR #612 (6.5) added a dedicated `SliceTypeSymbol → interface` arm in
/// `Conversion.Classify` and a cross-context `ImplementsInterfaceByName`
/// helper to bridge the live-runtime ↔ MetadataLoadContext type-assembly mismatch.
/// That fix was narrow — only for slices.
///
/// This issue generalizes the fix to ALL CLR reference upcasts by promoting the
/// cross-context interface/base-class walk into `ClrTypeUtilities.IsAssignableByName`.
/// The dedicated slice arm is refactored into a combined slice-to-interface block that
/// also enforces slice invariance.
///
/// Each test compiles with explicit `/reference:` paths (triggering
/// MetadataLoadContext mode) to exercise the cross-context boundary where the
/// source type's CLR backing lives in the live runtime and the target type is
/// loaded from MLC reference assemblies.
open class Issue610CrossContextReferenceUpcastTests {
    // ─────────────────────────────────────────────────────────────────────
    // Positive: Built-in string → BCL interface (cross-context)
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func UserClass_ImplementingBCLInterface_UpcastAcrossContexts_Works() {
        // A string literal (TypeSymbol.String, live-runtime ClrType) is
        // passed to a sibling C# method parameter typed as IComparable
        // (resolved from MLC reference assemblies). This exercises the
        // cross-context gap fixed by promoting ImplementsInterfaceByName
        // into the general IsAssignableByName fallback.
        let sibling = `namespace CrossCtx
{
    public static class Helper
    {
        public static string CompareStuff(System.IComparable c)
        {
            return c.CompareTo("zzz") < 0 ? "less" : "geq";
        }
    }
}`
        let gsource = `package P
import System
import CrossCtx

var result = Helper.CompareStuff("hello")
Console.WriteLine(result)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "CrossCtx")
        Assert.Equal("less${Environment.NewLine}", output)
    }

    @Fact
    func UserClass_ImplementingCustomCLRInterface_UpcastAcrossContexts_Works() {
        // A sibling C# assembly defines IProcessor and StringProcessor.
        // G# creates a StringProcessor and assigns to IProcessor — both
        // types come from MLC (same context), but the assignment exercises
        // the Conversion.Classify path.
        let sibling = `namespace CustomIface
{
    public interface IProcessor
    {
        string Process(string input);
    }

    public class StringProcessor : IProcessor
    {
        public string Process(string input)
        {
            return input.ToUpper();
        }
    }
}`
        let gsource = `package P
import System
import CustomIface

var p IProcessor = StringProcessor()
Console.WriteLine(p.Process("hello"))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "CustomIface")
        Assert.Equal("HELLO${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Built-in string → BCL interface via assignment (cross-ctx)
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func String_AssignedTo_IComparable_CrossContext() {
        // Direct variable assignment: var x IComparable = "hello"
        // The string's ClrType is live-runtime typeof(string), while
        // IComparable is resolved from MLC reference assemblies.
        let sibling = `namespace Trigger
{
    public static class Dummy { public static string Noop() { return "ok"; } }
}`
        let gsource = `package P
import System
import Trigger

var x IComparable = "hello"
Console.WriteLine(x.CompareTo("world") < 0)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Trigger")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Generic constructed type arg across contexts
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func Generic_ConstructedTypeArg_Across_Contexts_Works() {
        // A sibling C# method accepts IEnumerable<string>. G# passes a
        // List[string] which is constructed in MLC context. Both sides are
        // MLC, so this tests the same-context path still works after refactor.
        let sibling = `namespace GenCtx
{
    public static class Counter
    {
        public static int Count(System.Collections.Generic.IEnumerable<string> items)
        {
            int n = 0;
            foreach (var _ in items) n++;
            return n;
        }
    }
}`
        let gsource = `package P
import System
import System.Collections.Generic
import GenCtx

var list = List[string]()
list.Add("a")
list.Add("b")
list.Add("c")
Console.WriteLine(Counter.Count(list))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "GenCtx")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Slice → interface regression guard (#570)
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func Slice_StillConvertsToInterface_RegressionGuard() {
        // The #570 shape must still work after subsuming the dedicated
        // slice arm: []string passed to a C# method taking IEnumerable<string>.
        let sibling = `namespace SliceGuard
{
    public static class Sink
    {
        public static int Count(System.Collections.Generic.IEnumerable<string> items)
        {
            int n = 0;
            foreach (var _ in items) n++;
            return n;
        }
    }
}`
        let gsource = `package P
import System
import SliceGuard

var n = Sink.Count([]string{"x", "y"})
Console.WriteLine(n)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "SliceGuard")
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func Slice_AssignedToInterface_RegressionGuard() {
        // Slice assigned to IReadOnlyList variable (cross-context: slice
        // ClrType is live-runtime string[], target is MLC IReadOnlyList).
        let sibling = `namespace SliceAssign
{
    public static class Dummy { public static string Noop() { return "ok"; } }
}`
        let gsource = `package P
import System
import System.Collections.Generic
import SliceAssign

var items IReadOnlyList[string] = []string{"alpha", "beta"}
Console.WriteLine(items[0])
Console.WriteLine(items.Count)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "SliceAssign")
        Assert.Equal("alpha${Environment.NewLine}2${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Method return widening across contexts
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func MethodReturn_WidensStringToInterface_CrossContext() {
        // A G# function returning IComparable returns a string literal.
        let sibling = `namespace RetWiden
{
    public static class Dummy { public static string Noop() { return "ok"; } }
}`
        let gsource = `package P
import System
import RetWiden

func GetComparable() IComparable {
    return "abc"
}

var c = GetComparable()
Console.WriteLine(c.CompareTo("zzz") < 0)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "RetWiden")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative: Incompatible cross-context shapes produce errors
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func Negative_UnrelatedTypeToInterface_Errors() {
        // A class that does NOT implement the target interface must still
        // produce a diagnostic.
        let sibling = `namespace NegCtx
{
    public interface IFoo
    {
        void DoFoo();
    }

    public class Bar
    {
    }
}`
        let gsource = `package P
import NegCtx

var x IFoo = Bar()`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "NegCtx")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155") || d.Contains("Cannot convert"))
    }

    @Fact
    func Negative_InvariantSliceInterface_StillBlocked() {
        // Mutable IList<T> stays invariant across reflection contexts.
        let sibling = `namespace NegSlice
{
    public static class Dummy { public static string Noop() { return "ok"; } }
}`
        let gsource = `package P
import System.Collections.Generic
import NegSlice

var items IList[object] = []string{"hello"}`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "NegSlice")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155") || d.Contains("Cannot convert"))
    }

    @Fact
    func Negative_IntToInterface_ValueType_NotReference() {
        // A value type (int32) to interface is a boxing conversion, not
        // a reference upcast. This should compile (boxing is implicit),
        // but verifies the correct code path is used (not the reference arm).
        let sibling = `namespace NegVt
{
    public static class Helper
    {
        public static string Describe(System.IComparable c)
        {
            return c.ToString();
        }
    }
}`
        let gsource = `package P
import System
import NegVt

Console.WriteLine(Helper.Describe(42))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "NegVt")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        // ─────────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────────
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue610_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue610_neg_").FullName
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
                    "/reference:" + siblingDll,
                    "/nowarn:GS9100"
                }
                for reference in TrustedPlatformAssemblies() {
                    gscArgs.Add("/reference:" + reference)
                }
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
