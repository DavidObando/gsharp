// <copyright file="Issue2841NullableNamedDelegateTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2841 — a lambda converted to a named delegate `D` but not to
/// `D?`.
///
/// Root cause: `Conversion.IsReferenceLikeTarget` had no
/// (cref:GSharp.Core.CodeAnalysis.Symbols.DelegateTypeSymbol) case, and a
/// source-declared named delegate carries no `ClrType` at bind time, so the
/// trailing `ClrType` fallback could not recognise it either. The
/// `T -> U?` arm of nullable classification (issue #1121) is gated on
/// that predicate, so it never ran and every delegate-conversion arm below it
/// tested the still-wrapped `NullableTypeSymbol` target and failed.
///
/// Each fact uses a UNIQUE package name because the in-process type caches are
/// name-keyed.
open class Issue2841NullableNamedDelegateTargetEmitTests {
    @Fact
    func EndToEnd_LambdaAssignedToNullableNamedDelegateLocal_Runs() {
        // The exact issue #2841 shape: `var h D? = nil` then `h = lambda`.
        const source = `package i2841assign
import System

delegate PlainDel(x int32, cb (string) -> void) void;

func Main() {
    var h PlainDel? = nil
    h = (x int32, cb (string) -> void) -> { cb("a" + System.Convert.ToString(x)) }
    if h != nil {
        h(1, (s string) -> System.Console.WriteLine(s))
    }
}`
        Assert.Equal("a1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaInitializesNullableNamedDelegateLocal_Runs() {
        // The second failing row of the issue's truth table: `let h D? = lambda`.
        const source = `package i2841init
import System

delegate PlainDel(x int32, cb (string) -> void) void;

func Main() {
    let h PlainDel? = (x int32, cb (string) -> void) -> { cb("b" + System.Convert.ToString(x)) }
    if h != nil {
        h(2, (s string) -> System.Console.WriteLine(s))
    }
}`
        Assert.Equal("b2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaPassedToNullableNamedDelegateParameter_Runs() {
        // Argument position — the shape Oahu actually hits (`job.Do(ctx, action)`
        // where the parameter is declared `Conv?`).
        const source = `package i2841param
import System

delegate PlainDel(x int32) void;

func Apply(h PlainDel?) {
    if h != nil {
        h(5)
    }
}

func Main() {
    Apply((x int32) -> System.Console.WriteLine(x * 10))
    Apply(nil)
    System.Console.WriteLine("done")
}`
        Assert.Equal("50${Environment.NewLine}done${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaAssignedToNullableNamedDelegateProperty_Runs() {
        const source = `package i2841prop
import System

delegate PlainDel(x int32) void;

class C {
    prop H PlainDel? { get; set; }
}

func Main() {
    var c = C()
    c.H = (x int32) -> System.Console.WriteLine(x + 1)
    let h = c.H
    if h != nil {
        h(41)
    }
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaReturnedAsNullableNamedDelegate_Runs() {
        const source = `package i2841ret
import System

delegate PlainDel(x int32) void;

func Make(enabled bool) PlainDel? {
    if !enabled {
        return nil
    }

    return (x int32) -> System.Console.WriteLine(x - 1)
}

func Main() {
    let h = Make(true)
    if h != nil {
        h(8)
    }

    System.Console.WriteLine(Make(false) == nil)
}`
        Assert.Equal("7${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_MethodGroupAssignedToNullableNamedDelegate_Runs() {
        // Issue #2841 asks for method-group coverage alongside lambda literals:
        // the method-group path must reach the same nullable-stripped target.
        const source = `package i2841mg
import System

delegate PlainDel(x int32) void;

func Show(x int32) {
    System.Console.WriteLine(x * 4)
}

func Main() {
    var h PlainDel? = nil
    h = Show
    if h != nil {
        h(6)
    }

    let g PlainDel? = Show
    if g != nil {
        g(7)
    }
}`
        Assert.Equal("24${Environment.NewLine}28${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_NonNullableNamedDelegateValueFlowsIntoNullableSlot_Runs() {
        // The symmetric direction the issue calls out: a `D` value assigned into
        // a `D?` slot. A fix must not regress this widening.
        const source = `package i2841widen
import System

delegate PlainDel(x int32) void;

func Apply(h PlainDel?) {
    if h != nil {
        h(9)
    }
}

func Main() {
    let d PlainDel = (x int32) -> System.Console.WriteLine(x + 100)
    var slot PlainDel? = d
    Apply(d)
    if slot != nil {
        slot(11)
    }
}`
        Assert.Equal("109${Environment.NewLine}111${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaAndNilAgainstNullableImportedDelegate_Runs() {
        // Control for an IMPORTED BCL delegate target: `System.Action[int32]?`
        // already resolves through the ClrType arm, so it must stay green.
        const source = `package i2841imported
import System

func Apply(h System.Action[int32]?) {
    if h != nil {
        h(12)
    }
}

func Main() {
    var h System.Action[int32]? = nil
    h = (x int32) -> System.Console.WriteLine(x * 2)
    Apply(h)
    Apply(nil)
    System.Console.WriteLine("ok")
}`
        Assert.Equal("24${Environment.NewLine}ok${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_NonNullableNamedDelegateTargetStillRuns() {
        // Control: the passing rows of the issue's truth table must stay green.
        const source = `package i2841control
import System

delegate PlainDel(x int32) void;

func Apply(h PlainDel) {
    h(3)
}

func Main() {
    let a PlainDel = (x int32) -> System.Console.WriteLine(x)
    a(1)
    var b PlainDel = (x int32) -> System.Console.WriteLine(x)
    b = (x int32) -> System.Console.WriteLine(x * 2)
    b(2)
    Apply((x int32) -> System.Console.WriteLine(x * 3))
}`
        Assert.Equal("1${Environment.NewLine}4${Environment.NewLine}9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LambdaAssignedToNullableGenericNamedDelegate_Runs() {
        // A generic named delegate closed over a concrete argument, still in a
        // nullable slot — the shape closest to Oahu's `Conv[T]?` parameter.
        const source = `package i2841generic
import System

delegate Conv[T](value T, cb (string) -> void) void;

func Run(c Conv[int32]?, v int32) {
    if c != nil {
        c(v, (s string) -> System.Console.WriteLine(s))
    }
}

func Main() {
    var c Conv[int32]? = nil
    c = (value int32, cb (string) -> void) -> { cb("g" + System.Convert.ToString(value)) }
    Run(c, 4)
    Run(nil, 0)
    System.Console.WriteLine("end")
}`
        Assert.Equal("g4${Environment.NewLine}end${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2841_exe_").FullName
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
