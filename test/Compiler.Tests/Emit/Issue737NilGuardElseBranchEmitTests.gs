// <copyright file="Issue737NilGuardElseBranchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #737 — pre-existing if-else lowering bug exposed by ADR-0069
/// nullable-reference narrowing: when both arms of an `if/else` end
/// in an unconditional control transfer (e.g. each arm returns), the
/// lowerer emitted a dead `goto endLabel` after the then-arm and a
/// trailing `endLabel:` label whose IL offset landed past the final
/// `ret` of the method body. The CLR JIT rejected the assembly with
/// `System.InvalidProgramException`. The original repro surfaced
/// inside a nil-guard else-branch on a nullable reference because that is
/// the canonical "use the narrowed value" shape, but the underlying bug
/// is purely about the if-else terminator analysis in the lowerer and
/// applies to every reference / value / primitive type.
///
/// Each test compiles via in-process `gsc`, IL-verifies the emitted
/// PE (so the prior past-end `br` is caught here, not only at JIT
/// time), and runs the assembly under `dotnet exec`, asserting
/// captured stdout.
open class Issue737NilGuardElseBranchEmitTests {
    @Fact
    func IfElse_BothBranchesReturn_String_ElseBranchReadsNarrowed() {
        let source = `package Test
import System

func Length(s string?) int32 {
    if s == nil {
        return -1
    } else {
        return s.Length
    }
}

Console.WriteLine(Length("hello"))
Console.WriteLine(Length(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_PositiveGuard_ThenBranchReadsNarrowed() {
        let source = `package Test
import System

func Use(s string) int32 {
    return s.Length
}

func Length(s string?) int32 {
    if s != nil {
        return Use(s)
    }
    return -1
}

Console.WriteLine(Length("hi"))
Console.WriteLine(Length(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesReturn_OrComposition_ElseReadsNarrowed() {
        // Issue #712 (PR #736) had to use the post-if-lift form for the
        // emit coverage of `||` nil-guard composition because this form
        // tripped the pre-existing #737 bug. Now that #737 is fixed, the
        // else-branch form is the cleaner shape and must work end-to-end.
        let source = `package Test
import System

func Length(s string?, force bool) int32 {
    if s == nil || force {
        return -1
    } else {
        return s.Length
    }
}

Console.WriteLine(Length("hello", false))
Console.WriteLine(Length("hello", true))
Console.WriteLine(Length(nil, false))`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesReturn_ChainedAndGuard() {
        // Multiple-variable narrowing: `a != nil && b != nil` must narrow
        // both `a` and `b` in the then-arm even when both arms of the
        // outer if-else terminate.
        let source = `package Test
import System

func Both(a string?, b string?) int32 {
    if a != nil && b != nil {
        return a.Length + b.Length
    } else {
        return -1
    }
}

Console.WriteLine(Both("hi", "ya"))
Console.WriteLine(Both("hi", nil))
Console.WriteLine(Both(nil, "ya"))`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesReturn_UserClass_ElseReadsNarrowed() {
        let source = `package Test
import System

class Greeter {
    var Name string
    func Greet() string { return "hi " + Name }
}

func DescribeOrDefault(g Greeter?) string {
    if g == nil {
        return "none"
    } else {
        return g.Greet()
    }
}

Console.WriteLine(DescribeOrDefault(Greeter{Name: "Alice"}))
Console.WriteLine(DescribeOrDefault(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("hi Alice${Environment.NewLine}none${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesReturn_Interface_ElseReadsNarrowed() {
        // IDisposable is a CLR-imported interface; the narrowed read
        // observes it as a non-nullable reference and the in-else call
        // must compile to a plain `ldarg` + `callvirt` — no Nullable<T>
        // unwrap, no boxing.
        let source = `package Test
import System

class MyDisposable : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}

func Read(d IDisposable?) string {
    if d == nil {
        return "none"
    } else {
        d.Dispose()
        return "ok"
    }
}

var d IDisposable = MyDisposable{}
Console.WriteLine(Read(d))
Console.WriteLine(Read(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}ok${Environment.NewLine}none${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesReturn_NonNullableBaseline_NoNarrowing() {
        // The same shape on non-nullable values must also produce
        // verifiable IL — the bug was in the lowerer's if-else
        // terminator analysis, NOT in nullable-reference narrowing.
        let source = `package Test
import System

func Classify(n int32) int32 {
    if n > 0 {
        return 1
    } else {
        return -1
    }
}

Console.WriteLine(Classify(5))
Console.WriteLine(Classify(-3))`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func IfElse_BothBranchesThrow_StillEmitsValidIl() {
        // `throw` is the other unconditional control transfer; both
        // branches throwing should not corrupt the trailing IL either.
        let source = `package Test
import System

func MustHave(s string?) {
    if s == nil {
        throw System.InvalidOperationException("nil!")
    } else {
        throw System.InvalidOperationException("got: " + s)
    }
}

try {
    MustHave("hi")
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    MustHave(nil)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal("got: hi${Environment.NewLine}nil!${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue737_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
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
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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
