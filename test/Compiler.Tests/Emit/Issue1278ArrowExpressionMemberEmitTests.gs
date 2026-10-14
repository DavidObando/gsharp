// <copyright file="Issue1278ArrowExpressionMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #1278 / ADR-0131: emit + run coverage for expression-bodied members
/// using the G# arrow `->`. Each program declares an arrow-bodied
/// member (function/method, read-only property, get/set accessors, indexer,
/// operator, or conversion operator), runs it, and reads back an
/// `int32 result` field, proving the desugared bodies emit and execute
/// identically to their block-bodied equivalents.
open class Issue1278ArrowExpressionMemberEmitTests {
    @Fact
    func FunctionArrowBody_RunsAndReturns() {
        let source = `package P

func square(x int32) int32 -> x * x

public var result = square(9)`
        Assert.Equal(81, RunAndGetIntResult(source))
    }

    @Fact
    func Issue3375_TupleReturningArrowBody_RunsAndReturns() {
        let source = `package P

class PairFactory {
    shared {
        private func Pair() (int32, int32) -> (1, 2)
        func Sum() int32 {
            let pair = Pair()
            return pair.Item1 * 10 + pair.Item2
        }
    }
}

public var result = PairFactory.Sum()`
        Assert.Equal(12, RunAndGetIntResult(source))
    }

    @Fact
    func VoidMethodArrowBody_ExecutesSideEffect() {
        // A void method expression body is an executed statement (a call that
        // writes a field), proving the `{ expr }` desugar runs.
        let source = `package P

class Counter {
    var n int32
    func Bump() -> this.Add(5)
    func Add(d int32) -> this.Set(this.n + d)
    func Set(v int32) -> this.Store(v)
    func Store(v int32) { this.n = v }
}

let c = Counter()
c.Bump()
c.Bump()
public var result = c.n`
        Assert.Equal(10, RunAndGetIntResult(source))
    }

    @Fact
    func ReadOnlyPropertyArrow_RunsAndReturns() {
        let source = `package P

class Box {
    var seed int32
    prop Doubled int32 -> this.seed * 2
}

let b = Box()
b.seed = 21
public var result = b.Doubled`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    @Fact
    func Issue3587_SliceOfTuplePropertyArrow_RunsAndReturns() {
        let source = `package P

class C {
    prop Rows [](string, string) -> [](string, string){("a", "b")}
}

public var result = C().Rows.Length`
        Assert.Equal(1, RunAndGetIntResult(source))
    }

    @Fact
    func Issue3587_SliceOfTupleFunctionArrow_RunsAndReturns() {
        let source = `package P

func MakeRows() [](string, string) {
    return [](string, string){("a", "b"), ("c", "d")}
}

func Rows() [](string, string) -> MakeRows()

public var result = Rows().Length`
        Assert.Equal(2, RunAndGetIntResult(source))
    }

    @Fact
    func Issue3587_MissingPropertyArrowExpression_FailsCompilation() {
        let source = `package P

class C {
    prop Rows [](string, string) ->
}`
        let (exitCode, output, _) = CompileToFile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0005", output, StringComparison.Ordinal)
    }

    @Fact
    func Issue3587_NullableNestedSliceTupleArrows_RunAndReturn() {
        let source = `package P

func MakeRows() []?[](string, string) {
    return [][](string, string){
        [](string, string){("a", "b")},
        [](string, string){("c", "d")},
    }
}

class C {
    prop Rows []?[](string, string) -> MakeRows()
}

func Rows() []?[](string, string) -> MakeRows()

public var result = C().Rows!!.Length * 10 + Rows()!!.Length`
        Assert.Equal(22, RunAndGetIntResult(source))
    }

    @Fact
    func AccessorArrows_RoundTripThroughField() {
        let source = `package P

class Box {
    var n int32
    prop Value int32 {
        get -> this.n
        set -> this.n = value
    }
}

let b = Box()
b.Value = 33
public var result = b.Value`
        Assert.Equal(33, RunAndGetIntResult(source))
    }

    @Fact
    func IndexerArrow_RunsAndReturns() {
        let source = `package P

class Grid {
    var data []int32
    prop this[i int32] int32 -> this.data[i]
}

let g = Grid{data: []int32{10, 20, 30}}
public var result = g[2]`
        Assert.Equal(30, RunAndGetIntResult(source))
    }

    @Fact
    func OperatorArrow_RunsAndReturns() {
        let source = `package P

struct V {
    var x int32
}

func (a V) operator +(b V) V -> V{x: a.x + b.x}

let s = V{x: 4} + V{x: 38}
public var result = s.x`
        Assert.Equal(42, RunAndGetIntResult(source))
    }

    @Fact
    func ConversionOperatorArrow_RunsAndReturns() {
        let source = `package P

struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 -> c.degrees

let c = Celsius{degrees: 99}
var d int32 = c
public var result = d`
        Assert.Equal(99, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string) Assembly {
            let (exitCode, output, outPath) = CompileToFile(source)
            Assert.True(exitCode == 0, (`gsc failed:
` + "$output"))
            return EmittedFixture.Load(outPath)
        }

        private func CompileToFile(source string)(ExitCode int32, Output string, OutPath string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1278_emit_").FullName
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
            let output = compileOut.ToString() + compileErr.ToString()
            return (compileExit, output, outPath)
        }
    }
}
