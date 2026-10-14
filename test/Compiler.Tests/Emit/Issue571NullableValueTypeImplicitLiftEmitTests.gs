// <copyright file="Issue571NullableValueTypeImplicitLiftEmitTests.cs" company="GSharp">
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

/// Issue #571: passing a value-type `T` (e.g. `System.TimeSpan`) to a
/// CLR constructor or method parameter typed `T?` (e.g. `TimeSpan?`)
/// triggered an emit-time ICE — `GS9998 TypeBuilder generic instantiation
/// does not support resolving members` — with a bogus `(1,1,1,1)`
/// location in an unrelated source file.
///
/// Root cause: every Nullable<T> construction in the emit pipeline used
/// host-runtime `typeof(System.Nullable<>).MakeGenericType(innerClr)`.
/// When `innerClr` was MLC-backed (an imported value type like
/// `TimeSpan`), the constructed `Nullable<TimeSpan>` mixed the
/// host-side `Nullable<>` open generic with an MLC-backed
/// `TimeSpan` argument. Encoding the resulting ctor / member reference
/// then failed inside `TypeBuilder`/`MetadataBuilder`.
///
/// PR N-2 reroutes every Nullable<T> construction in the emit pipeline
/// through (cref:GSharp.Core.CodeAnalysis.Symbols.NullableLifting.TryConstructNullable),
/// which resolves `System.Nullable`1` from the `ReferenceResolver`
/// and projects the inner value type onto the same load context.
open class Issue571NullableValueTypeImplicitLiftEmitTests {
    @Fact
    func TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Sibling_Ctor() {
        // Exact repro from the issue body: a sibling C# class whose ctor
        // accepts `TimeSpan?`, invoked from G# with a bare `TimeSpan` value.
        // Before the fix this emitted GS9998 with a bogus `(1,1,1,1)`
        // location pointing at an unrelated file.
        let sibling = `namespace Probe.CSharp
{
    public sealed class TimespanCtor
    {
        public TimespanCtor(System.TimeSpan? delay = null) { Delay = delay; }
        public System.TimeSpan? Delay { get; }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var c = TimespanCtor(TimeSpan.FromSeconds(2.0))
Console.WriteLine(c.Delay.HasValue)
Console.WriteLine(c.Delay.Value.TotalSeconds)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("True${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Sibling_Method() {
        // Same lift but at an instance-method call site rather than a ctor.
        // Exercises the MethodBodyEmitter.Conversions path for arguments to
        // CLR methods on imported sibling types.
        let sibling = `namespace Probe.CSharp
{
    public sealed class DelayBag
    {
        public System.TimeSpan? Last { get; private set; }
        public void Record(System.TimeSpan? delay) { Last = delay; }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var bag = DelayBag()
bag.Record(TimeSpan.FromSeconds(5.0))
Console.WriteLine(bag.Last.HasValue)
Console.WriteLine(bag.Last.Value.TotalSeconds)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("True${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Local() {
        // A purely local lift `var d TimeSpan? = TimeSpan.FromSeconds(...)`
        // exercises the same emit path without an intervening sibling type;
        // it guards against host-runtime regressions in the same site.
        let sibling = `namespace Probe.CSharp
{
    public static class Sink
    {
        public static void Take(System.TimeSpan? t) { System.Console.WriteLine(t.HasValue); }
    }
}`
        let gsource = `package Probe.Tests
import System
import Probe.CSharp

var d = TimeSpan.FromSeconds(3.0)
Sink.Take(d)`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue571_sib_").FullName
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
            let _ = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
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
