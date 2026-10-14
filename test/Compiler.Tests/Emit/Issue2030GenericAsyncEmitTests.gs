// <copyright file="Issue2030GenericAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2030: generic `async func`s could not be emitted/run due to
/// two separate emit-layer gaps:
/// 1. Gap 1 — state-machine synthesis reported GS0190 whenever the declared inner return type was an
/// open type parameter (e.g. `async func Foo[U](x U) U`), because
/// `AsyncStateMachineTypeBuilder.ResolveAsyncReturnClrType` had no branch to resolve a CLR type for a
/// bare/nullable-wrapped `TypeParameterSymbol`.
/// 2. Gap 2 — even when the declared return type was concrete, hoisting a parameter/local typed as the
/// kickoff method's own type parameter (e.g. `seed U`) into the state machine crashed at runtime with
/// (cref:BadImageFormatException), because (a) the kickoff body's own references to the constructed
/// state-machine type used the SM struct's self-instantiation (`!0`, a class type-var) instead of the
/// kickoff's own type parameters (`!!0`, a method type-var, since the kickoff is not itself a member of
/// the SM struct), and (b) `MoveNext`/`SetStateMachine` body emission did not push the same
/// outer-method-TP → SM-TP remap used for the SM's FieldDefs, so a hoisted local typed as the kickoff's
/// own type parameter (e.g. the state machine's `retVal` temp) encoded as a dangling method type-var
/// instead.
open class Issue2030GenericAsyncEmitTests {
    @Fact
    func OpenTypeParameterReturn_CompilesAndRuns() {
        // Gap 1 repro (issue body): declared inner return type is the bare
        // open type parameter U.
        let source = `package issue2030gap1
import System
async func Foo2030A[U](x U) U {
    return x
}
var t1 = Foo2030A(42)
var t2 = Foo2030A("hello")
Console.WriteLine(t1.Result)
Console.WriteLine(t2.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}hello${Environment.NewLine}", output)
    }

    @Fact
    func HoistedTypeParameterParameter_ConcreteReturn_CompilesAndRuns() {
        // Gap 2 repro (issue body): declared return type is concrete
        // (int32), but the kickoff's own parameter `seed U` must be hoisted
        // into the state machine.
        let source = `package issue2030gap2
async func Answer2030B() int32 {
    return 42
}
async func Outer2030B[U](seed U) int32 {
    var r = Answer2030B()
    return await r
}
var t = Outer2030B("hi")
t.Wait()
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func MultipleTypeParametersAndGenericInstanceMethod_CompileAndRun() {
        // Generalization: more than one method type parameter, plus a
        // generic async INSTANCE method (own type parameters come from the
        // enclosing class, not the method) hoisting a field typed after the
        // class's own type parameter.
        let source = `package issue2030gap3
import System
import System.Threading.Tasks

class Box2030C[T] {
    var Value T
    public func init(v T) {
        Value = v
    }
    public async func GetAsync() T {
        await Task.Delay(1)
        return Value
    }
}

async func Pair2030C[A, B](a A, b B) A {
    var x = a
    await Task.Delay(1)
    return x
}

var box = Box2030C[int32](7)
var boxed = box.GetAsync()
Console.WriteLine(boxed.Result)

var t = Pair2030C[string, int32]("first", 99)
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}first${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2030_").FullName
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
                Assert.True(File.Exists(outPath), "expected emitted assembly at $outPath")
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
