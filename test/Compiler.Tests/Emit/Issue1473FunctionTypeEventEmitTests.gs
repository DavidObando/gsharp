// <copyright file="Issue1473FunctionTypeEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1473 — a field-like event whose handler is a function-type delegate
/// (`event E (args) -> ret`, mapped by G# to `System.Action<...>`/
/// `System.Func<...>`) emitted invalid IL in its generated `add_`/
/// `remove_` accessors when a type argument of the delegate is a user-declared
/// type. The closed delegate has no runtime CLR (cref:Type), so the EventDef
/// type and accessor-body `castclass` fell back to `System.Delegate`, which
/// disagreed with the `Interlocked.CompareExchange<T>` CAS loop spec and
/// failed ilverify with `StackUnexpected`. The fix encodes the concrete closed
/// delegate as a TypeSpec so all tokens agree.
/// - Facet A — the minimal repro: an instance function-type event `(object?, Args) -> void` with a user
/// `Args`; subscribe, fire, unsubscribe.
/// - Facet B — a `Func`-shaped function-type event (non-void return) of a different arity with a
/// user-type argument, to prove generality.
/// - Facet C — a STATIC field-like function-type event with a user-type argument, exercising the static
/// add/remove accessor path (`EmitStaticEventAddAccessor`/ `EmitStaticEventRemoveAccessor`). G# has no
/// call-form raise for static field-like events, so this facet exercises subscribe/unsubscribe and
/// relies on the in-harness ilverify pass to prove the static accessor IL is valid.
/// All three failed ilverify on current main and pass after the fix.
open class Issue1473FunctionTypeEventEmitTests {
    @Fact
    func EndToEnd_FacetA_InstanceActionEventWithUserArg_Runs() {
        let source = `package EN1473A
import System
class ArgsA1473 : EventArgs {
    prop Value int32 { get; init; }
}
class SourceA1473 {
    event Fired (object?, ArgsA1473) -> void
    func Fire() {
        Fired?(this, ArgsA1473() { Value = 7 })
    }
}
func Main() {
    let s = SourceA1473()
    s.Fired += (sender object?, a ArgsA1473) -> Console.WriteLine(a.Value)
    s.Fire()
    s.Fired -= (sender object?, a ArgsA1473) -> Console.WriteLine(a.Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_InstanceFuncEventWithUserArg_Runs() {
        let source = `package EN1473B
import System
class PayloadB1473 {
    prop Amount int32 { get; init; }
}
class SourceB1473 {
    event Compute (PayloadB1473) -> string
    func Invoke(p PayloadB1473) string {
        let r = Compute?(p)
        return r ?? "none"
    }
}
func Main() {
    let s = SourceB1473()
    s.Compute += (p PayloadB1473) -> p.Amount.ToString()
    let r = s.Invoke(PayloadB1473() { Amount = 21 })
    Console.WriteLine(r)
    s.Compute -= (p PayloadB1473) -> p.Amount.ToString()
}`
        let output = CompileAndRun(source)
        Assert.Equal("21${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetC_StaticActionEventWithUserArg_Runs() {
        let source = `package EN1473C
import System
class ArgsC1473 : EventArgs {
    prop Value int32 { get; init; }
}
class SourceC1473 {
    shared {
        event Pinged (object?, ArgsC1473) -> void
    }
}
func Main() {
    SourceC1473.Pinged += (sender object?, a ArgsC1473) -> Console.WriteLine(a.Value)
    SourceC1473.Pinged -= (sender object?, a ArgsC1473) -> Console.WriteLine(a.Value)
    Console.WriteLine("static-ok")
}`
        let output = CompileAndRun(source)
        Assert.Equal("static-ok${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1473_exe_").FullName
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
