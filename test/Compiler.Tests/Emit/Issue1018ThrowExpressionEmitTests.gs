// <copyright file="Issue1018ThrowExpressionEmitTests.cs" company="GSharp">
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

/// Issue #1018: `throw` usable as an EXPRESSION (a throw-expression),
/// mirroring C# (`x ?? throw e`, `cond ? a : throw e`, arrow bodies,
/// returned operands, arguments). The throw-expression has the bottom
/// (`never`) type, so the surrounding `??` / conditional takes the
/// sibling operand's type. Each test compiles via `gsc`, IL-verifies the
/// produced PE, then executes it under `dotnet exec` and asserts on the
/// captured stdout / exit code. The existing `throw` STATEMENT must keep
/// working unchanged.
open class Issue1018ThrowExpressionEmitTests {
    @Fact
    func NullCoalesceThrow_LeftNonNull_ReturnsLeft() {
        let source = `package P

import System

func firstNonNull(s string?) string {
    return s ?? throw Exception("was null")
}

Console.WriteLine(firstNonNull("hello"))`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func NullCoalesceThrow_LeftNull_Throws() {
        let source = `package P

import System

func firstNonNull(s string?) string {
    return s ?? throw Exception("boom-null")
}

var got = "none"
try {
    Console.WriteLine(firstNonNull(nil))
} catch (e Exception) {
    got = e.Message
}

Console.WriteLine(got)`
        let output = CompileAndRun(source)
        Assert.Equal("boom-null${Environment.NewLine}", output)
    }

    @Fact
    func NullCoalesceThrow_LeftNull_UncaughtExitsNonZero() {
        let source = `package P

import System

func firstNonNull(s string?) string {
    return s ?? throw Exception("uncaught")
}

Console.WriteLine(firstNonNull(nil))`
        let (exitCode, _, stderr) = CompileAndRunRaw(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("uncaught", stderr)
    }

    @Fact
    func TernaryThrow_TrueBranchTaken_ReturnsValue() {
        let source = `package P

import System

func pick(cond bool, a int32) int32 {
    return cond ? a : throw Exception("nope")
}

Console.WriteLine(pick(true, 42).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func TernaryThrow_FalseBranchThrows() {
        let source = `package P

import System

func pick(cond bool, a int32) int32 {
    return cond ? a : throw Exception("ternary-boom")
}

var got = "none"
try {
    Console.WriteLine(pick(false, 42).ToString())
} catch (e Exception) {
    got = e.Message
}

Console.WriteLine(got)`
        let output = CompileAndRun(source)
        Assert.Equal("ternary-boom${Environment.NewLine}", output)
    }

    @Fact
    func TernaryThrow_TrueBranchThrows() {
        let source = `package P

import System

func pick(cond bool, a string) string {
    return cond ? throw Exception("true-boom") : a
}

var got = "none"
try {
    Console.WriteLine(pick(true, "x"))
} catch (e Exception) {
    got = e.Message
}

Console.WriteLine(got)`
        let output = CompileAndRun(source)
        Assert.Equal("true-boom${Environment.NewLine}", output)
    }

    @Fact
    func ThrowExpression_InLambdaArrowBody() {
        let source = `package P

import System

func need(s string?) string {
    let f = (v string?) -> v ?? throw Exception("lambda null")
    return f(s)
}

Console.WriteLine(need("ok"))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func ThrowOnlyLambda_TypedFactoryShapes_ThrowThroughToCatch() {
        // Issue #2716: `() -> never` must lower to each target signature while
        // retaining the throw as the only runtime control-flow edge.
        let source = `package P

import System

interface IAuthService {
}

class ServiceFactories {
    private var _auth () -> IAuthService = () -> throw InvalidOperationException("auth")

    func Auth() IAuthService -> this._auth()
}

delegate NumberFactory() int32;

let numberFactory Func[int32] = () -> throw InvalidOperationException("number")
let namedFactory NumberFactory = () -> throw InvalidOperationException("named")
let action Action = () -> throw InvalidOperationException("action")

let factories = ServiceFactories()
try {
    factories.Auth()
    Console.WriteLine("unreachable auth")
} catch (e InvalidOperationException) {
    Console.WriteLine(e.Message)
}
try {
    numberFactory()
    Console.WriteLine("unreachable number")
} catch (e InvalidOperationException) {
    Console.WriteLine(e.Message)
}
try {
    namedFactory()
    Console.WriteLine("unreachable named")
} catch (e InvalidOperationException) {
    Console.WriteLine(e.Message)
}
try {
    action()
    Console.WriteLine("unreachable action")
} catch (e InvalidOperationException) {
    Console.WriteLine(e.Message)
}
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Equal(
            "auth${Environment.NewLine}number${Environment.NewLine}named${Environment.NewLine}action${Environment.NewLine}done${Environment.NewLine}",
            output
        )
    }

    @Fact
    func ThrowOnlyLambda_TargetlessAndGenericInference_EmitAndRun() {
        // Issues #4994, #5003: targetless throw-expression lambdas materialize
        // as void delegates (`Action` / `Action<...>`), and generic calls with
        // both a `never` operand and a concrete operand infer the concrete type.
        let source = `package P

import System

func Choose[T](a T, b T) T -> a

let f = () -> throw Exception("zero")
let g = (x int32) -> throw Exception("arg:${x}")
let nested = () -> (() -> throw Exception("nested"))
let voidAdapted Action = (() -> (() -> throw Exception("void-adapted")))
let assertedCond = (() -> {
    if true { return () -> throw Exception("asserted-cond") }
    return nil
})()!!
let nestedCleanupTup = () -> ({
    defer Console.WriteLine("cleanup-in-tup")
    () -> throw Exception("tup-cleanup-lam")
}, 12)
let tup = (() -> throw Exception("tup"), 7)
let cleanupChosen = Choose({
    defer Console.WriteLine("cleanup-choose")
    () -> throw Exception("cleanup-lam")
}, () -> 42)

voidAdapted()
try {
    assertedCond()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
let (cleanupFn, cleanupNum) = nestedCleanupTup()
try {
    cleanupFn()
} catch (e Exception) {
    Console.WriteLine("${e.Message}:${cleanupNum}")
}
try {
    (() -> throw Exception("null-cond"))?()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    (() -> throw Exception("null-cond-invoke"))?.Invoke()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
let nullableTupFn = () -> {
    if false { return nil }
    return (() -> throw Exception("nullable-tup"), 19)
}
let (nullableTupLam, nullableTupNum) = nullableTupFn()!!
try {
    nullableTupLam()
} catch (e Exception) {
    Console.WriteLine("${e.Message}:${nullableTupNum}")
}
let nullableCleanupFn = () -> {
    if false { return nil }
    defer Console.WriteLine("nullable-cleanup")
    () -> throw Exception("nullable-cleanup-lam")
}
try {
    nullableCleanupFn()!!()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
if let boundFn = (() -> {
    if true { return () -> throw Exception("if-let-fn") }
    return nil
})() {
    try {
        boundFn()
    } catch (e Exception) {
        Console.WriteLine(e.Message)
    }
}
try {
    Console.WriteLine(cleanupChosen())
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    f()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    g(42)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    nested()()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    tup.Item1()
} catch (e Exception) {
    Console.WriteLine("${e.Message}:${tup.Item2}")
}
try {
    Console.WriteLine(Choose(1, throw Exception("choose-r")))
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    Console.WriteLine(Choose(throw Exception("choose-l"), 1))
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "cleanup-choose${Environment.NewLine}asserted-cond${Environment.NewLine}cleanup-in-tup${Environment.NewLine}tup-cleanup-lam:12${Environment.NewLine}null-cond${Environment.NewLine}null-cond-invoke${Environment.NewLine}nullable-tup:19${Environment.NewLine}nullable-cleanup${Environment.NewLine}nullable-cleanup-lam${Environment.NewLine}if-let-fn${Environment.NewLine}cleanup-lam${Environment.NewLine}zero${Environment.NewLine}arg:42${Environment.NewLine}nested${Environment.NewLine}tup:7${Environment.NewLine}choose-r${Environment.NewLine}choose-l${Environment.NewLine}",
            output
        )
    }

    @Theory
    @InlineData("Id(throw Exception(\"x\"))", "GS0151")
    @InlineData("Id((1, throw Exception(\"x\")))", "GS0151")
    @InlineData("let t = (1, throw Exception(\"x\"))", "GS0124")
    @InlineData("(() -> throw Exception(\"a\"), throw Exception(\"b\"))", "GS0124")
    @InlineData("let t (int32, int32) = (() -> (1, throw Exception(\"x\")))()", "GS0124")
    @InlineData("(() -> (1, throw Exception(\"x\")))?()", "GS0124")
    func ThrowExpression_UninferrableType_ReportsDiagnosticWithoutCrash(statement string, expectedId string) {
        let source = `package P

import System

func Id[T](x T) T -> x

func main() {
    ` + statement + `
}`
        let (exitCode, _, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains(expectedId, diagnostics)
        Assert.DoesNotContain("GS9998", diagnostics)
    }

    @Fact
    func ThrowExpression_InArgumentPosition() {
        let source = `package P

import System

func emit(s string?) {
    Console.WriteLine(string.Concat("got:", s ?? throw Exception("arg null")))
}

emit("argval")`
        let output = CompileAndRun(source)
        Assert.Equal("got:argval${Environment.NewLine}", output)
    }

    @Fact
    func ThrowStatement_StillWorks() {
        // Regression: a bare `throw e` at statement start must still behave as
        // the throw STATEMENT (intercepted by the statement parser), unchanged
        // by the new throw-expression support.
        let source = `package P

import System

func boom() {
    throw Exception("stmt-boom")
}

var got = "none"
try {
    boom()
} catch (e Exception) {
    got = e.Message
}

Console.WriteLine(got)`
        let output = CompileAndRun(source)
        Assert.Equal("stmt-boom${Environment.NewLine}", output)
    }

    @Fact
    func ThrowExpression_NonException_IsRejected() {
        // Negative: the thrown operand must be a System.Exception (or derived),
        // consistent with the throw-statement form.
        let source = `package P

func bad(s string?) string {
    return s ?? throw 42
}`
        let (exitCode, _, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("System.Exception", diagnostics)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileExpectingFailure(source string)(ExitCode int32, Stdout string, Diagnostics string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1018_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
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
                return (compileExit, compileOut.ToString(), compileOut.ToString() + compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1018_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
