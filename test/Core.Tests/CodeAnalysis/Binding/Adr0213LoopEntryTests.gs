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
        let result = EmittedOracle.Evaluate(
            []string{source},
            EmittedOracleOptions{IsLibrary: !source.Contains("func Main")}
        )
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
        EmittedOracle.Evaluate([]string{`package T
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
}`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Equal(0L, measurements.GetCounter("narrowing.loop-rebinds"))
    }

    @Fact
    func StatementDeconstructionOfAnImportedType_IsACall() {
        // Rule W4: `let (a, b) = pair` calls an imported `Deconstruct`, which can run user code.
        using let fixture = CSharpFixture(`namespace Adr0213Deconstruct;
public sealed class Pair {
    public static System.Action? OnDeconstruct;
    public void Deconstruct(out int a, out int b) { OnDeconstruct?.Invoke(); a = 1; b = 2; }
}`)
        let result = EmittedOracle.Evaluate([]string{`package T
import Adr0213Deconstruct
var g string? = "safe"
func Run(p Pair) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        let (a, b) = p
    }
}
func Main() { }`}, EmittedOracleOptions{References: []string{fixture.AssemblyPath}})
        let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Id).ToArray()
        Assert.Equal("GS0155", string.Join(" ", errors))
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
func Run(flag bool) string {
    g = "safe"
    if g == nil { return "" }
    for item in []int32{1, 2} {
        if flag == true { return g }
    }
    return g
}
func Main() { Console.WriteLine(Run(false)) }`, "")
            Add("iteration-with-user-code-removes-a-global (R11, #5170)", `package T
import System
import System.Collections.Generic
var g string? = nil
func Run(items List[int32], flag bool) string {
    g = "safe"
    if g == nil { return "" }
    for item in items {
        if flag == true { return g }
    }
    return ""
}
func Main() { Console.WriteLine(Run(List[int32](), false)) }`, "GS0155")
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
            Add("bare-property-read-runs-a-getter (W5)", `package T
import System
var g string? = "safe"
class H {
    prop P int32 {
        get {
            g = nil
            return 1
        }
    }
    func Run() int32 {
        var t = 0
        if g != nil {
            for var i = 0; i < 2; i++ {
                let c string = g
                t = P
            }
        }
        return t
    }
}
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155")
            Add("user-defined-operator-is-a-call (W4)", `package T
import System
var g string? = "safe"
class V { var N int32 = 1 }
func (a V) operator +(b V) V {
    g = nil
    return V{}
}
func Run() int32 {
    var t = 0
    let a = V{}
    if g != nil {
        for var i = 0; i < 2; i++ {
            let c string = g
            let s = a + a
            if c == "x" { t = t + 100 }
            t = t + 1
        }
    }
    return t
}
func Main() { Console.WriteLine(Run()) }`, "GS0155")
            Add("break-in-the-post-statement-leaves-the-loop (R7 f)", `package T
import System
func Run() int32 {
    var s string? = nil
    var i = 0
    for ; s == nil; i = 1 + { break 0 } {
    }
    return s.Length
}`, "GS0158")
            Add("value-type-construction-keeps-no-struct-fact (P7)", `package T
import System
struct S { var N int32 }
func Get() S? { return nil }
func Run(n int32) int32 {
    var s S? = Get()
    if s == nil { return 0 }
    var t = 0
    for var i = 0; i < n; i++ {
        t = s.N
        s = S{N: 1}
    }
    return t
}`, "GS0158")
            Add("enclosing-filter-removes-an-exit-fact (W8)", `package T
import System
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run(i int32) int32 {
    var s string? = nil
    try {
        while s == nil || Replace() {
            s = "ok"
        }
        return s.Length
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}
func Replace() bool {
    try {
        try {
            throw FormatException("f")
        } finally {
            throw InvalidOperationException("g")
        }
    } catch (InvalidOperationException) {
    }
    return false
}`, "GS0158")
            Add("bare-property-setter-is-a-call (W4)", `package T
import System
var g string? = "safe"
class H {
    var Store int32 = 0
    prop P int32 {
        get { return 1 }
        set {
            g = nil
        }
    }
    func Run() int32 {
        var t = 0
        if g != nil {
            for var i = 0; i < 2; i++ {
                let c string = g
                P = 1
                t = 1
            }
        }
        return t
    }
}
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155")
            Add("member-property-setter-is-a-call (W4)", `package T
import System
var g string? = "safe"
class H {
    var Store int32 = 0
    prop P int32 {
        get { return 1 }
        set {
            g = nil
        }
    }
    func Run() int32 {
        var t = 0
        if g != nil {
            for var i = 0; i < 2; i++ {
                let c string = g
                this.P = 1
                t = 1
            }
        }
        return t
    }
}
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155")
            Add("user-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class V { var N int32 = 1 }
func operator implicit (v V) int32 {
    g = nil
    return 1
}
func Run() int32 {
    let v = V{}
    var t = 0
    if g != nil {
        for var i = 0; i < 2; i++ {
            let c string = g
            let converted int32 = v
            t = 1
        }
    }
    return t
}
func Main() { Console.WriteLine(Run()) }`, "GS0155")
            Add("header-handler-with-an-enclosing-filter-removes-the-exit-fact (W8)", `package T
import System
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = nil
    try {
        while s == nil || {
            try {
                try {
                    throw FormatException("f")
                } finally {
                    throw InvalidOperationException("g")
                }
            } catch (InvalidOperationException) {
            }
            false
        } {
            s = "ok"
        }
        return s.Length
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}`, "GS0158")
            Add("nameof-reads-no-getter", `package T
import System
var g string? = "safe"
class H {
    prop P int32 { get { return 1 } }
    func Run(flag bool) string {
        if g == nil { return "" }
        for {
            if flag == true { return nameof(P) }
            if flag == true { return g }
        }
    }
}
func Main() { Console.WriteLine(H{}.Run(true)) }`, "")
            Add("literal-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Meters { var V int32 = 0 }
func operator implicit (n int32) Meters {
    g = nil
    return Meters{}
}
func Run(flag bool) string {
    if g == nil { return "" }
    var m Meters = Meters{}
    for {
        m = 5
        if flag == true { return g }
    }
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0155")
            Add("null-assertion-converting-to-the-root-is-no-proof (P7)", `package T
import System
class V { var N int32 = 1 }
func operator implicit (v V) string? { return nil }
func Run(v V) int32 {
    var s string? = "a"
    if s == nil { return 0 }
    var t = 0
    for var i = 0; i < 2; i++ {
        t = s.Length
        s = v!!
    }
    return t
}`, "GS0158")
            Add("pattern-variable-write-keeps-the-fact (Q4)", `package T
import System
class Node { var Next object? = nil
    var V int32 = 1 }
func Run(o object, n int32) int32 {
    var access Node? = o as Node
    if access == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = access.V
        if access.Next is Node inner {
            access = inner
        }
    }
    return total
}`, "")
            Add("guard-pattern-variable-write-keeps-the-fact (Q4, Core access = inner)", `package T
import System
class Node { var Next object? = nil
    var V int32 = 1 }
func Get() Node? { return nil }
func Run(o object, n int32) int32 {
    var access Node? = o as Node
    if access == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = access.V
        if access.Next is not Node inner { return total }
        access = inner
    }
    return total
}`, "")
            Add("while-header-pattern-variable-write-keeps-the-fact (Q4, translator Deconstruction shape)", `package T
class Op { var Parent Op? = nil
    var Name string = "a" }
func Run(start Op, n int32) string {
    var current Op? = start
    if current == nil { return "" }
    var last = ""
    while current.Parent is Op parent {
        last = current.Name
        current = parent
    }
    return last
}`, "")
            Add("ordinary-let-copy-write-still-removes-the-fact (Q4)", `package T
class Node { var V int32 = 1 }
func Run(n int32, other Node) int32 {
    var access Node? = other
    if access == nil { return 0 }
    let copy Node = other
    var total = 0
    for var i = 0; i < n; i++ {
        total = access.V
        access = copy
    }
    return total
}`, "GS0158")
            Add("mutable-var-copy-write-still-removes-the-fact (Q4)", `package T
class Node { var V int32 = 1 }
func Run(n int32, other Node) int32 {
    var access Node? = other
    if access == nil { return 0 }
    var copy Node = other
    var total = 0
    for var i = 0; i < n; i++ {
        total = access.V
        access = copy
    }
    return total
}`, "GS0158")
            Add("bare-property-getter-in-a-return-is-a-call (W5)", `package T
import System
var g string? = "safe"
class H {
    prop P string {
        get {
            g = nil
            return "p"
        }
    }
    func Run(flag bool) string {
        if g == nil { return "" }
        for {
            if flag == true { return g }
            if flag == true { return P }
        }
    }
}
func Main() { Console.WriteLine(H{}.Run(true)) }`, "GS0155")
            Add("user-operator-in-a-return-is-a-call (W4)", `package T
import System
var g string? = "safe"
class V { var N int32 = 1 }
func (a V) operator +(b V) string {
    g = nil
    return "v"
}
func Run(flag bool) string {
    if g == nil { return "" }
    let a = V{}
    for {
        if flag == true { return g }
        if flag == true { return a + a }
    }
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0155")
            Add("property-increment-runs-a-setter (W4)", `package T
import System
var g string? = "safe"
class H {
    prop P int32 {
        get { return 1 }
        set { g = nil }
    }
    func Run(flag bool) string {
        if g == nil { return "" }
        for {
            if flag == true { return g }
            if flag == true { P++ }
        }
    }
}
func Main() { Console.WriteLine(H{}.Run(true)) }`, "GS0155")
            Add("value-type-nil-comparison-runs-a-user-equality (W4)", `package T
import System
var g string? = "safe"
struct Token {
    var N int32
}
func (a Token) operator ==(b object?) bool {
    g = nil
    return false
}
func (a Token) operator !=(b object?) bool -> true
func Run(flag bool) string {
    if g == nil { return "" }
    let token = Token{N: 1}
    for {
        if flag == true { return g }
        if token == nil { return "t" }
    }
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0155")
            Add("boolean-condition-conversion-in-an-if-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Flag { var N int32 = 1 }
func operator implicit (f Flag) bool {
    g = nil
    return true
}
func Run(done Flag, flag bool) string {
    if g == nil { return "" }
    for {
        if flag == true { return g }
        if done { return "d" }
    }
}
func Main() { Console.WriteLine(Run(Flag{}, true)) }`, "GS0155")
            Add("closed-scope-pattern-name-denotes-the-entry-variable (Q4)", `package T
class Node { var V int32 = 1 }
func Run(o object, n int32) int32 {
    var access Node? = Node()
    if access == nil { return 0 }
    var inner Node? = nil
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + access.V
        if i < 0 {
            if o is Node inner { total = total + inner.V }
        }
        access = inner
    }
    return total
}`, "GS0158")
            Add("when-false-pattern-name-in-the-then-branch-denotes-the-entry-variable (Q4)", `package T
class Node { var V int32 = 1 }
func Run(o object, n int32) int32 {
    var access Node? = Node()
    if access == nil { return 0 }
    var inner Node? = nil
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + access.V
        if o is not Node inner { access = inner }
    }
    return total
}`, "GS0158")
            Add("write-to-a-when-false-pattern-name-writes-the-entry-variable (W1)", `package T
class Node { var V int32 = 1 }
func Run(o object, n int32) int32 {
    var inner Node? = Node()
    if inner == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + inner.V
        if o is not Node inner { inner = nil }
    }
    return total
}`, "GS0158")
            Add("guard-without-an-exit-leaks-no-pattern-variable (Q4)", `package T
class Node { var V int32 = 1 }
func Run(o object, n int32) int32 {
    var access Node? = Node()
    if access == nil { return 0 }
    var inner Node? = nil
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + access.V
        if o is not Node inner { total = total + 1 }
        access = inner
    }
    return total
}`, "GS0158")
            Add("guard-leak-is-dropped-in-a-function-with-a-label (Q4)", `package T
class Node { var V int32 = 1 }
func Run(o object, n int32) int32 {
    var access Node? = Node()
    var inner Node? = nil
    var total = 0
    if access != nil {
        for var i = 0; i < n; i++ {
            total = total + access.V
            if o is not Node inner { return total }
            access = inner
        }
    }
    if total < 0 { goto done }
done:
    return total
}`, "GS0158")
            Add("when-false-pattern-name-in-the-then-branch-is-a-bare-property-read (W5)", `package T
var g string? = "safe"
class H {
    prop inner string {
        get {
            g = nil
            return "p"
        }
    }
    func Run(o object, flag bool) string {
        if g == nil { return "" }
        for {
            if flag == true { return g }
            if o is not string inner { return inner }
        }
    }
}
func Main() { }`, "GS0155")
            Add("negated-guard-pattern-variable-write-keeps-the-fact (Q4)", `package T
class Node { var V int32 = 1
    var Next object? = nil }
func Run(o object, n int32) int32 {
    var access Node? = o as Node
    if access == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + access.V
        if !(access.Next is Node inner) { continue }
        access = inner
    }
    return total
}`, "")
            Add("for-clause-condition-pattern-variable-write-keeps-the-fact (Q4)", `package T
class Node { var V int32 = 1
    var Next object? = nil }
func Run(o object, n int32) int32 {
    var access Node? = o as Node
    if access == nil { return 0 }
    var total = 0
    for var i = 0; i < n && access.Next is Node inner; i++ {
        total = total + access.V
        access = inner
    }
    return total
}`, "")
            Add("for-condition-pattern-variable-write-keeps-the-fact (Q4)", `package T
class Op { var Parent Op? = nil
    var Name string = "a" }
func Run(start Op) string {
    var current Op? = start
    if current == nil { return "" }
    var last = ""
    for current.Parent is Op parent {
        last = current.Name
        current = parent
    }
    return last
}`, "")
            Add("return-value-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Box { var N int32 = 1 }
func operator implicit (b Box) string {
    g = nil
    throw InvalidOperationException("c")
}
func Run(b Box) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        try { return b } catch (InvalidOperationException) { }
    }
}
func Main() { }`, "GS0155")
            Add("switch-guard-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Flag { var N int32 = 1 }
func operator implicit (f Flag) bool {
    g = nil
    return false
}
func Run(f Flag) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        switch i {
            case 1 when f { return "x" }
            default { }
        }
    }
}
func Main() { }`, "GS0155")
            Add("block-valued-condition-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Flag { var N int32 = 1 }
func operator implicit (f Flag) bool {
    g = nil
    return true
}
func Run(f Flag) string {
    if g == nil { return "" }
    var i = 0
    while { f } {
        if i > 0 { return g }
        i++
    }
    return "end"
}
func Main() { }`, "GS0155")
            Add("if-let-guard-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Flag { var N int32 = 1 }
func operator implicit (f Flag) bool {
    g = nil
    return false
}
func Run(f Flag, s string?) string {
    if g == nil { return "" }
    var i = 0
    while i < 2 {
        if i > 0 { return g }
        i++
        if let v = s && f { }
    }
    return "end"
}
func Main() { }`, "GS0155")
            Add("typed-loop-variable-conversion-over-an-array-is-a-call (T5)", `package T
import System
var g string? = "safe"
class Box { var N int32 = 1 }
func operator implicit (b Box) string {
    g = nil
    return "box"
}
func Run(boxes []Box) string {
    if g == nil { return "" }
    var i = 0
    for s string in boxes {
        if i > 0 { return g }
        i++
    }
    return "end"
}
func Main() { }`, "GS0155")
            Add("return-constant-conversion-is-a-call (W4)", `package T
import System
class Meters { var V int32 = 0 }
var g Meters? = Meters{}
func operator implicit (n int32) Meters {
    g = nil
    throw InvalidOperationException("c")
}
func Run() Meters {
    if g == nil { throw InvalidOperationException("n") }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        try { return 5 } catch (InvalidOperationException) { }
    }
}
func Main() { }`, "GS0155")
            Add("coalescing-projection-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Src {
    prop Name string {
        get {
            g = nil
            return "n"
        }
    }
}
class Dst { var Name string = "d" }
func Run(a Dst?, b Src) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        a ?? b
    }
}
func Main() { }`, "GS0155")
            Add("region-declared-callee-is-a-function-value (A3)", `package T
import System
func Invoke() { }
func Run(ref text string?, cb () -> void) int32 {
    if text == nil { return 0 }
    var n = 0
    for var i = 0; i < 2; i++ {
        n = n + text.Length
        let Invoke = cb
        Invoke()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("enclosing-filter-reached-through-a-call (W8)", `package T
import System
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Helper() {
    try {
        try {
            throw FormatException("f")
        } finally {
            throw InvalidOperationException("g")
        }
    } catch (InvalidOperationException) {
    }
}
func Run() int32 {
    var s string? = "abc"
    var n = 0
    if s == nil { return 0 }
    try {
        while s.Length > 0 && n < 2 {
            n++
            Helper()
        }
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
    return n
}
func Main() { }`, "GS0158")
            Add("nested-call-of-a-region-declared-callee-is-a-function-value (A3)", `package T
import System
func Invoke() { }
func Run(ref text string?, cb () -> void) int32 {
    if text == nil { return 0 }
    var n = 0
    for var i = 0; i < 2; i++ {
        n = n + text.Length
        let Invoke = cb
        for var j = 0; j < 1; j++ { Invoke() }
    }
    return n
}
func Main() { }`, "GS0158")
            Add("return-asserted-value-conversion-is-a-call (W4)", `package T
import System
var g string? = "safe"
class Box { var N int32 = 1 }
func operator implicit (b Box) string {
    g = nil
    throw InvalidOperationException("c")
}
func Run(b Box?) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        try { return b!! } catch (InvalidOperationException) { }
    }
}
func Main() { }`, "GS0155")
            Add("when-false-pattern-name-in-a-test-is-a-bare-property-read (W5)", `package T
var g string? = "safe"
class H {
    prop inner object {
        get {
            g = nil
            return "p"
        }
    }
    func Run(o object, flag bool) string {
        if g == nil { return "" }
        for {
            if flag == true { return g }
            if o is not string inner {
                if inner is string { }
            }
        }
    }
}
func Main() { }`, "GS0155")
            Add("delegate-invoke-member-call-is-indirect (A3)", `package T
import System
func Run(ref text string?, callback Action) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        callback.Invoke()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("function-parameter-call-is-indirect (A3)", `package T
import System
func Run(ref text string?, callback Action) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        callback()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("function-typed-field-member-call-is-indirect (A3)", `package T
import System
class Holder {
    var Cb () -> void = func() { }
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Cb()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
class Holder {
    func Do() { }
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Do()
    }
    return n
}
func Main() { }`, "")
            Add("chained-delegate-invoke-is-indirect (A3)", `package T
import System
class Holder {
    var Cb Action = Action(func() { })
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Cb.Invoke()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("interface-property-member-call-is-indirect (A3)", `package T
import System
interface IHolder {
    prop Cb Action { get; }
}
class Holder : IHolder {
    var cb Action = Action(func() { })
    prop Cb Action { get { return cb } }
}
func Run(ref text string?, holder IHolder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Cb()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("tuple-element-member-call-is-indirect (A3)", `package T
import System
func Run(ref text string?, pair (Cb Action, N int32)) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        pair.Cb()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("static-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
func Run(ref text string?, values []int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n = Math.Max(n, 1) + n
    }
    return n
}
func Main() { }`, "")
            Add("interface-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
interface IWork {
    func Do();
}
class Work : IWork {
    func Do() { }
}
func Run(ref text string?, work IWork) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        work.Do()
    }
    return n
}
func Main() { }`, "")
            Add("inherited-interface-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
interface IWork {
    func Do();
}
interface IChild : IWork { }
func Run(ref text string?, work IChild) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        work.Do()
    }
    return n
}
func Main() { }`, "")
            Add("imported-interface-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
func Run(ref text string?, values IList[int32]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        values.Clear()
    }
    return n
}
func Main() { }`, "")
            Add("object-method-on-an-interface-keeps-a-by-reference-fact (A3)", `package T
import System
interface IWork {
    func Do();
}
func Run(ref text string?, work IWork) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + work.GetHashCode() * 0
    }
    return n
}
func Main() { }`, "")
            Add("constraint-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
interface IWork {
    func Do();
}
func Run[W IWork](ref text string?, work W) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        work.Do()
    }
    return n
}
func Main() { }`, "")
            Add("extension-method-member-call-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
import System.Linq
func Run(ref text string?, values IEnumerable[int32]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + values.Count() * 0
    }
    return n
}
func Main() { }`, "")
            Add("member-call-on-a-region-narrowed-receiver-is-indirect (A3)", `package T
import System
class Holder {
    var Cb Action = Action(func() { })
}
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is Holder { o.Cb() }
    }
    return n
}
func Main() { }`, "GS0158")
            Add("delegate-base-member-call-is-indirect (A3)", `package T
import System
func Run(ref text string?, callback Delegate) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        callback.DynamicInvoke()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("tuple-element-named-like-an-extension-is-indirect (A3)", `package T
import System
import System.Linq
func Run(ref text string?, pair (Count Action, N int32)) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        pair.Count()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("interface-property-named-like-an-extension-is-indirect (A3)", `package T
import System
import System.Linq
interface IHolder {
    prop Count Action { get; }
}
func Run(ref text string?, holder IHolder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Count()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("delegate-method-keeps-a-by-reference-fact (A3)", `package T
import System
func Run(ref text string?, callback Action) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + callback.GetHashCode() * 0
    }
    return n
}
func Main() { }`, "")
            Add("function-type-invoke-member-call-is-indirect (A3)", `package T
import System
func Run(ref text string?, callback () -> void) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        callback.Invoke()
    }
    return n
}
func Main() { }`, "GS0158")
            Add("function-type-method-keeps-a-by-reference-fact (A3)", `package T
import System
func Run(ref text string?, callback () -> void) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + callback.GetHashCode() * 0
    }
    return n
}
func Main() { }`, "")
            Add("hiding-field-of-a-region-tested-type-is-indirect (A3)", `package T
import System
class Holder {
    var GetHashCode () -> int32 = func() int32 { return 0 }
}
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is Holder { n = n + o.GetHashCode() * 0 }
    }
    return n
}
func Main() { }`, "GS0158")
            Add("field-of-a-region-tested-type-named-like-an-extension-is-indirect (A3)", `package T
import System
import System.Linq
class Holder {
    var Count Action = Action(func() { })
}
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is Holder { o.Count() }
    }
    return n
}
func Main() { }`, "GS0158")
            Add("switch-case-type-test-is-a-region-type-test (A3)", `package T
import System
import System.Linq
class Holder {
    var Count Action = Action(func() { })
}
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        switch o {
        case Holder { o.Count() }
        default { }
        }
    }
    return n
}
func Main() { }`, "GS0158")
            Add("method-of-a-region-tested-generic-type-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is List[int32] { o.Clear() }
    }
    return n
}
func Main() { }`, "")
            Add("method-of-a-region-tested-qualified-type-keeps-a-by-reference-fact (A3)", `package T
import System
func Run(ref text string?, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is System.Text.StringBuilder { o.Clear() }
    }
    return n
}
func Main() { }`, "")
            Add("enum-constant-test-keeps-a-by-reference-fact (A3)", `package T
import System
enum Kind { A, B }
func Run(ref text string?, k Kind) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if k is Kind.A { n = n + k.GetHashCode() * 0 }
    }
    return n
}
func Main() { }`, "")
            Add("type-test-survives-a-sibling-nested-loop-that-shadows-the-name (A3)", `package T
import System
import System.Linq
class Holder {
    var Count Action = Action(func() { })
}
func Run(ref text string?, o object, other object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is Holder { o.Count() }
        {
            let o = other
            while false { }
        }
    }
    return n
}
func Main() { }`, "GS0158")
            return rows
        }
    }
}
