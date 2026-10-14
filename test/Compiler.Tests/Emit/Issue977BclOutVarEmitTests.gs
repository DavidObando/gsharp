// <copyright file="Issue977BclOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #977: an inline `out var`/`out let`/`out _` argument must
/// bind against imported (BCL) method overloads, not only user-defined functions.
/// The defect made `d.TryGetValue("a", out var v)` fail overload resolution
/// (`GS0159 Cannot find function TryGetValue`) even though the equivalent
/// pre-declared pass-by-address (`&slot`) and user-function forms bound
/// fine. These tests cover the imported-method instance-call path:
/// - The local declared by `out var v` is inferred from the chosen overload's by-ref parameter (e.g.
/// `int32` for `Dictionary[string,int32].TryGetValue(TKey, out TValue)`).
/// - Type inference is per-instantiation (`int32` vs `string`).
/// - The pre-declared `&slot` control and the user-function `out var` control keep compiling (no
/// regression).
/// - `out _` discard against a BCL method also binds.
open class Issue977BclOutVarEmitTests {
    @Fact
    func Dictionary_IntValue_InlineOutVar_HitAndMiss() {
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d["a"] = 5
let ok = d.TryGetValue("a", out var v)
Console.WriteLine(ok)
Console.WriteLine(v)
let miss = d.TryGetValue("z", out var w)
Console.WriteLine(miss)
Console.WriteLine(w)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "True${Environment.NewLine}5${Environment.NewLine}False${Environment.NewLine}0${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Dictionary_IntValue_InlineOutVar_LocalIsInferredInt32() {
        // The inferred local participates in int32 arithmetic, proving the type
        // was inferred from the `out TValue` parameter (int32), not left as Error.
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d["a"] = 20
d.TryGetValue("a", out var v)
let doubled int32 = v * 2
Console.WriteLine(doubled)`
        let output = CompileAndRun(source)
        Assert.Equal("40${Environment.NewLine}", output)
    }

    @Fact
    func Dictionary_StringValue_InlineOutVar_PerInstantiationInference() {
        // A second instantiation infers `string` for the same `out var` shape,
        // confirming inference is driven by the constructed receiver type.
        let source = `package P
import System
import System.Collections.Generic

let sd = Dictionary[string, string]()
sd["x"] = "hello"
let ok = sd.TryGetValue("x", out var s)
Console.WriteLine(ok)
Console.WriteLine(s)
Console.WriteLine(s.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}hello${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func Dictionary_PreDeclaredAddressOf_Control_StillCompiles() {
        // Control: BCL out via a pre-declared local passed by address (&slot).
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d["a"] = 7
var slot int32
let ok = d.TryGetValue("a", &slot)
Console.WriteLine(ok)
Console.WriteLine(slot)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func UserFunc_InlineOutVar_Control_StillCompiles() {
        // Control: a user-defined func with an `out` parameter + inline out var.
        let source = `package P
import System

func tryProduce(out result int32) bool {
    result = 42
    return true
}

let ok = tryProduce(out var n)
Console.WriteLine(ok)
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func Dictionary_InlineOutDiscard_AgainstBclMethod() {
        // `out _` discard against a BCL method must also bind and run.
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d["a"] = 9
let ok = d.TryGetValue("a", out _)
Console.WriteLine(ok)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue977_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
