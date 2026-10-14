// <copyright file="Issue2069NamedDelegateUsageEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2069 — a NAMED delegate type (`delegate Name(...) ...`);
/// used as the type of a local variable, a class field/auto-property, or a
/// function parameter crashed emit with `InvalidOperationException: Delegate
/// '...' has no emitted TypeDef`.
///
/// Root cause: several lowering passes (`InterpolatedStringHandlerLowerer`,
/// `SideEffectSpiller`) reconstruct a new (cref:GSharp.Core.CodeAnalysis.Binding.BoundProgram)
/// from a prior one but omitted the `Delegates` constructor argument,
/// silently truncating `BoundProgram.Delegates` to empty (the
/// convenience overload defaults it when not supplied). The emitter's
/// named-delegate TypeDef pass iterates exactly that (now-empty) collection,
/// so any named delegate never got an emitted TypeDef whenever one of those
/// rewriters ran on the compilation — which happens whenever a statement
/// needs side-effect spilling (e.g. a property/field assignment used again as
/// an argument in the same statement), not merely by referencing the type.
/// The fix threads `program.Delegates` through both reconstructions,
/// matching the other two BoundProgram-rebuilding rewriters
/// (`BaseCallForwarderRewriter`, `CaptureBoxingRewriter`) that
/// already did this correctly.
///
/// Each fact below uses a UNIQUE package name because the in-process type
/// caches are name-keyed.
open class Issue2069NamedDelegateUsageEmitTests {
    @Fact
    func EndToEnd_NamedDelegate_AsLocalVariableType_Runs() {
        const source = `package i2069local
import System

delegate TickHandler(n int32) void;

func Main() {
    var h TickHandler = (n int32) -> System.Console.WriteLine(n * 2)
    h(21)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegate_AsFieldAndParamType_Runs() {
        // Reproduces the exact issue #2069 shape: a named-delegate-typed
        // auto-property assigned via a member-access setter and then reread
        // as an argument in the SAME statement, which forces the
        // SideEffectSpiller rewriter to reconstruct BoundProgram.
        const source = `package i2069fieldparam
import System

delegate TickHandler(n int32) void;

class C {
    prop H TickHandler { get; set; }
}

func Apply(h TickHandler) {
    h(1)
}

func Main() {
    var c = C()
    c.H = (n int32) -> System.Console.WriteLine(n + 99)
    Apply(c.H)
}`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegate_AsPlainFieldType_Runs() {
        const source = `package i2069plainfield
import System

delegate TickHandler(n int32) void;

class C {
    var H TickHandler
}

func Main() {
    var c = C()
    c.H = (n int32) -> System.Console.WriteLine(n)
    c.H(7)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegate_AsParameterType_Runs() {
        const source = `package i2069param
import System

delegate TickHandler(n int32) void;

func Apply(h TickHandler) {
    h(5)
}

func Main() {
    Apply((n int32) -> System.Console.WriteLine(n * 10))
}`
        let output = CompileAndRun(source)
        Assert.Equal("50${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2069_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
    }
}
