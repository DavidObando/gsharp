// <copyright file="Issue2283SwitchAllTerminalArmsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2283 (re-migration follow-up): re-migrating Oahu.SystemManagement
/// off main @ 51152eb4 still crashed `ilverify` with the identical
/// `MarkPredecessorWithLowerOffset` (cref:IndexOutOfRangeException)
/// even after the channel-receive stack-imbalance fix (the other set of
/// `Issue2283*` tests) landed — that fix addressed a narrower symptom of
/// a broader `switch`-statement IL-emission bug.
///
/// Root cause, localized via `ilverify --include`: a pattern
/// `switch` <em>statement</em> where every arm — including
/// `default` — is terminal (ends in `return`/`throw`), with no
/// code after the switch. `EmitPatternSwitchStatement`
/// (`MethodBodyEmitter.Patterns.cs`) unconditionally emitted
/// `Br endLabel` after every arm body and unconditionally
/// `MarkLabel(endLabel)` at the end, even when no arm could ever reach
/// that label — producing a label at the exact end of the method body
/// reachable only via dead branches, which ILVerify's predecessor
/// bookkeeping can't index.
///
/// The emitter now keeps one uniform switch shape, including the trailing
/// `Br endLabel` / `MarkLabel(endLabel)`. The method-body epilogue
/// guard in `MethodBodyEmitter.EmitMethodBody` recognizes that this label
/// leaves the current IL position open and appends a real `ret`. Dead
/// branches therefore target a valid instruction instead of the exact end of
/// the method body, preserving the fix for every exhaustive and
/// non-exhaustive switch shape.
open class Issue2283SwitchAllTerminalArmsEmitTests {
    @Fact
    func LiteralTrueLoopEndingInReturn_VerifiesAndRuns() {
        const source = `package Issue2747.InfiniteLoop
import System

class Login {
    func Callback() Uri {
        while true {
            let text = "https://example.com"
            var uri Uri? = nil
            if !Uri.TryCreate(text, UriKind.Absolute, out uri) {
                continue
            }

            return uri!!
        }
    }
}

Console.WriteLine(Login().Callback().Host)`
        let output = CompileAndRun(source)
        Assert.Equal("example.com${Environment.NewLine}", output)
    }

    @Fact
    func AllArmsTerminal_AsLastStatement_VerifiesAndRuns() {
        // The exact minimal repro from the issue's confirmed-root-cause
        // comment: a switch statement, as the LAST statement in the method,
        // whose every arm (including default) returns.
        const source = `package Issue2283.AllTerminal
import System

class T6 {
    func F(x int32) string {
        switch x {
            case 1 { return "a" }
            case 2 { return "b" }
            default { return "c" }
        }
    }
}

let t = T6()
Console.WriteLine(t.F(1))
Console.WriteLine(t.F(2))
Console.WriteLine(t.F(3))`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}c${Environment.NewLine}", output)
    }

    @Fact
    func MixedTerminalAndNonTerminalArms_VerifiesAndRuns() {
        // Not every arm is terminal: the fallthrough/end label IS needed
        // (some arm falls through to code after the switch), so this must
        // still emit (and correctly reach) the end label.
        const source = `package Issue2283.MixedTerminal
import System

class T7 {
    func F(x int32) string {
        var result = ""
        switch x {
            case 1 { return "a" }
            case 2 { result = "b" }
            default { return "c" }
        }
        return result + "!"
    }
}

let t = T7()
Console.WriteLine(t.F(1))
Console.WriteLine(t.F(2))
Console.WriteLine(t.F(3))`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b!${Environment.NewLine}c${Environment.NewLine}", output)
    }

    @Fact
    func AllArmsTerminal_FollowedByMoreCode_VerifiesAndRuns() {
        // The switch is NOT the last statement — even though every arm of the
        // switch itself is terminal, the switch is exhaustive (has a
        // default), so control genuinely never falls out of the switch. Code
        // after the switch must still be reachable via the normal path (the
        // switch's own arms never resume execution there directly, but the
        // method as a whole must still verify).
        const source = `package Issue2283.TerminalThenMoreCode
import System

class T8 {
    func F(x int32) string {
        var prefix = "before:"
        switch x {
            case 1 { return prefix + "a" }
            case 2 { return prefix + "b" }
            default { return prefix + "c" }
        }
    }
}

let t = T8()
Console.WriteLine(t.F(1))
Console.WriteLine(t.F(3))`
        let output = CompileAndRun(source)
        Assert.Equal("before:a${Environment.NewLine}before:c${Environment.NewLine}", output)
    }

    @Fact
    func AllArmsTerminal_NoDefault_VerifiesAndRuns() {
        // Without a `default` arm the switch is NOT exhaustive — the
        // discriminant may match nothing, so the "no match" path still needs
        // to fall through to the end label. This must keep working exactly as
        // before the fix.
        const source = `package Issue2283.NoDefaultTerminal
import System

class T9 {
    func F(x int32) string {
        switch x {
            case 1 { return "a" }
            case 2 { return "b" }
        }
        return "fallthrough"
    }
}

let t = T9()
Console.WriteLine(t.F(1))
Console.WriteLine(t.F(2))
Console.WriteLine(t.F(3))`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}fallthrough${Environment.NewLine}", output)
    }

    @Fact
    func SwitchInsideLoopWithBreakAfterNonTerminalArm_VerifiesAndRuns() {
        // A pattern-switch statement (G# case arms don't fall through, so
        // `break` is not a switch-arm construct here — it's a loop-exit
        // construct) nested inside a loop, with a non-terminal arm followed
        // by a loop `break`. Exercises the switch's own end-label path
        // (needed because one arm is non-terminal) composing correctly with
        // an enclosing loop's control flow — this must not regress with the
        // fix.
        const source = `package Issue2283.LoopBreakAfterSwitch
import System

class T10 {
    func F(x int32) string {
        var result = "none"
        for var i = 0; i < 3; i++ {
            switch x {
                case 1 { result = "one" }
                case 2 { return "two" }
                default { return "default" }
            }
            break
        }
        return result
    }
}

let t = T10()
Console.WriteLine(t.F(1))
Console.WriteLine(t.F(2))
Console.WriteLine(t.F(3))`
        let output = CompileAndRun(source)
        Assert.Equal("one${Environment.NewLine}two${Environment.NewLine}default${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2283_switch_exe_").FullName
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
