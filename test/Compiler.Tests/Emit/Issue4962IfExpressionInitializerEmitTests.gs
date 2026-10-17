// <copyright file="Issue4962IfExpressionInitializerEmitTests.cs" company="GSharp">
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

/// Issue #4962 / ADR-0064: end-to-end coverage for the if-expression's
/// `if init; cond` initializer. Each test compiles through in-process
/// `gsc`, IL-verifies the PE, runs it under `dotnet exec` and compares
/// stdout byte for byte. The initializer lowers to a block expression around
/// the conditional, so these tests pin that it runs exactly once, before the
/// condition, and that only the selected branch (or `else if` link) runs.
open class Issue4962IfExpressionInitializerEmitTests {
    @Fact
    func IssueRepro_StatementAndExpressionFormsPrintTheSameValue() {
        let statement = `import System
func g() int32 { return 5 }
if var v = g(); v > 3 { Console.WriteLine("init ${v}") } else { Console.WriteLine("no") }`
        let expression = `import System
func g() int32 { return 5 }
let s = if var v = g(); v > 3 { "init ${v}" } else { "no" }
Console.WriteLine(s)`
        Assert.Equal("init 5${Environment.NewLine}", CompileAndRun(statement))
        Assert.Equal(CompileAndRun(statement), CompileAndRun(expression))
    }

    @Fact
    func Initializer_RunsOnceBeforeTheCondition_AndElseIfLinksShortCircuit() {
        let source = `import System
func Tick(name string, v int32) int32 {
    Console.WriteLine("init ${name}")
    return v
}
func Check(name string, v int32, limit int32) bool {
    Console.WriteLine("check ${name} ${v}")
    return v > limit
}
func Run(n int32) string -> if var a = Tick("a", n); Check("a", a, 10) {
    "then ${a}"
} else if var b = Tick("b", a * 2); Check("b", b, 4) {
    "mid ${a} ${b}"
} else {
    "else ${a} ${b}"
}
Console.WriteLine(Run(20))
Console.WriteLine(Run(3))
Console.WriteLine(Run(1))`
        let nl = Environment.NewLine
        Assert.Equal(
            "init a${nl}check a 20${nl}then 20${nl}" +
                "init a${nl}check a 3${nl}init b${nl}check b 6${nl}mid 3 6${nl}" +
                "init a${nl}check a 1${nl}init b${nl}check b 2${nl}else 1 2${nl}",
            CompileAndRun(source)
        )
    }

    @Fact
    func Initializer_RunsOncePerEvaluationInALoop() {
        let source = `import System
var calls = 0
func Next(i int32) int32 {
    calls++
    return i
}
for var i = 0; i < 3; i++ {
    Console.WriteLine(if var v = Next(i); v > 0 { "pos ${v}" } else { "zero" })
}
Console.WriteLine("calls ${calls}")`
        let nl = Environment.NewLine
        Assert.Equal("zero${nl}pos 1${nl}pos 2${nl}calls 3${nl}", CompileAndRun(source))
    }

    @Fact
    func TrailingIfInLambdaBlockBody_WithInitializer_RunsLikeTheStatementForm() {
        // A trailing else-terminated `if` in an arrow-lambda block body is the
        // expression form with void branches; before issue #4962 it did not
        // parse with an initializer.
        let source = `import System
func g() int32 { return 5 }
let act = () -> { if var v = g(); v > 3 { Console.WriteLine("lambda ${v}") } else { Console.WriteLine("no") } }
act()
let pick = (n int32) -> { if var d = n * 2; d > 5 { "big ${d}" } else { "small ${d}" } }
Console.WriteLine(pick(1) + " " + pick(9))`
        let nl = Environment.NewLine
        Assert.Equal("lambda 5${nl}small 2 big 18${nl}", CompileAndRun(source))
    }

    @Fact
    func InitializerLocal_CapturedByABranchLambda() {
        let source = `import System
func Make(n int32) () -> int32 {
    return if var k = n + 1; k > 1 { () -> k * 10 } else { () -> -k }
}
Console.WriteLine(Make(1)())
Console.WriteLine(Make(-1)())`
        let nl = Environment.NewLine
        Assert.Equal("20${nl}0${nl}", CompileAndRun(source))
    }

    @Fact
    func AwaitInInitializer_InAsyncFunction() {
        let source = `import System
import System.Threading.Tasks
async func Later(v int32) Task[int32] {
    await Task.Yield()
    return v
}
async func Pick(n int32) Task[string] {
    return if var v = await Later(n); v > 3 { "big ${v}" } else { "small ${v}" }
}
Console.WriteLine(Pick(7).Result + " " + Pick(1).Result)`
        Assert.Equal("big 7 small 1${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4962_").FullName
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
