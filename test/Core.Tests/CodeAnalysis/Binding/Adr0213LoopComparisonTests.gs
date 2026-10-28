// <copyright file="Adr0213LoopComparisonTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0213 sections 6 and 20, slices L0 and L1: the lower bound of a loop. The binder computes it from
/// the walker, removes the facts it names before the loop is bound, and reports each decision. Each test
/// compiles a probe of the ADR as a library and checks the `.loops` report: `K` lines for a fact the loop
/// removes, `T` for the counts of a loop (facts, removed, kept), `X` for a fact that the header proves on
/// exit, `S` for a backward-jump span. A row records the line, the path, the fact kind, the rule and the
/// row of section 16.
open class Adr0213LoopComparisonTests {
    @Theory
    @MemberData("Rows")
    func EveryRow_GivesItsReport(name string, source string, expected string, agreeing string) {
        let actual = string.Join(" ; ", Capture(source, "K"))
        Assert.True(expected == actual, "${name}: expected [${expected}] but found [${actual}]")
        // The facts of each loop: `facts/removed/kept`.
        let counts = Capture(source, "T").Select((line string) -> string.Join("/", line.Split('|').Skip(1).Take(3)))
        let actualAgreeing = string.Join(",", counts.OrderBy((text string) -> text, StringComparer.Ordinal))
        Assert.True(agreeing == actualAgreeing, "${name}: expected loops [${agreeing}] but found [${actualAgreeing}]")
    }

    @Fact
    func Table_HasARowForEveryRuleThatCanDisagree() {
        let names = Rows().Select((row[]object) -> cast[string](row[0])).ToArray()
        Assert.Equal(names.Length, names.Distinct().Count())
        Assert.True(names.Length >= 14)
    }

    @Fact
    func EveryAgreeingFactIsCounted() {
        // A loop whose facts the walker and today's analysis both keep, and one that both kill.
        let lines = Capture(`package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + 1
    }
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = nil
    }
    return total
}`, "T")
        // The report sorts its lines as text, so line 10 comes before line 7.
        Assert.Equal([]string{"10|1|1|0", "7|1|0|1"}, lines.Select((line string) -> Prefix(line, 4)).ToArray())
    }

    @Fact
    func TheHeaderOfAWhileLoopProvesAFactOnExit() {
        // Probe q12 and q13: the exit state gains `s`, and a `!!` after the loop becomes redundant.
        let lines = Capture(`package T
func Get(c bool) string? { return if c { nil } else { "ab" } }
func Run(c bool) int32 {
    var s string? = Get(c)
    while s == nil {
        s = "ok"
    }
    return s!!.Length
}`, "X")
        Assert.Equal([]string{"5|s|no-break|8"}, lines.Select((line string) -> Sites(line)).ToArray())
    }

    @Fact
    func ABackwardJumpSpanIsReportedOncePerFunction() {
        // Probe q2: one label, one participant goto.
        let lines = Capture(`package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var i = 0
    var s string? = Get()
    if s == nil { return 0 }
    Again: i = i + s!!.Length
    s = nil
    if i < n { s = Get(); goto Again }
    return i
}`, "S")
        let line = Assert.Single(lines)
        Assert.Contains("labels=Again gotos=1", line)
        Assert.Contains("writes=[i,s]", line)
    }

    @Fact
    func ASpanInALoopWhoseFactIsRemovedIsReportedOnce() {
        // The first label sits in a loop whose fact the lower bound removes. The loop binds once, and the span
        // is reported once.
        NarrowingComparison.BeginCapture()
        using let measurements = CompilationMeasurements.Start("test")
        var lines = List[string]()
        try {
            Evaluate(`package T

func Get() string? { return nil }

func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    while i < n {
        i = i + s.Length
        s = nil
        Again: i = i + 1
        if i < 3 { goto Again }
        s = Get()
        if s == nil { return 0 }
    }
    return i
}`)
        } finally {
            lines = NarrowingComparison.EndCapture()
        }
        Assert.Equal(1, lines.Count((line string) -> line.StartsWith("S\t", StringComparison.Ordinal)))
        Assert.Equal(1L, measurements.GetCounter("narrowing.spans"))
    }

    @Fact
    func AFunctionWithOnlyAForwardJumpCountsNoSpan() {
        NarrowingComparison.BeginCapture()
        using let measurements = CompilationMeasurements.Start("test")
        var lines = List[string]()
        try {
            Evaluate(`package T
func Run(skip bool) int32 {
    if skip { goto Done }
    Done: return 1
}`)
        } finally {
            lines = NarrowingComparison.EndCapture()
        }
        Assert.Equal(0, lines.Count((line string) -> line.StartsWith("S\t", StringComparison.Ordinal)))
        Assert.Equal(0L, measurements.GetCounter("narrowing.spans"))
    }

    @Fact
    func TheCountersOfSection15AreReported() {
        NarrowingComparison.BeginCapture()
        using let measurements = CompilationMeasurements.Start("test")
        try {
            Evaluate(`package T
class C { var Value int32 = 1 }
func Run(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value
    }
    clear()
    return total
}
func Get() string? { return nil }
func Other(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    for var i = 0; i < n; i++ {
        s = nil
    }
    return n
}`)
        } finally {
            NarrowingComparison.EndCapture()
        }
        Assert.True(measurements.GetCounter("narrowing.region-walks") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-nodes") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-member-reads") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-member-reads-with-live-facts") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-facts-killed") > 0L)
    }

    @Fact
    func TheReportDoesNotChangeTheDiagnostics() {
        // The mode reads the binder state. A program with a rejected read and a loop reports the same diagnostics.
        let source = `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = Get()
    }
    return total + s.Length
}`
        let plain = Evaluate(source)
        NarrowingComparison.BeginCapture()
        var compared EmittedOracleResult
        try {
            compared = Evaluate(source)
        } finally {
            NarrowingComparison.EndCapture()
        }
        Assert.NotEmpty(plain.Diagnostics)
        Assert.Equal(
            plain.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray(),
            compared.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray()
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(
                []string{source},
                EmittedOracleOptions{IsLibrary: !source.Contains("func Main")}
            )
        }

        // The report lines of one kind, as `line|rest of the fields` (tab separated fields joined with `|`).
        private func Capture(source string, kind string) List[string] {
            NarrowingComparison.BeginCapture()
            var lines = List[string]()
            try {
                Evaluate(source)
            } finally {
                lines = NarrowingComparison.EndCapture()
            }
            let result = List[string]()
            for line in lines {
                let fields = line.Split('\t')
                if fields[0] != kind {
                    continue
                }
                let location = fields[1]
                let lineNumber = location.Substring(location.LastIndexOf(':') + 1)
                result.Add(lineNumber + "|" + string.Join("|", fields.Skip(2)))
            }
            return result
        }

        private func Prefix(line string, fields int32) string -> string.Join("|", line.Split('|').Take(fields))

        // The line, the path, the break marker and the line of the first `!!` site.
        private func Sites(line string) string {
            let fields = line.Split('|')
            let site = fields[3]
            return fields[0] + "|" + fields[1] + "|" + fields[2] + "|" + site.Substring(site.LastIndexOf(':') + 1)
        }

        private func Rows() IEnumerable[[]object] {
            let rows = List[[]object]()
            let Add = func (name string, source string, expected string, agreeing string) {
                rows.Add([]object{name, source, expected, agreeing})
            }
            Add("e2b-exit-path-write (R7 a)", `package T
func Get() string? { return nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        if c {
            s = nil
            break
        }
    }
    return total
}`, "7|s|nullability|P7(no-proof)|R7 a", "1/1/0")
            Add("e3-call-reassignment (R7 b)", `package T
func Get() string? { return nil }
func Make() string { return "x" }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = Make()
    }
    return total
}`, "8|s|nullability|P7(call)|R7 b", "1/1/0")
            Add("variable-reassignment (R7 b)", `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    let fresh string = "q"
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = fresh
    }
    return total
}`, "8|s|nullability|P7(variable)|R7 b", "1/1/0")
            Add("constructor-reassignment-is-kept", `package T
class Box { var V int32 = 1 }
func Get() Box? { return nil }
func Run(n int32) int32 {
    var b Box? = Get()
    if b == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + b.V
        b = Box()
    }
    return total
}`, "", "1/0/1")
            Add("c8-struct-literal-keeps-a-type-test-fact (R7 d)", `package T
open class Animal { var Name string = "a" }
class Dog : Animal { }
func Run(n int32, a Animal?) int32 {
    var x Animal? = a
    var total = 0
    if x is Dog {
        for var i = 0; i < n; i++ {
            total = total + 1
            x = Dog{}
        }
    }
    return total
}`, "", "1/0/1")
            Add("literal-reassignment-is-kept", `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = "ab"
    }
    return total
}`, "", "1/0/1")
            Add("A3-plain-call-keeps-a-by-reference-parameter", `package T
func Use(path string?) { }
func Run(ref path string?, n int32) int32 {
    if path == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        Use(path)
        total = total + 1
    }
    return total
}`, "", "1/0/1")
            Add("W5-member-read-keeps-a-by-reference-parameter (A3)", `package T
func Run(ref path string?, n int32) int32 {
    if path == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + path.Length
    }
    return total
}`, "", "1/0/1")
            Add("R11-call-kills-a-global", `package T
import System
var g string? = nil
func Touch() { g = nil }
func Main() { Console.WriteLine(Run(1)) }
func Run(n int32) int32 {
    if g == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        Touch()
        total = total + 1
    }
    return total
}`, "9|g|nullability|W4(unknown-write)|R7 c", "1/1/0")
            Add("member-path-dies-on-a-call", `package T
class Pet { var Name string = "p" }
class Box {
    let Pet Pet?
    init(pet Pet?) { Pet = pet }
}
func Work() { }
func Run(b Box, n int32) int32 {
    if b.Pet == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        Work()
        total = total + 1
    }
    return total
}`, "11|b.Pet|member|W4(member-path)|R7 c", "1/1/0")
            Add("d4-loop-form-alias-write", `package T
class C { var Value int32 = 1 }
func Run(n int32) int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + a.Value
        x = nil
    }
    return total
}`, "8|a|nullability|W3(shares-storage)|-", "1/1/0")
            Add("q3-loop-escaped-closure", `import System
class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) { h.Callback() }
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total += x.Value
        Wrapper(h)
    }
    return total
}
func Main() { Console.WriteLine(Run()) }`, "15|x|nullability|W4(unknown-write)|R7 c", "1/1/0")
            Add("q4-shadow-let-in-loop", `import System
func Get() string? { return "xy" }
func Consume(n int32) { }
func Run(n int32) int32 {
    var s string? = "abc"
    if s == nil { return 0 }
    for var i = 0; i < n; i++ {
        let s string? = Get()
        if s == nil { continue }
        Consume(s.Length)
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(2)) }`, "", "1/0/1")
            Add("q5c-imported-getter-closure-root", `import System
import System.Text
class C {
    var Value int32 = 1
}
func Run(sb StringBuilder, n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        let len = sb.Length
        total = x.Value
        total = len
    }
    clear()
    return total
}
func Main() { Console.WriteLine(Run(StringBuilder(), 2)) }`, "11|x|nullability|W5(unknown-write)|R7 e", "1/1/0")
            Add("q5d-hidden-field-getter", `import System
class C {
    var Value int32 = 1
}
open class Base {
    var Count int32 = 1
}
class Derived : Base {
    let clear () -> void
    init(c () -> void) { clear = c }
    prop Count int32 {
        get {
            clear()
            return 0
        }
    }
}
func Run(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let b Base = Derived(clear)
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = x.Value
        if b is Derived {
            let c = b.Count
            total = c
        }
    }
    return total
}
func Main() { Console.WriteLine(Run(2)) }`, "24|x|nullability|W5(unknown-write)|R7 e", "1/1/0")
            Add("q14-enclosing-filter-reenters-loop", `import System
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = "abc"
    var n = 0
    if s == nil { return 0 }
    try {
        while s.Length > 0 && n < 2 {
            n++
            try {
                try {
                    throw FormatException("f")
                } finally {
                    throw InvalidOperationException("g")
                }
            } catch (InvalidOperationException) {
            }
        }
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
    return n
}
func Main() { Console.WriteLine(Run()) }`, "11|s|nullability|W8|R10", "1/1/0")
            Add("out-alias-write-through-a-by-reference-parameter", `package T
func Run(ref s string?, n int32) int32 {
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + 1
        s = "ab"
    }
    return total
}`, "5|s|nullability|P7(root-not-exact-storage)|R7 b", "1/1/0")
            Add("W8-no-handler-no-filter-write", `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        try {
            total = total + 1
        } catch (e Exception) {
            total = total - 1
        }
    }
    return total
}`, "", "1/0/1")
            Add("W7-closure-assigns-a-captured-root-inside-the-loop", `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + 1
        let clear = func() { s = nil }
    }
    return total
}`, "7|s|nullability|P7(no-proof)|R7 b", "1/1/0")
            Add("W3-ref-argument-writes-the-root", `package T
func Clear(ref s string?) { s = nil }
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        Clear(ref s)
    }
    return total
}`, "8|s|nullability|P7(written-through-reference)|R7 b", "1/1/0")
            Add("Q4-pattern-variable-reassignment", `package T
func Get() string? { return nil }
func Run(v object?, n int32) int32 {
    var cur string? = Get()
    if cur == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + cur.Length
        if v is string s {
            cur = s
        }
    }
    return total
}`, "7|cur|nullability|P7(variable:pattern-bound)|R7 b", "1/1/0")
            Add("A3-one-storage-passed-twice-through-a-ref-local", `package T

func Clear2(ref x string?, ref y string?) {
    x = nil
    y = nil
}

func Run(ref a string?, ref b string?, n int32) int32 {
    if a == nil { return 0 }
    let ref c string? = b
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + 1
        Clear2(ref b, ref c)
    }
    return total
}`, "12|a|nullability|W3(shares-storage)|-", "1/1/0")
            return rows
        }
    }
}
