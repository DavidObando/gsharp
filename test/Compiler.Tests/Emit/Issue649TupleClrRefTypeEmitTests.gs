// <copyright file="Issue649TupleClrRefTypeEmitTests.cs" company="GSharp">
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

/// Issue #649: Any tuple containing a CLR reference type from a project
/// reference triggered `GS9998: NotSupportedException: TypeBuilder generic
/// instantiation does not support resolving members`. The root cause was
/// that `EmitTupleElementAccess` called `.GetField()` and
/// `EmitTupleLiteral` called `.GetConstructors()` on the closed
/// `ValueTuple<...>` generic — which throws when any type argument
/// is loaded via MetadataLoadContext. The fix resolves fields and constructors
/// from the open generic type definition instead.
open class Issue649TupleClrRefTypeEmitTests {
    @Fact
    func Tuple2_OneClrRefType_ReturnsAndDestructures() {
        // (Holder, string) — the exact shape from the issue.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (Holder, string) {
    return (Holder() { A = "x" }, "b")
}

let (h, s) = make()
Console.Write(h.A)
Console.Write("|")
Console.Write(s)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("x|b", output)
    }

    @Fact
    func Tuple2_TwoClrRefTypes_OneNested() {
        // (Holder, Holder2.Nested) — two CLR ref types, one nested.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (Holder, Holder2.Nested) {
    return (Holder() { A = "alpha" }, Holder2.Nested() { B = "beta" })
}

let (h, n) = make()
Console.Write(h.A)
Console.Write("|")
Console.Write(n.B)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("alpha|beta", output)
    }

    @Fact
    func Tuple4_ClrRefTypeWithPrimitives() {
        // (Holder, int32, string, string) — 4-element tuple with CLR ref type.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (Holder, int32, string, string) {
    return (Holder() { A = "val" }, 42, "c", "d")
}

let (h, i, s1, s2) = make()
Console.Write(h.A)
Console.Write("|")
Console.Write(i.ToString())
Console.Write("|")
Console.Write(s1)
Console.Write("|")
Console.Write(s2)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("val|42|c|d", output)
    }

    @Fact
    func Tuple_DirectItemAccess_WithoutDestructure() {
        // Use t.Item1, t.Item2 without destructure — tests the same ldfld path.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (Holder, string) {
    return (Holder() { A = "direct" }, "access")
}

let t = make()
Console.Write(t.Item1.A)
Console.Write("|")
Console.Write(t.Item2)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("direct|access", output)
    }

    @Fact
    func Tuple_WithGSharpDefinedRefType() {
        // A tuple containing a G#-defined class (TypeBuilder-backed) alongside
        // a CLR ref type from the sibling — tests both directions of the
        // mixed-arg generic instantiation.
        let gsource = `package Probe
import System
import Probe.CSharp

class MyClass {
    var Name string
    init() {}
}

func make() (MyClass, Holder) {
    return (MyClass() { Name = "gs" }, Holder() { A = "cs" })
}

let (mc, h) = make()
Console.Write(mc.Name)
Console.Write("|")
Console.Write(h.A)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("gs|cs", output)
    }

    @Fact
    func Tuple_AsParameterType() {
        // Tuple containing CLR ref type passed as a function parameter.
        let gsource = `package Probe
import System
import Probe.CSharp

func consume(t (Holder, string)) string {
    return t.Item1.A + "|" + t.Item2
}

let t = (Holder() { A = "param" }, "test")
Console.Write(consume(t))`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("param|test", output)
    }

    @Fact
    func Tuple_AsFieldType() {
        // Tuple containing CLR ref type stored as a field in a G# class.
        let gsource = `package Probe
import System
import Probe.CSharp

class Container {
    var Data (Holder, int32)
    init() {
        Data = (Holder() { A = "field" }, 99)
    }
}

var c = Container()
Console.Write(c.Data.Item1.A)
Console.Write("|")
Console.Write(c.Data.Item2.ToString())`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("field|99", output)
    }

    @Fact
    func Tuple7_MaxWithoutRest_ClrRefType() {
        // 7-element tuple (max arity without TRest) containing a CLR ref type.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (Holder, int32, int32, int32, int32, int32, string) {
    return (Holder() { A = "seven" }, 1, 2, 3, 4, 5, "end")
}

let (h, a, b, c, d, e, s) = make()
Console.Write(h.A)
Console.Write("|")
Console.Write(s)`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("seven|end", output)
    }

    @Fact
    func Tuple_PrimitivesOnly_StillWorks() {
        // Sanity check: primitives-only tuples (which worked before) still work.
        let gsource = `package Probe
import System
import Probe.CSharp

func make() (string, int32, string, int32) {
    return ("a", 1, "b", 2)
}

let (s1, i1, s2, i2) = make()
Console.Write(s1)
Console.Write(i1.ToString())
Console.Write(s2)
Console.Write(i2.ToString())`
        let output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("a1b2", output)
    }

    shared {
        private const HolderSiblingCs string = `namespace Probe.CSharp
{
    public sealed class Holder
    {
        public string A { get; init; } = "";
    }

    public sealed class Holder2
    {
        public int X { get; init; }

        public sealed class Nested
        {
            public string B { get; init; } = "";
        }
    }
}`

        // --- Helpers ---
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue649_sib_").FullName
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
                // Place the sibling next to the produced assembly so the
                // probing path resolves it at runtime.
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
