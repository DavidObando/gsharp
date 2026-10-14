// <copyright file="EmittedSessionEngineBehaviorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System
import System.Collections.Generic
import Xunit

/// ADR-0156 interactive-engine behavioral suite: drives multi-cell submission
/// scripts through the emitted (cref:EmittedSessionEngine) and asserts
/// each cell's error flag, echoed value rendering, and captured console
/// output against pinned goldens. Until Phase 3c (#3176) this was the Phase 2
/// dual-engine parity gate against the tree-walking `SessionEngine`; the
/// goldens below are the cross-checked values both engines agreed on when the
/// evaluator retired, so the behavioral coverage is preserved verbatim.
/// Cells expected to error are pinned as errors (both engines agreed on
/// those too).
class EmittedSessionEngineBehaviorTests {
    /// One expected cell outcome: `Value` is the echoed value's
    /// (cref:object.ToString) rendering (`null` for no
    /// echo), `Output` the captured stdout, and `HasError` the
    /// error flag.
    data class ExpectedCell(HasError bool, Value string?, Output string = "") : IEquatable[ExpectedCell] {
        shared {
            func Ok(value string? = nil, output string = "") ExpectedCell -> ExpectedCell(false, value, output)

            func Error() ExpectedCell -> ExpectedCell(true, nil)
        }
    }

    @Theory
    @MemberData("Scripts")
    func CellsMatchPinnedGoldens(label string, submissions[]string, expected[]ExpectedCell) {
        Assert.Equal(submissions.Length, expected.Length)
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let mismatches = List[string]()
        for var i = 0; i < submissions.Length; i++ {
            let cell = engine.Evaluate(submissions[i])
            let want = expected[i]
            if cell.HasError != want.HasError {
                mismatches.Add(
                    "$label cell ${i + 1}: HasError expected=${want.HasError} actual=${cell.HasError} (diags: ${string.Join("; ", cell.Diagnostics)})"
                )
                continue
            }
            if !cell.HasError {
                let actualValue string? = cell.Value?.ToString()
                if !string.Equals(want.Value, actualValue, StringComparison.Ordinal) {
                    mismatches.Add("$label cell ${i + 1}: Value expected='${want.Value}' actual='$actualValue'")
                }
                if !string.Equals(want.Output, cell.Output, StringComparison.Ordinal) {
                    mismatches.Add("$label cell ${i + 1}: Output expected='${want.Output}' actual='${cell.Output}'")
                }
            }
        }
        Assert.True(mismatches.Count == 0, string.Join(Environment.NewLine, mismatches))
    }

    /// ADR-0156 Phase 2 deliberate semantic change, now simply the semantics:
    /// redefining a same-signature function and calling it gives clean
    /// newest-wins shadowing (the Roslyn interactive model). The evaluator
    /// engine's ambiguous-overload behavior retired with it in Phase 3c
    /// (#3176).
    @Fact
    func RedefinedFunctionCallUsesNewestDefinition() {
        using let emitted = EmittedSessionEngine()
        emitted.Evaluate(`func g() int {
    return 1
}`)
        emitted.Evaluate(`func g() int {
    return 2
}`)
        let emittedCall = emitted.Evaluate("g()")
        Assert.False(emittedCall.HasError)
        Assert.Equal(2, emittedCall.Value)
    }

    /// Issue #3185 follow-on, now simply the semantics: a mutating method
    /// call on a struct-typed global passes the global's real address
    /// (`ldsflda`) as the receiver, so the mutation persists — matching
    /// what the same program compiled by `gsc` does. The evaluator's
    /// copy-receiver behavior retired with it in Phase 3c (#3176).
    @Fact
    func StructMethodReceiverMutationPersists() {
        const declare = `struct P {
    var X int
    func Bump() {
        X = X + 1
    }
}
var p = P{X: 41}`
        using let emitted = EmittedSessionEngine()
        Assert.False(emitted.Evaluate(declare).HasError)
        Assert.False(emitted.Evaluate("p.Bump()").HasError)
        let emittedRead = emitted.Evaluate("p.X")
        Assert.False(emittedRead.HasError)
        Assert.Equal(42, emittedRead.Value)
    }

    shared {
        func Scripts() TheoryData[string, []string, []ExpectedCell] -> {
            let values = TheoryData[string, []string, []ExpectedCell]()
            values.Add(
                "arithmetic-and-locals",
                []string{"var a = 6", "var b = 7", "a * b", "a = a + 1", "a"},
                []ExpectedCell{
                    ExpectedCell.Ok("6"),
                    ExpectedCell.Ok("7"),
                    ExpectedCell.Ok("42"),
                    ExpectedCell.Ok("7"),
                    ExpectedCell.Ok("7")
                }
            )
            values.Add(
                "strings-and-interpolation",
                []string{"var name = \"world\"", "\"hello \" + name", "name.Length"},
                []ExpectedCell{ExpectedCell.Ok("world"), ExpectedCell.Ok("hello world"), ExpectedCell.Ok("5")}
            )
            values.Add("functions-and-recursion", []string{`func fib(n int) int {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}`, "fib(10)"}, []ExpectedCell{ExpectedCell.Ok(), ExpectedCell.Ok("55")})
            values.Add("structs-and-methods", []string{`struct Point {
    var X int
    var Y int
    func Sum() int {
        return X + Y
    }
}`, "var p = Point{X: 3, Y: 4}\np.Sum()", "p.Sum() * 2"}, []ExpectedCell{
                    ExpectedCell.Ok(),
                    ExpectedCell.Ok("7"),
                    ExpectedCell.Ok("14")
                })
            values.Add("console-output", []string{"Console.WriteLine(\"line-1\")", `for i in range 3 {
    Console.WriteLine(i.ToString())
}`}, []ExpectedCell{ExpectedCell.Ok(output: "line-1\n"), ExpectedCell.Error()})
            values.Add(
                "redefinition-shadowing",
                []string{"var x = 1", "var x = \"text\"", "x"},
                []ExpectedCell{ExpectedCell.Ok("1"), ExpectedCell.Ok("text"), ExpectedCell.Ok("text")}
            )
            values.Add(
                "failed-submissions-recover",
                []string{"var ok = 41", "nope + 1", "ok + 1"},
                []ExpectedCell{ExpectedCell.Ok("41"), ExpectedCell.Error(), ExpectedCell.Ok("42")}
            )
            values.Add(
                "collections",
                []string{"let arr = [3]int{10, 20, 30}", "arr[1]", "var m = map[string,int]{\"a\": 1}", "m[\"a\"]"},
                []ExpectedCell{
                    ExpectedCell.Ok("System.Int32[]"),
                    ExpectedCell.Ok("20"),
                    ExpectedCell.Ok("System.Collections.Generic.Dictionary`2[System.String,System.Int32]"),
                    ExpectedCell.Ok("1")
                }
            )
            values.Add("prior-cell-function-as-value", []string{`func addOne(n int) int {
    return n + 1
}`, "let g = addOne\ng(41)", `func apply(f func(int) int, v int) int {
    return f(v)
}`, "apply(addOne, 1) + g(0)"}, []ExpectedCell{
                    ExpectedCell.Ok(),
                    ExpectedCell.Ok("42"),
                    ExpectedCell.Ok(),
                    ExpectedCell.Ok("3")
                })
            values.Add("cross-cell-interface-conversion", []string{`interface Shape {
    func Area() int;
}
struct Sq : Shape {
    var S int
    func Area() int {
        return S * S
    }
}`, "var sh Shape = Sq{S: 3}\nsh.Area()", "sh.Area() * 2", "sh = Sq{S: 5}\nsh.Area()"}, []ExpectedCell{
                    ExpectedCell.Ok(),
                    ExpectedCell.Ok("9"),
                    ExpectedCell.Ok("18"),
                    ExpectedCell.Ok("25")
                })
            values.Add("cross-cell-interface-nominal-required", []string{`interface Shape {
    func Area() int;
}
struct Sq {
    var S int
    func Area() int {
        return S * S
    }
}`, "var sh Shape = Sq{S: 3}"}, []ExpectedCell{ExpectedCell.Ok(), ExpectedCell.Error()})
            values.Add("member-writes-through-prior-cell-globals", []string{`struct P {
    var X int
}
var p = P{X: 1}
p.X`, "p.X = 5", "p.X", "p.X += 2\np.X", `struct Inner {
    var C int
}
struct Outer {
    var B Inner
}
var a = Outer{B: Inner{C: 1}}
a.B.C`, "a.B.C = 7\na.B.C", `class Counter {
    var N int
}
var c = Counter{N: 1}
c.N`, "c.N = 41\nc.N", "c.N += 1\nc.N"}, []ExpectedCell{
                    ExpectedCell.Ok("1"),
                    ExpectedCell.Ok("5"),
                    ExpectedCell.Ok("5"),
                    ExpectedCell.Ok("7"),
                    ExpectedCell.Ok("1"),
                    ExpectedCell.Ok("7"),
                    ExpectedCell.Ok("1"),
                    ExpectedCell.Ok("41"),
                    ExpectedCell.Ok("42")
                })
            values.Add("let-global-member-writes-rejected", []string{`struct P {
    var X int
}
let p = P{X: 1}
p.X`, "p.X = 5", "p.X += 1", "p.X"}, []ExpectedCell{
                    ExpectedCell.Ok("1"),
                    ExpectedCell.Error(),
                    ExpectedCell.Error(),
                    ExpectedCell.Ok("1")
                })
            values
        }
    }
}
