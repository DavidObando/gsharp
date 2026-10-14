// <copyright file="Issue1617BaseInitializerArgForwardingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1617 (drift 4): `EmitClassConstructorWithBaseInitializerBodyBytes`
/// (the primary-constructor / forwarding `: Base(args)` scaffold) forwarded
/// its base-constructor arguments with a plain per-argument
/// `emitter.EmitValue(arg)` loop, while its sibling
/// `EmitClassConstructorWithBodyBodyBytes` (explicit `init(...)` with a
/// base initializer) uses the ref-kind-aware
/// `emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds)`.
/// This test locks the forwarding behavior of the primary-ctor scaffold now that
/// both scaffolds share the ref-kind-aware helper.
///
/// NOTE: this drift is <b>latent</b> — it produces no observable behavioral
/// difference on current G#. By-reference (`ref`/`out`/`in`) base
/// arguments are only ever bound (with populated `ArgumentRefKinds`) for a
/// CLR base whose constructor declares a by-ref parameter, and G# requires an
/// explicit `&`/`ref` at the call site, producing a
/// `BoundAddressOfExpression` that `EmitValue`/`EmitExpression`
/// already lowers to the same address IL that `EmitBaseConstructorArguments`
/// emits. No G#-expressible base-initializer forwards a by-ref argument through
/// this primary-ctor scaffold, so the two code paths were behaviorally
/// equivalent. The fix removes the textual drift (required so the Step-2
/// scaffold unification is byte-identical) and makes any future by-ref base-arg
/// support automatically cover this scaffold. This test therefore passes both
/// before and after the fix; it guards the by-value forwarding path.
///
/// Uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1617BaseInitializerArgForwardingEmitTests {
    @Fact
    func EndToEnd_PrimaryCtorClass_ForwardsBaseArgsToClrBase_Runs() {
        const source = (`package i1617baseinit
import System

class Wrapped1617(msg string, inner Exception) : Exception(msg, inner) { }

func Main() {
    var root = System.InvalidOperationException("root-1617")
    var w = Wrapped1617("outer-1617", root)
    System.Console.WriteLine(w.Message)
    // Issue #4356: ` + "`" + `Exception.InnerException` + "`" + ` is declared
    // ` + "`" + `Exception?` + "`" + ` by the annotated BCL, so reading through it is a
    // dereference of a member its author said may be nil. Member
    // lookup used to wave that through — the carve-out #4356
    // deleted could not tell an annotated-nullable member from an
    // oblivious one — and now asks for the proof, exactly as it
    // always has for a source-declared ` + "`" + `T?` + "`" + `. What this test is
    // about is base-argument forwarding, which is unaffected.
    System.Console.WriteLine(w.InnerException!!.Message)
}`)
        let output = CompileAndRun(source)
        Assert.Equal("outer-1617${Environment.NewLine}root-1617${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1617baseinit_exe_").FullName
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
