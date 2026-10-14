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
