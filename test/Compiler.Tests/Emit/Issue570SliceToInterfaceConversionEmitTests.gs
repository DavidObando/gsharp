// <copyright file="Issue570SliceToInterfaceConversionEmitTests.cs" company="GSharp">
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

/// Issue #570: a G# slice value `[]T` did not implicitly convert to the
/// interfaces implemented by its backing CLR array `T[]`, such as
/// `IEnumerable<T>`, `IReadOnlyList<T>`,
/// `IList<T>`, etc. The binder rejected the assignment with
/// `GS0154: Parameter '…' requires a value of type 'IEnumerable<string>'
/// but was given a value of type '[]string'.` The spec states that "slices
/// are backed by CLR arrays", so every interface a CLR `T[]` implements
/// must be reachable from a `[]T` via an implicit, no-op conversion. The
/// fix adds a dedicated arm in `Conversion.Classify` that walks the
/// array's interface set by name (cross-MLC safe via
/// `ClrTypeUtilities.ImplementsInterfaceByName`).
open class Issue570SliceToInterfaceConversionEmitTests {
    @Fact
    func SliceLiteral_PassedAs_IEnumerableOfT() {
        // The issue body's primary repro: a []string slice literal is
        // passed to a C# method taking IEnumerable<string>.
        let sibling = `namespace Probe.CSharp
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
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var n = Sink.Count([]string{"a", "b"})
Console.WriteLine(n)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_IReadOnlyListOfT() {
        // IReadOnlyList<T> — the most commonly-requested interface target
        // from the issue discussion.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int CountViaRoList(System.Collections.Generic.IReadOnlyList<string> items)
        {
            return items.Count;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var n = Sink.CountViaRoList([]string{"x", "y"})
Console.WriteLine(n)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_IListOfT() {
        // IList<T> — confirms the slice can satisfy a mutable-list interface.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static string ReadFirst(System.Collections.Generic.IList<string> items)
        {
            return items[0];
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

Console.WriteLine(Sink.ReadFirst([]string{"hello", "world"}))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_ICollectionOfT() {
        // ICollection<T>.Count property.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int CountViaCollection(System.Collections.Generic.ICollection<string> items)
        {
            return items.Count;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

Console.WriteLine(Sink.CountViaCollection([]string{"a", "b", "c"}))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_IReadOnlyCollectionOfT() {
        // IReadOnlyCollection<T>.Count property.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int CountViaRoCollection(System.Collections.Generic.IReadOnlyCollection<string> items)
        {
            return items.Count;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

Console.WriteLine(Sink.CountViaRoCollection([]string{"a", "b", "c", "d"}))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_NonGenericIEnumerable() {
        // Non-generic IEnumerable — arrays implement it too.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int CountViaPlainEnumerable(System.Collections.IEnumerable items)
        {
            int n = 0;
            foreach (var _ in items) n++;
            return n;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

Console.WriteLine(Sink.CountViaPlainEnumerable([]string{"a", "b", "c"}))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_PassedAs_SystemObject_SmokeTest() {
        // Slice → System.Object already worked via the line-282 rule;
        // smoke test that the new arm doesn't conflict.
        let gsource = `package Probe.Tests
import System

func takeObj(o object) string { return o.ToString() ?? "" }
Console.WriteLine(takeObj([]int32{1, 2, 3}).StartsWith("System.Int32"))`
        let output = CompileAndRun(gsource)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func SliceLiteral_AssignedToProperty_TypedIReadOnlyListOfT() {
        // Same as the #528 property-assignment test but for an interface target.
        let sibling = `namespace Probe.CSharp
{
    public sealed class Container
    {
        public System.Collections.Generic.IReadOnlyList<string> Items { get; set; }
            = System.Array.Empty<string>();
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var c = Container()
c.Items = []string{"alpha", "beta"}
Console.WriteLine(c.Items.Count)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func SliceInvariance_StringToIListOfObject_StillRejected() {
        // IList<T> is invariant and mutable. CLR array covariance must not
        // bypass G#'s exact-element requirement for this interface.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static int CountObjects(System.Collections.Generic.IList<object> items)
            => items.Count;
    }
}`
        let gsource = `package Probe.Tests
import Probe.CSharp

Sink.CountObjects([]string{"a"})`
        let diags = CompileAndCollectDiagnosticsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        // Rejected either as GS0154 (wrong argument type) or GS0159
        // (cannot find function — overload resolution rejects the candidate
        // because the invariant generic-arg check blocks array covariance).
        Assert.True(diags.Contains("GS0154") || diags.Contains("GS0159"), (`Expected GS0154 or GS0159 but got:
` + "$diags"))
    }

    @Fact
    func SliceLiteral_PassedAs_IReadOnlyListOfString_ViaGSharpFunc() {
        // Real-world repro shape: a G# function taking IReadOnlyList<string>
        // receives a []string literal (mirrors System.CommandLine.Command.Parse
        // scenario from issue body).
        let sibling = `namespace Probe.CSharp
{
    public static class Parser
    {
        public static string ParseFirst(System.Collections.Generic.IReadOnlyList<string> args)
        {
            return args.Count > 0 ? args[0] : "<empty>";
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

Console.WriteLine(Parser.ParseFirst([]string{"--help", "--verbose"}))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("--help${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue570_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue570_sib_").FullName
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
