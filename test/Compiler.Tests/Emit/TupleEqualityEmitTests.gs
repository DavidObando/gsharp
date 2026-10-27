// <copyright file="TupleEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #3501 / ADR-0171: emit coverage for tuple equality (`==` /
/// `!=`). Each test's printed trace is the ADR-0154 witness: the
/// short-circuit and single-evaluation tests fail against an implementation
/// that re-evaluates operands or compares eagerly, and the user-operator test
/// fails against a `ValueTuple.Equals` dispatch.
open class TupleEqualityEmitTests {
    @Fact
    func TupleEquality_BasicOutcomes() {
        let source = `package P
import System

let a = (1, "x")
let b = (1, "x")
let c = (2, "x")
Console.WriteLine(a == b)
Console.WriteLine(a == c)
Console.WriteLine(a != b)
Console.WriteLine(a != c)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func TupleEquality_ShortCircuit_FirstMismatchSkipsLaterElementOperator() {
        // Loud's user operator prints on every invocation. With the first
        // elements unequal (1 vs 2), `&&` short-circuits and the Loud
        // comparison must never run — "loud==" appears exactly once, from the
        // control comparison where the first elements match.
        let source = `package P
import System

struct Loud {
    var V int32
}

func (a Loud) operator ==(b Loud) bool {
    Console.WriteLine("loud==")
    return a.V == b.V
}

func (a Loud) operator !=(b Loud) bool {
    Console.WriteLine("loud!=")
    return a.V != b.V
}

let p = (1, Loud{V: 5})
let q = (2, Loud{V: 5})
let r = (1, Loud{V: 5})
Console.WriteLine(p == q)
Console.WriteLine(p == r)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}loud==${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func TupleEquality_OperandsEvaluatedExactlyOnce() {
        let source = `package P
import System

func mk(tag string) (int32, int32) {
    Console.WriteLine("eval $tag")
    return (1, 2)
}

Console.WriteLine(mk("L") == mk("R"))`
        let output = CompileAndRun(source)
        Assert.Equal("eval L${Environment.NewLine}eval R${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func TupleEquality_NullableElement_NilAndValueCases() {
        let source = `package P
import System

var none (int32?, string) = (nil, "x")
var some (int32?, string) = (7, "x")
var none2 (int32?, string) = (nil, "x")
Console.WriteLine(none == some)
Console.WriteLine(none == none2)
Console.WriteLine(some == (7, "x"))`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func TupleEquality_UnsignedNullableConstants_PreserveValuesAndRejectNonconstants() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TupleConstant
import System
func Equal(value uint32?) bool -> (value, 9) == (0, 9)
func Different(value uint32?) bool -> (0, 9) != (value, 9)
func Main() {
    Console.WriteLine(Equal(nil))
    Console.WriteLine(Equal(0u))
    Console.WriteLine(Equal(1u))
    Console.WriteLine(Equal(4294967295))
    Console.WriteLine(Different(nil))
    Console.WriteLine(Different(0u))
    Console.WriteLine(Different(4294967295))
    var upper uint32? = 4294967295
    Console.WriteLine((upper, 9) == (4294967295, 9))
    var wide uint64? = 18446744073709551615
    Console.WriteLine((wide, 9) == (18446744073709551615, 9))
    Console.WriteLine(((upper, 9), 1) == ((4294967295, 9), 1))
    Console.WriteLine((upper, 9) != (4294967295, 9))
    Console.WriteLine((1, 9) == (1L, 9))
    Console.WriteLine((upper, 9) != (1 - 1, 9))
}`, "TupleConstant", true, "/deterministic+", "/debug:none")
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "False\nTrue\nFalse\nFalse\nTrue\nFalse\nTrue\nTrue\nTrue\nTrue\nFalse\nTrue\nTrue\n".Replace(
                    "\n",
                    Environment.NewLine,
                    StringComparison.Ordinal
                )
            ),
            fixture.RunBytes(dll)
        )
        let first = File.ReadAllBytes(dll)
        let source = File.ReadAllText(Path.Combine(fixture.Directory, "TupleConstant.gs"))
        fixture.Compile(source, "TupleConstant", true, "/deterministic+", "/debug:none")
        Assert.Equal(first, File.ReadAllBytes(dll))

        for expression in[]string{"-1", "other", "stored.Item1"} {
            let rejected = "package Rejected\n" +
                "func Equal(value uint64?, other int32, stored (int32, int32)) bool -> " +
                "(value, 9) == (" +
                expression +
                ", 9)"
            let (code, diagnostics) = fixture.TryCompile(rejected, "Rejected", false)
            Assert.NotEqual(0, code)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
            let error = Assert.Single(Regex.Matches(diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
            Assert.Equal("GS0129", error.Groups[5].Value)
            Assert.Equal("2", error.Groups[1].Value)
            Assert.Equal("82", error.Groups[2].Value)
            Assert.Equal("2", error.Groups[3].Value)
            Assert.Equal("84", error.Groups[4].Value)
        }
    }

    @Fact
    func TupleEquality_ConstantProjection_PreservesOperandEffectsAndSnapshots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TupleEffects
import System
class State {
    shared {
        var Value uint32 = 0
    }
}
func Tag(tag string) int32 {
    Console.Write(tag)
    return 9
}
func Produce(tag string) (uint32?, int32) {
    Console.Write(tag)
    State.Value = 1
    return (0u, 9)
}
func Main() {
    Console.WriteLine(Produce("L") == (0, Tag("R")))
    Console.WriteLine((0, Tag("L")) != Produce("R"))
    Console.WriteLine(Produce("L") == Produce("R"))
    State.Value = 0
    Console.WriteLine((State.Value, Tag("L")) == Produce("R"))
    Console.WriteLine(State.Value)
    var missing uint32? = nil
    Console.WriteLine((missing, Tag("L")) == (0, Tag("R")))
    Console.WriteLine(((missing, Tag("L")), 1) != ((+0, Tag("R")), 1))
}`, "TupleEffects", true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "LRTrue\nLRFalse\nLRTrue\nLRTrue\n1\nLRFalse\nLRTrue\n".Replace(
                    "\n",
                    Environment.NewLine,
                    StringComparison.Ordinal
                )
            ),
            fixture.RunBytes(dll)
        )
    }

    @Fact
    func TupleEquality_SymbolicTuple_StructElementCompares() {
        // A tuple whose element is a same-compilation struct has no cached
        // CLR type at bind time (symbolic tuple) — the desugared block plus
        // bool fold must emit through the symbolic element-access path.
        let source = `package P
import System

struct Pt {
    var X int32
}

func (a Pt) operator ==(b Pt) bool {
    return a.X == b.X
}

func (a Pt) operator !=(b Pt) bool {
    return a.X != b.X
}

let p = (Pt{X: 1}, 2)
let q = (Pt{X: 1}, 2)
let r = (Pt{X: 9}, 2)
Console.WriteLine(p == q)
Console.WriteLine(p != r)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func TupleEquality_AwaitInRightOperand_SpillsAcrossSuspension() {
        let source = `package P
import System
import System.Threading.Tasks

async func fetch() (int32, int32) {
    await Task.Delay(1)
    return (3, 4)
}

async func check() {
    let expected = (3, 4)
    Console.WriteLine(expected == await fetch())
}

check().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_tupeq_emit_").FullName
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
