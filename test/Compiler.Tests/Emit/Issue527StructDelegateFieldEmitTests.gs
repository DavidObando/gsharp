// <copyright file="Issue527StructDelegateFieldEmitTests.cs" company="GSharp">
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

/// Issue #527: public fields on a CLR `struct` imported through a sibling
/// assembly were unreachable from G#. Reading the field reported
/// `GS0158: Cannot find member`; assigning to it likewise reported
/// `GS0158`; and an invocation on a delegate-typed field
/// (`bag.OnAsk()`) reported `GS0159: Cannot find function`. After
/// the fix, public fields on CLR structs behave like public fields on CLR
/// classes: they are readable, writable, and (when delegate-typed) invokable.
/// The emitter must produce verifiable IL for all three forms.
open class Issue527StructDelegateFieldEmitTests {
    @Fact
    func ClrStruct_Int32Field_ReadWrite_RoundTrips() {
        // The simplest case: a public int field on a CLR struct. Before the
        // fix, even this failed because the binder/emitter took a
        // value-typed receiver path that lost track of public fields.
        let sibling = `namespace Probe.CSharp
{
    public struct CounterBag
    {
        public int Counter;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var bag = CounterBag()
bag.Counter = 42
Console.WriteLine(bag.Counter)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ClrStruct_StringField_ReadWrite_RoundTrips() {
        // A reference-typed field still needs to round-trip; the field
        // store/load IL must use the right `stfld`/`ldfld` rather than a
        // boxed surrogate.
        let sibling = `namespace Probe.CSharp
{
    public struct NameBag
    {
        public string Name;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var bag = NameBag()
bag.Name = "hello"
Console.WriteLine(bag.Name)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func ClrStruct_DelegateField_AssignReadInvoke_Works() {
        // The exact issue-body repro plus a read of the delegate value: the
        // field is assigned a function literal, read back into a local
        // (`var f = bag.OnAsk`), invoked through the local, and invoked
        // through the field directly. All three steps must compile and
        // produce verifiable IL.
        let sibling = `namespace Probe.CSharp
{
    public struct CallbackBag
    {
        public System.Func<string> OnAsk;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var bag = CallbackBag()
bag.OnAsk = func() string { return "hello" }
var f = bag.OnAsk
Console.WriteLine(f())
Console.WriteLine(bag.OnAsk())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hello${Environment.NewLine}hello${Environment.NewLine}", output)
    }

    @Fact
    func ClrStruct_PassedByValue_MutationsDoNotEscape() {
        // CLR semantics: passing a struct by value copies it, so any
        // mutations made inside the callee must not be visible to the
        // caller. This is a behavioral regression guard — the emitter must
        // not accidentally pass the struct by reference.
        let sibling = `namespace Probe.CSharp
{
    public struct CounterBag
    {
        public int Counter;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

func Bump(b CounterBag) {
    b.Counter = b.Counter + 100
}

var bag = CounterBag()
bag.Counter = 1
Bump(bag)
Console.WriteLine(bag.Counter)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func ClrStruct_DelegateField_InsideMethodBody_AssignReadInvoke_Works() {
        // The exact issue-body repro: a G# class method body invokes the
        // delegate field on a local CLR-struct value. This mirrors the
        // shape from the bug report (GS0158 on the assignment, GS0159 on
        // the invocation). Confirms that the fix carries through to
        // method-body binding (Stream A's accessor chain) just like the
        // top-level binding path.
        let sibling = `namespace Probe.CSharp
{
    public struct CallbackBag
    {
        public System.Func<string> OnAsk;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

class StructFieldProbe {
    func Test() string {
        var bag = CallbackBag()
        bag.OnAsk = func() string { return "hello" }
        return bag.OnAsk()
    }
}

var probe = StructFieldProbe{}
Console.WriteLine(probe.Test())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func ClrClass_DelegateField_AssignReadInvoke_Works_RegressionGuard() {
        // Regression guard: the same scenario on a CLR class (not a struct)
        // already worked before the fix and must keep working after it. If
        // the fix accidentally re-routes class field access, this catches it.
        let sibling = `namespace Probe.CSharp
{
    public class CallbackHolder
    {
        public System.Func<string> OnAsk;
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var holder = CallbackHolder()
holder.OnAsk = func() string { return "world" }
Console.WriteLine(holder.OnAsk())`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("world${Environment.NewLine}", output)
    }

    @Fact
    func GSharpStruct_DelegateField_AssignReadInvoke_Works() {
        // G#-defined struct with a delegate-typed field exercises the same
        // call-as-field path through the binder/emitter without crossing the
        // import boundary. The struct is value-typed, so the field load
        // emits `ldloca; ldfld` (the by-ref-receiver path for value types).
        let source = `package Probe.Tests
import System

struct CallbackBag {
    var OnAsk func() string
}

var bag = CallbackBag{ OnAsk: func() string { return "hi" } }
Console.WriteLine(bag.OnAsk())`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue527_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue527_sib_").FullName
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
