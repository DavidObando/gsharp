// <copyright file="Issue1262DiscardParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1262: a parameter list with more than one discard parameter named
/// `_` was rejected with GS0101 ("A parameter with the name '_' already
/// exists."). In C# `_` is a discard and repeated `_` parameters are
/// allowed (e.g. event handlers `(_, _) => ...`). G# now permits
/// repeated `_` discard parameters on lambdas and named functions.
///
/// These emit tests prove that each `_` still occupies a real positional
/// slot: a two-`_`-param lambda invoked through its delegate produces the
/// right result and the emitted IL verifies.
open class Issue1262DiscardParameterEmitTests {
    @Fact
    func TwoDiscardParameters_FuncLambda_HasArityTwo_AndRuns() {
        // A `(_, _) -> 42` lambda assigned to a two-arg Func delegate must
        // carry both positional slots so the indirect call binds two
        // arguments; the body discards them and returns the constant.
        let source = `package P
import System

let f func(int32, int32) int32 = (_ int32, _ int32) -> 42
Console.Write(f(7, 9))`
        let stdout = CompileRunCapture(source)
        Assert.Equal("42", stdout)
    }

    @Fact
    func MixedDiscardAndNamed_Lambda_KeepsPositionalSlots() {
        // `(_ int32, x int32) -> x` proves the discard occupies the first slot
        // and the named parameter still resolves to the second argument.
        let source = `package P
import System

let f func(int32, int32) int32 = (_ int32, x int32) -> x
Console.Write(f(5, 9))`
        let stdout = CompileRunCapture(source)
        Assert.Equal("9", stdout)
    }

    @Fact
    func TwoDiscardParameters_EventHandlerShapedLambda_Runs() {
        // Event-handler-shaped callback `(_ object, _ EventArgs) -> ...`: the
        // canonical motivating case. The delegate is invoked with two
        // arguments which the body ignores.
        let source = `package P
import System

var fired = 0
let h EventHandler = (_ object, _ EventArgs) -> fired = fired + 1
h(nil, EventArgs.Empty)
h(nil, EventArgs.Empty)
Console.Write(fired)`
        let stdout = CompileRunCapture(source)
        Assert.Equal("2", stdout)
    }

    @Fact
    func TwoDiscardParameters_NamedFunction_HasArityTwo_AndRuns() {
        // A named function `func add(_ int32, _ int32) int32` still has two
        // positional slots; calling it with two arguments returns the body's
        // constant, proving the signature arity is correct.
        let source = `package P
import System

func discardBoth(_ int32, _ int32) int32 {
  return 11
}

Console.Write(discardBoth(3, 4))`
        let stdout = CompileRunCapture(source)
        Assert.Equal("11", stdout)
    }

    shared {
        private func CompileRunCapture(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1262_emit_").FullName
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
                let assembly = EmittedFixture.Load(outPath)
                let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
                let entry MethodInfo? = program.GetMethod(
                    "<Main>$$",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                let captured = StringWriter()
                let prevOut2 = Console.Out
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(prevOut2)
                }
                return captured.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup of the temp compilation directory.

                }
            }
        }
    }
}
