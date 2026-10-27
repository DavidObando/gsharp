// <copyright file="Adr0213LoopEntryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0213 section 20, slice L1: a loop removes the facts that its region can write before the header
/// and the body are bound once, and its header gives the facts that hold when the loop ends. Each row
/// compiles a library and lists the error ids. The contract table of the slice is in the pull request;
/// each row here is one line of it. A row that needs a run-time witness is in
/// `Adr0208NarrowingCorpusTests`.
open class Adr0213LoopEntryTests {
    @Theory
    @MemberData("Rows")
    func EveryRow_GivesItsDiagnostics(name string, source string, expectedErrors string) {
        let result = EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: !source.Contains("func Main")})
        let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Id).ToArray()
        Assert.True(
            expectedErrors == string.Join(" ", errors),
            "${name}: expected [${expectedErrors}] but found [${string.Join(" ", errors)}]"
        )
    }

    @Fact
    func Rows_HaveDistinctNames() {
        let names = Rows().Select((row[]object) -> cast[string](row[0])).ToArray()
        Assert.Equal(names.Length, names.Distinct().Count())
    }

    @Fact
    func NoLoopBindsItsBodyTwice() {
        using let measurements = CompilationMeasurements.Start("test")
        EmittedOracle.Evaluate(
            []string{`package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = Get()
    }
    return total
}`},
            EmittedOracleOptions{IsLibrary: true}
        )
        Assert.Equal(0L, measurements.GetCounter("narrowing.loop-rebinds"))
    }

    shared {
        func Rows() IEnumerable[[]object] {
            let rows = List[[]object]()
            let Add = func (name string, source string, expectedErrors string) {
                rows.Add([]object{name, source, expectedErrors})
            }
            Add("exit-gain-no-break (R7 f)", `package T
func Get(c bool) string? { return if c { nil } else { "ab" } }
func Run(c bool) int32 {
    var s string? = Get(c)
    while s == nil {
        s = "ok"
    }
    return s.Length
}`, "")
            Add("exit-gain-dropped-by-a-break (R7 f, rule of the sound subset)", `package T
func Get(c bool) string? { return if c { nil } else { "ab" } }
func Run(c bool, d bool) int32 {
    var s string? = Get(c)
    while s == nil {
        if d { break }
        s = "ok"
    }
    return s.Length
}`, "GS0158")
            Add("exit-gain-dropped-when-the-header-writes-the-root", `package T
func Get(c bool) string? { return if c { nil } else { "ab" } }
func Reset(ref s string?) bool {
    s = nil
    return false
}
func Run(c bool) int32 {
    var s string? = Get(c)
    while s == nil || Reset(ref s) {
        s = "ok"
    }
    return s.Length
}`, "GS0158")
            Add("literal-of-another-type-removes-a-type-test-fact (P7)", `package T
func Run(n int32) int32 {
    var value object = "first"
    var total = 0
    if value is string {
        for var i = 0; i < n; i++ {
            total = total + value.Length
            value = 42
        }
    }
    return total
}`, "GS0158")
            Add("string-literal-keeps-a-type-test-fact (P7)", `package T
func Run(n int32) int32 {
    var value object = "first"
    var total = 0
    if value is string {
        for var i = 0; i < n; i++ {
            total = total + value.Length
            value = "again"
        }
    }
    return total
}`, "")
            Add("indexed-iteration-keeps-a-global (R11, #5170)", `package T
import System
var g string? = nil
func Run() int32 {
    g = "safe"
    var total int32 = 0
    for item in []int32{1, 2} {
        let copy string = g
        if copy == "other" { total = total + 100 }
        total = total + item
    }
    return total
}
func Main() { Console.WriteLine(Run()) }`, "")
            Add("iteration-with-user-code-removes-a-global (R11, #5170)", `package T
import System
import System.Collections.Generic
var g string? = nil
func Run(items List[int32]) int32 {
    g = "safe"
    var total int32 = 0
    for item in items {
        let copy string = g
        if copy == "other" { total = total + 100 }
        total = total + item
    }
    return total
}
func Main() { Console.WriteLine(Run(List[int32]())) }`, "GS0155")
            Add("literal-false-header-has-no-back-edge", `package T
class C { func M() { } }
func Run() {
    var c C? = C()
    if c != nil {
        do {
            c.M()
            c = nil
        } while false
    }
}`, "")
            Add("function-value-reassigned-in-the-loop-is-not-external (section 13)", `package T
class C { var Value int32 = 1 }
func Run(cb func()) int32 {
    var x C? = C{}
    let h = func() { x = nil }
    var other string? = "a"
    if other == nil { return 0 }
    if x == nil { return 0 }
    var g func() = cb
    var total = 0
    for var i = 0; i < 2; i++ {
        if x != nil {
            g()
            total = total + x.Value
        }
        g = h
    }
    return total + other.Length
}`, "GS0158")
            Add("by-reference-parameter-survives-a-member-read (A3, #5292)", `package T
func Run(out path string?, n int32) int32 {
    path = "p"
    if path == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + path.Length
    }
    return total
}`, "")
            Add("header-is-bound-under-the-lower-bound (I6)", `package T
func Get() string? { return nil }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 {
        s = Get()
        n++
    }
    return n
}`, "GS0158")
            Add("value-type-construction-is-no-proof (P7)", `package T
import System
struct S { var V int32 }
func Run(n int32) int32 {
    var x object? = "a"
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.GetHashCode()
        x = S{}
    }
    return total
}`, "GS0159")
            Add("unresolved-construction-is-no-proof (P7)", `package T
import System
func Run(n int32) int32 {
    var s string? = "a"
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = Missing()
    }
    return total
}`, "GS0158 GS0130")
            return rows
        }
    }
}
