// <copyright file="Issue951CanonicalArrowLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #951 / ADR-0119 — the inferred-type arrow lambda is the canonical
/// lambda form in G#. These end-to-end CompileAndRun tests lock in
/// parameter-type and return-type inference for arrow lambdas across the
/// canonical contexts: passing a lambda to a method/function whose parameter
/// is a delegate type (CLR `Func`/`Action`/`Predicate` or a G#
/// `(T) -> R` function type), single and multi-parameter, the bare
/// single-parameter form, block bodies, return-type inference, user instance /
/// interface / static methods, typed-local bindings, and collection methods.
open class Issue951CanonicalArrowLambdaEmitTests {
    @Fact
    func FreeFunction_FuncParam_SingleParen_Inferred() {
        let source = `package P
import System

func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
Console.WriteLine(Apply((x) -> x * 2, 5))`
        Assert.Equal("10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_FuncParam_BareSingleParam_Inferred() {
        let source = `package P
import System

func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
Console.WriteLine(Apply(x -> x + 1, 41))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_GSharpFunctionTypeParam_Inferred() {
        let source = `package P
import System

func Apply(f (int32) -> int32, x int32) int32 { return f(x) }
Console.WriteLine(Apply((x) -> x * 3, 5))`
        Assert.Equal("15${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_ActionParam_Inferred() {
        let source = `package P
import System

func Run(a Action[int32], x int32) { a(x) }
Run((x) -> Console.WriteLine(x * 3), 4)
Run(x -> Console.WriteLine(x), 7)`
        Assert.Equal("12${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_PredicateParam_Inferred() {
        let source = `package P
import System

func Test(p Predicate[int32], x int32) bool { return p(x) }
Console.WriteLine(Test((x) -> x > 0, 5))
Console.WriteLine(Test(x -> x > 10, 5))`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_MultiParamFunc_Inferred() {
        let source = `package P
import System

func Apply2(f Func[int32, int32, int32], a int32, b int32) int32 { return f(a, b) }
Console.WriteLine(Apply2((a, b) -> a + b, 3, 4))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_FuncParam_BlockBody_Inferred() {
        let source = `package P
import System

func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
let r = Apply((x) -> {
  let y = x * 2
  y + 1
}, 5)
Console.WriteLine(r)`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FreeFunction_ReturnTypeInference_FlowsFromExpression() {
        let source = `package P
import System

func Apply(f Func[int32, string], x int32) string { return f(x) }
Console.WriteLine(Apply((x) -> x.ToString(), 7))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TypedLocal_ClrDelegate_Inferred() {
        let source = `package P
import System

let f Func[int32, int32] = (x) -> x * 2
Console.WriteLine(f(21))
let g Func[int32, int32] = x -> x + 1
Console.WriteLine(g(41))`
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UserInstanceMethod_FuncParam_Inferred() {
        let source = `package P
import System

class Calc {
  func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
}
let c = Calc()
Console.WriteLine(c.Apply((x) -> x * 2, 5))
Console.WriteLine(c.Apply(x -> x + 1, 9))`
        Assert.Equal("10${Environment.NewLine}10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InterfaceMethod_FuncParam_Inferred() {
        let source = `package P
import System

interface IRunner { func Run(f Func[int32, int32], x int32) int32; }
class R : IRunner { func Run(f Func[int32, int32], x int32) int32 { return f(x) } }
let r IRunner = R()
Console.WriteLine(r.Run((x) -> x * 2, 6))`
        Assert.Equal("12${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StaticUserMethod_FuncParam_Inferred() {
        let source = `package P
import System

class Calc {
  shared {
    func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
  }
}
Console.WriteLine(Calc.Apply((x) -> x * 2, 5))`
        Assert.Equal("10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func CollectionMethods_WhereSelect_Inferred() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

let xs = List[int32]{ 1, 2, 3, 4 }
for e in xs.Where((x) -> x % 2 == 0) { Console.WriteLine(e) }
for d in xs.Select(x -> x * 2) { Console.WriteLine(d) }`
        Assert.Equal(
            "2${Environment.NewLine}4${Environment.NewLine}2${Environment.NewLine}4${Environment.NewLine}6${Environment.NewLine}8${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ListExists_PredicateInferred() {
        let source = `package P
import System
import System.Collections.Generic

let xs = List[int32]{ 1, 2, 3 }
Console.WriteLine(xs.Exists((x) -> x > 2))
Console.WriteLine(xs.Exists(x -> x > 10))`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_lambda951_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
