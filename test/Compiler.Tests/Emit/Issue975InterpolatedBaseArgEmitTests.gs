// <copyright file="Issue975InterpolatedBaseArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #975: end-to-end emit tests proving that an interpolated string in a
/// `: base(...)` constructor-argument position is lowered like an ordinary
/// call argument instead of reaching the emitter as a raw
/// `BoundInterpolatedStringExpression` (which previously ICE'd with
/// `GS9998`). Each test compiles via `gsc`, runs `ilverify`, then
/// executes the produced assembly under `dotnet exec` to assert the
/// interpolation renders correctly at runtime.
open class Issue975InterpolatedBaseArgEmitTests {
    @Fact
    func InterpolatedMessage_ForwardedToBase_CompilesAndRuns() {
        // The exact repro from issue #975: a single-hole interpolated string
        // forwarded to the base Exception constructor.
        let source = `package Probe
import System

class E1 : Exception {
    init(n int32) : base("only $n left") {
    }
}

try {
    throw E1(3)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal("only 3 left${Environment.NewLine}", output)
    }

    @Fact
    func InterpolatedMessage_MultipleHolesAndFormatSpecifier_CompilesAndRuns() {
        // Multiple holes, an embedded expression hole, an alignment + format
        // specifier, all in base-initializer position.
        let source = `package Probe
import System

class E2 : Exception {
    init(n int32, who string) : base("$who has ${n:D3} items, next [${n + 1,4:X2}]") {
    }
}

try {
    throw E2(7, "bob")
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal("bob has 007 items, next [  08]${Environment.NewLine}", output)
    }

    @Fact
    func LiteralAndConcatBaseArguments_StillCompileAndRun() {
        // Controls from the issue: a plain literal and a string-concat base
        // argument must keep compiling and rendering correctly.
        let source = `package Probe
import System

class E3 : Exception { init(n int32) : base("plain literal") { } }
class E4 : Exception { init(n int32) : base("only " + n.ToString() + " left") { } }

try {
    throw E3(1)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    throw E4(9)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal("plain literal${Environment.NewLine}only 9 left${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue975_").FullName
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
                } catch {
                    // ignored

                }
            }
        }
    }
}
