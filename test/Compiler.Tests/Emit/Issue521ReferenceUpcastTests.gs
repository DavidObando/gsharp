// <copyright file="Issue521ReferenceUpcastTests.cs" company="GSharp">
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

/// Comprehensive regression tests for GitHub issue #521: "Binder: concrete
/// class cannot be upcast to an implemented interface (GS0155 on both user
/// and BCL types)".
///
/// The underlying fixes live in:
/// • 6.4 (PR #609): `MemberLookup.SafeGet*IncludingSelfAndInterfaces`
/// — interface member resolution now walks the full inheritance chain
/// instead of probing only the declared type, which unblocked dispatch
/// through upcast receivers.
/// • 6.5 (PR #612): `ClrTypeUtilities.ImplementsInterfaceByName` —
/// cross-MetadataLoadContext type identity comparison for interface
/// satisfaction (used by the general #521 reference-upcast arm in
/// `Conversion.Classify`).
///
/// Each test compiles via the in-process `gsc` entry point, IL-verifies
/// the produced PE via `dotnet-ilverify`, then runs the assembly under
/// `dotnet exec` and asserts on captured stdout. The IL verification
/// catches spurious `castclass` / stack-type mismatches; the execution
/// proves the upcast dispatches correctly at runtime.
open class Issue521ReferenceUpcastTests {
    @Fact
    func UserClass_ToUserInterface_ImplicitUpcast_CompilesAndRuns() {
        // Issue body repro: `let g IGreeter = HelloGreeter()` where
        // IGreeter + HelloGreeter are defined in a sibling C# assembly.
        let gSource = `package P
import System
import Greeting

var g IGreeter = HelloGreeter()
Console.WriteLine(g.Greet("world"))`
        let output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting")
        Assert.Equal("Hello, world${Environment.NewLine}", output)
    }

    @Fact
    func UserClass_ToUserInterface_ExplicitCast_CompilesAndRuns() {
        // Issue comment repro: `IGreeter(HelloGreeter())` explicit-cast form.
        let gSource = `package P
import System
import Greeting

var g = IGreeter(HelloGreeter())
Console.WriteLine(g.Greet("cast"))`
        let output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting")
        Assert.Equal("Hello, cast${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: BCL class → BCL interface
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func BclClass_ToBclInterface_ImplicitUpcast_CompilesAndRuns() {
        // Issue body repro: `let l IReadOnlyList[string] = List[string]()`
        let source = `package P
import System
import System.Collections.Generic

var mut = List[string]()
mut.Add("alpha")
mut.Add("beta")
var r IReadOnlyList[string] = mut
Console.WriteLine(r[0])
Console.WriteLine(r[1])`
        let output = CompileAndRun(source)
        Assert.Equal("alpha${Environment.NewLine}beta${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: BCL class → BCL abstract base class
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func BclClass_ToBclAbstractBase_ImplicitUpcast_CompilesAndRuns() {
        // Issue comment repro: `let tw TextWriter = StringWriter()`
        let source = `package P
import System
import System.IO

var tw TextWriter = StringWriter()
tw.Write("hello")
tw.Write(" upcast")
Console.WriteLine(tw.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("hello upcast${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Lambda/function return-type widening
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func LambdaReturn_WidensConcreteToInterface_CompilesAndRuns() {
        // Returning a concrete type where the function return type is an
        // interface exercises the upcast at the return-value site.
        let gSource = `package P
import System
import Greeting

func MakeGreeter() IGreeter {
    return HelloGreeter()
}

Console.WriteLine(MakeGreeter().Greet("lambda"))`
        let output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting")
        Assert.Equal("Hello, lambda${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Method-argument widening (interface + abstract base)
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func MethodArgument_WidensConcreteToInterface_CompilesAndRuns() {
        // Passing a concrete class to a method parameter typed as an
        // interface — the argument-slot conversion must widen.
        let gSource = `package P
import System
import Greeting

func Run(g IGreeter, name string) {
    Console.WriteLine(g.Greet(name))
}

Run(HelloGreeter(), "arg")`
        let output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting")
        Assert.Equal("Hello, arg${Environment.NewLine}", output)
    }

    @Fact
    func MethodArgument_WidensConcreteToAbstractBase_CompilesAndRuns() {
        // Passing a StringWriter where the parameter is typed TextWriter.
        let source = `package P
import System
import System.IO

func Scribble(tw TextWriter) {
    tw.Write("scribbled")
}

var sw = StringWriter()
Scribble(sw)
Console.WriteLine(sw.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("scribbled${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Generic IEnumerable with concrete List
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func Generic_IEnumerable_AcceptsConcreteList() {
        // Passing a List<string> where IEnumerable<string> is expected.
        let source = `package P
import System
import System.Collections.Generic

func CountItems(items IEnumerable[string]) int32 {
    var count = 0
    for x in items {
        count = count + 1
    }
    return count
}

var list = List[string]()
list.Add("one")
list.Add("two")
list.Add("three")
Console.WriteLine(CountItems(list))`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative: Unrelated types still produce GS0155
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func UnrelatedTypes_ConcreteToInterface_StillErrorsGS0155() {
        // A concrete class that does NOT implement the target interface
        // must still fail with GS0155 — the upcast should not be a blanket
        // pass-through.
        let sibling = `namespace Neg
{
    public interface IUnrelated
    {
        void DoStuff();
    }

    public class NotImplementing
    {
    }
}`
        let gSource = `package P
import System
import Neg

var x IUnrelated = NotImplementing()`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gSource, siblingName: "Neg")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155") || d.Contains("Cannot convert"))
    }

    // ─────────────────────────────────────────────────────────────────────
    // Slice interface implementation composes with declared generic variance.
    // ─────────────────────────────────────────────────────────────────────
    @Fact
    func Slice_AllowsSafeCovariantInterfaceConversion() {
        let source = `package P
import System
import System.Collections.Generic

var s = []string{"hello"}
var e IEnumerable[object] = s
Console.WriteLine(Object.ReferenceEquals(s, e))`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        // ─────────────────────────────────────────────────────────────────────
        // Positive: User-defined class → user-defined interface (sibling C#)
        // ─────────────────────────────────────────────────────────────────────
        private const GreetingSiblingCs string = `namespace Greeting
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public class HelloGreeter : IGreeter
    {
        public string Greet(string name)
        {
            return "Hello, " + name;
        }
    }
}`

        // ─────────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────────
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue521_ref_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
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

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue521_sib_").FullName
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

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue521_neg_").FullName
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

        private func CompileExpectingErrorsWithSiblingCs(csSource string, gSource string, siblingName string) List[
            string
        ] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue521_neg_sib_").FullName
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
