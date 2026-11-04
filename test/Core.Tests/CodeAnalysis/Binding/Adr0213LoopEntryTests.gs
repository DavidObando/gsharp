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
        // A rejection names each diagnostic and its source location (line:column), as CONTRIBUTING.md requires.
        let errors = result
            .Diagnostics
            .Where((d Diagnostic) -> d.IsError)
            .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
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
        let errors = result
            .Diagnostics
            .Where((d Diagnostic) -> d.IsError)
            .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0155@8:27", string.Join(" ", errors))
    }

    @Fact
    func NilComparisonOfAnImportedValueTypeMember_RunsItsEquality() {
        // An imported struct's `==` that takes a reference is called by `holder.Token == nil`, and can write the
        // storage that a `ref` parameter aliases (coordinator decision 2026-11-01).
        using let fixture = CSharpFixture(`namespace Adr0213NilEquality;
public struct Token {
    public static System.Action? OnCompare;
    public static bool operator ==(Token a, object? b) { OnCompare?.Invoke(); return false; }
    public static bool operator !=(Token a, object? b) { OnCompare?.Invoke(); return true; }
    public override bool Equals(object? o) => false;
    public override int GetHashCode() => 0;
}
public sealed class Holder { public Token Token; }`)
        let result = EmittedOracle.Evaluate([]string{`package T
import Adr0213NilEquality
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if holder.Token == nil { n++ }
    }
    return n
}
func Main() { }`}, EmittedOracleOptions{References: []string{fixture.AssemblyPath}})
        let errors = result
            .Diagnostics
            .Where((d Diagnostic) -> d.IsError)
            .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@6:16", string.Join(" ", errors))
    }

    @Fact
    func StaticAccessOfAnImportedType_TakesOnlyStaticCandidates() {
        // `Sink.Use(dt)` binds the static `Use(DateTimeOffset)` through an imported conversion operator, which can
        // write the storage that a `ref` parameter aliases; the instance `Use(DateTime)` is not a candidate.
        using let fixture = CSharpFixture(`namespace Adr0213StaticAccess;
public sealed class Sink {
    public void Use(System.DateTime v) { }
    public static void Use(System.DateTimeOffset v) { }
}`)
        let result = EmittedOracle.Evaluate([]string{`package T
import System
import Adr0213StaticAccess
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Sink.Use(dt)
    }
    return n
}
func Main() { }`}, EmittedOracleOptions{References: []string{fixture.AssemblyPath}})
        let errors = result
            .Diagnostics
            .Where((d Diagnostic) -> d.IsError)
            .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    @Fact
    func CompoundGenericParameterOfAnImportedConversion_IsAConversion() {
        // `Use(payload, 1)` infers `T = int32` from the second argument and converts `Payload` to `List[int32]` with
        // an imported operator, which can write the storage that a `ref` parameter aliases.
        using let fixture = CSharpFixture(`namespace Adr0213CompoundGeneric;
public sealed class Payload {
    public static System.Action? OnConvert;
    public static implicit operator System.Collections.Generic.List<int>(Payload p) {
        OnConvert?.Invoke();
        return new System.Collections.Generic.List<int>();
    }
}
public static class Sink {
    public static void Use<T>(System.Collections.Generic.List<T> xs, T item) { }
}`)
        let result = EmittedOracle.Evaluate([]string{`package T
import Adr0213CompoundGeneric
func Run(ref text string?, payload Payload) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Sink.Use(payload, 1)
    }
    return n
}
func Main() { }`}, EmittedOracleOptions{References: []string{fixture.AssemblyPath}})
        let errors = result
            .Diagnostics
            .Where((d Diagnostic) -> d.IsError)
            .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@6:16", string.Join(" ", errors))
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
}`, "GS0158@9:14")
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
}`, "GS0158@12:14")
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
}`, "GS0158@7:35")
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
func Main() { Console.WriteLine(Run(List[int32](), false)) }`, "GS0155@9:34")
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
}`, "GS0158@14:31")
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
}`, "GS0158@7:13")
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
}`, "GS0159@9:27")
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
}`, "GS0158@8:27 GS0130@9:13")
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
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155@15:32")
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
func Main() { Console.WriteLine(Run()) }`, "GS0155@14:28")
            Add("break-in-the-post-statement-leaves-the-loop (R7 f)", `package T
import System
func Run() int32 {
    var s string? = nil
    var i = 0
    for ; s == nil; i = 1 + { break 0 } {
    }
    return s.Length
}`, "GS0158@8:14")
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
}`, "GS0158@10:15")
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
}`, "GS0158@13:18")
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
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155@16:32")
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
func Main() { Console.WriteLine(H{}.Run()) }`, "GS0155@16:32")
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
func Main() { Console.WriteLine(Run()) }`, "GS0155@14:28")
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
}`, "GS0158@23:18")
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
func Main() { Console.WriteLine(Run(true)) }`, "GS0155@14:34")
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
}`, "GS0158@10:15")
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
}`, "GS0158@9:24")
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
}`, "GS0158@9:24")
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
func Main() { Console.WriteLine(H{}.Run(true)) }`, "GS0155@14:38")
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
func Main() { Console.WriteLine(Run(true)) }`, "GS0155@13:34")
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
func Main() { Console.WriteLine(H{}.Run(true)) }`, "GS0155@12:38")
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
func Main() { Console.WriteLine(Run(true)) }`, "GS0155@16:34")
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
func Main() { Console.WriteLine(Run(Flag{}, true)) }`, "GS0155@12:34")
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
}`, "GS0158@9:32")
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
}`, "GS0158@9:32")
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
}`, "GS0158@8:31")
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
}`, "GS0158@9:32")
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
}`, "GS0158@9:36")
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
func Main() { }`, "GS0155@13:38")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@17:27")
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
func Main() { }`, "GS0158@8:22")
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
func Main() { }`, "GS0158@22:17")
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
func Main() { }`, "GS0158@8:22")
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
func Main() { }`, "GS0155@13:27")
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
func Main() { }`, "GS0155@13:38")
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
func Main() { }`, "GS0158@6:16")
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
func Main() { }`, "GS0158@6:16")
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
func Main() { }`, "GS0158@9:16")
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
func Main() { }`, "GS0158@9:16")
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
func Main() { }`, "GS0158@13:16")
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
func Main() { }`, "GS0158@6:16")
            Add("static-method-member-call-is-rejected-by-the-one-rule (A3, stricter than main)", `package T
import System
func Run(ref text string?, values []int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n = Math.Max(n, 1) + n
    }
    return n
}
func Main() { }`, "GS0158@6:16")
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
func Main() { }`, "GS0158@9:16")
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
func Main() { }`, "GS0158@6:16")
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
func Main() { }`, "GS0158@7:16")
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
func Main() { }`, "GS0158@10:16")
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
func Main() { }`, "GS0158@6:16")
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
func Main() { }`, "GS0158@9:16")
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
func Main() { }`, "GS0158@10:16")
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
func Main() { }`, "GS0158@10:16")
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
func Main() { }`, "GS0158@10:16")
            Add("literal-converted-by-an-operator-is-no-proof (P7)", `package T
import System
class Box { var N int32 = 1 }
func operator implicit (i int32) Box {
    let o object? = nil
    return cast[Box](o)
}
func Run() int32 {
    var b Box? = Box()
    if b == nil { return 0 }
    var n = 0
    while b.N > 0 && n < 3 {
        n++
        b = 5
    }
    return n
}
func Main() { }`, "GS0158@12:13")
            Add("boxed-literal-keeps-the-fact (P7)", `package T
import System
func Run() int32 {
    var o object? = "a"
    if o == nil { return 0 }
    var n = 0
    while o.GetHashCode() != 0 && n < 3 {
        n++
        o = 5
    }
    return n
}
func Main() { }`, "")
            Add("region-local-alias-function-field-call-is-indirect (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let local = holder
        local.Cb()
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("member-chain-function-field-call-is-indirect (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Inner!!.Cb()
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("call-result-function-field-call-is-indirect (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Make().Cb()
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("list-element-function-field-call-is-indirect (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        list[0].Cb()
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("type-tested-local-call-is-indirect (A3)", `package T
import System
import System.Linq
interface IBase { }
class Holder : IBase {
    var Count Action = Action(func() { })
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let local IBase = holder
        if local is Holder { local.Count() }
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("member-chain-method-call-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        holder.Items[0].Do()
    }
    return n
}
func Main() { }`, "")
            Add("slice-element-method-call-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        arr[0].Do()
    }
    return n
}
func Main() { }`, "")
            Add("local-from-a-call-method-call-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let h = Make()
        h.Do()
    }
    return n
}
func Main() { }`, "")
            Add("call-inside-a-chain-with-a-same-name-extension-counts (A3, stricter than main)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let s = "abc"
        n = n + s.Trim().Length * 0
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("property-subpattern-type-tests-a-member-not-the-subject (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if p is { Child: Child } { p.Do() }
    }
    return n
}
func Main() { }`, "")
            Add("source-generic-tested-type-keeps-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is Box[int32] { o.Do() }
    }
    return n
}
func Main() { }`, "")
            Add("call-result-of-a-type-parameter-type-does-not-resolve (A3)", `package T
import System
class Holder {
    var Cb Action = Action(func() { })
}
func Pick[T](x T) T { return x }
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Pick(holder).Cb()
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("nested-call-operands-name-the-storage-of-a-ref-local (A3)", `package T
import System
func Clear2(ref x string?, ref y string?) { y = nil }
func Run(ref a string?, ref b string?) int32 {
    if a == nil { return 0 }
    var n = 0
    while a.Length > 0 && n < 3 {
        n++
        let ref c = b
        var m = 0
        while m < 1 {
            m++
            Clear2(ref b, ref c)
        }
    }
    return n
}
func Main() { }`, "GS0158@7:13")
            Add("member-of-a-source-interface-with-an-imported-base-resolves (A3)", `package T
import System
class Holder {
    func Do() { }
}
interface IBox : IDisposable {
    func GetChild() Holder;
}
func Run(ref s string?, box IBox) int32 {
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 && n < 3 {
        n++
        box.GetChild().Do()
    }
    return n
}
func Main() { }`, "")
            Add("imported-getter-with-user-code-removes-a-by-reference-fact (R16)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let c = Environment.CurrentDirectory
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("dictionary-indexer-removes-a-by-reference-fact (R17)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let x = dict["a"]
    }
    return n
}
func Main() { }`, "GS0158@24:16")
            Add("stable-list-indexer-keeps-a-by-reference-fact (R17)", `package T
import System
import System.Collections.Generic
class Holder {
    var Cb Action = Action(func() { })
    var Inner Holder? = nil
    var Items List[Holder] = List[Holder]()
    func Do() { }
}
class Child {
    var Do Action = Action(func() { })
}
class Parent {
    var Child Child = Child()
    func Do() { }
}
class Box[T] {
    func Do() { }
}
func Make() Holder { return Holder() }
func Run(ref text string?, holder Holder, arr []Holder, list List[Holder], dict Dictionary[string, Holder], p Parent, o object) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let c = list[0]
    }
    return n
}
func Main() { }`, "")
            Add("source-getter-with-user-code-removes-a-by-reference-fact (R14)", `package T
import System
class Holder {
    prop P int32 {
        get { return 1 }
    }
    prop Q int32 { get; set; }
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + holder.P * 0
    }
    return n
}
func Main() { }`, "GS0158@12:16")
            Add("source-auto-property-keeps-a-by-reference-fact (R14)", `package T
import System
class Holder {
    prop P int32 {
        get { return 1 }
    }
    prop Q int32 { get; set; }
}
func Run(ref text string?, holder Holder) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + holder.Q * 0
    }
    return n
}
func Main() { }`, "")
            Add("qualified-member-name-is-not-a-bare-property-read (R14)", `package T
import System
class Holder {
    prop Length int32 {
        get { return 1 }
    }
    func Run(ref s string?) int32 {
        if s == nil { return 0 }
        var n = 0
        while s.Length > 0 && n < 3 {
            n++
        }
        return n
    }
}
func Main() { }`, "")
            Add("extension-unary-operator-on-a-literal-is-a-call (W4)", `package T
import System
var g string? = "safe"
func (s string) operator -() int32 {
    g = nil
    return 5
}
func Run(flag bool) string {
    if g == nil { return "" }
    var i = 0
    for {
        if i > 0 { return g }
        i++
        -"x"
    }
}
func Main() { }`, "GS0155@12:27")
            Add("extension-operator-keeps-a-by-reference-fact (A3)", `package T
import System
func (s string) operator -() int32 {
    return 5
}
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let t = -"x"
    }
    return n
}
func Main() { }`, "")
            Add("bare-static-member-of-an-initializing-type-removes-a-by-reference-fact (R11)", `package T
import System
class Trigger {
    shared {
        var Seed int32 = Compute()
        func Compute() int32 { return 1 }
    }
    func Run(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 3 {
            n++
            let c = Seed
        }
        return n
    }
}
func Main() { }`, "GS0158@11:20")
            Add("imported-conversion-removes-a-by-reference-fact (A3)", `package T
import System

func Run(ref text string?, k int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let s ReadOnlySpan[char] = "ab"
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("constant-of-an-initializing-type-keeps-a-by-reference-fact (R11)", `package T
import System
class Lim {
    shared {
        const Count int32 = 3
        var Max int32 = Compute()
        func Compute() int32 { return 3 }
    }
}
func Run(ref text string?, k int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        n = n + Lim.Count * 0
    }
    return n
}
func Main() { }`, "")
            Add("predefined-numeric-conversion-keeps-a-by-reference-fact (A3)", `package T
import System

func Run(ref text string?, k int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let d decimal = k
    }
    return n
}
func Main() { }`, "")
            Add("argument-conversion-removes-a-by-reference-fact (A3)", `package T
import System
func Consume(s ReadOnlySpan[char]) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Consume("ab")
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("argument-without-conversion-is-rejected-by-the-one-rule (A3, stricter than main)", `package T
import System
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Console.WriteLine("ab")
        Console.WriteLine(n)
    }
    return n
}
func Main() { }`, "GS0158@6:16")
            Add("return-conversion-in-a-resumed-loop-removes-a-by-reference-fact (A3)", `package T
import System
func Run(ref text string?) ReadOnlySpan[char] {
    if text == nil { return "" }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        try {
            if n > 5 { return "ab" }
        } catch (InvalidOperationException) { }
    }
    return ""
}
func Main() { }`, "GS0158@6:16")
            Add("argument-without-a-path-counts-as-a-conversion (A3)", `package T
import System
func Use(s ReadOnlySpan[char]) { }
func Run(ref text string?, a string, flag bool) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(if flag { a } else { "x" })
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("operator-with-an-unresolved-operand-counts-as-a-conversion (A3)", `package T
import System
func Pick[T](x T) T -> x
func Run(ref text string?, m int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n = n + Pick(m)
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("if-expression-initializer-is-scoped-to-the-expression (W1)", `package T
func Run(flag bool, s0 string?) int32 {
    var s = s0
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 && n < 3 {
        n++
        let m = if var s = 0; flag { 1 } else { 2 }
        s = nil
    }
    return n
}
func Main() { }`, "GS0158@6:13")
            Add("index-argument-conversion-counts-for-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
struct Token { var Raw int32 }
func operator implicit(value int32) Token { return Token{Raw: value} }
func operator implicit(value string?) Token { return Token{Raw: 2} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }

func Run(ref text string?, flag bool, k Key, arr []int32, items List[Token]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let v = arr[k]
    }
    return n
}
func Main() { }`, "GS0158@13:16")
            Add("index-arguments-and-elements-of-built-in-types-keep-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
func Run(ref text string?, arr []int32, s string, idx Index, sp ReadOnlySpan[char], list List[int32]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let v = arr[n] + arr[idx] + arr[n + 1]
        let w = s[1..n]
        let u = arr[1..^1]
        let x = sp[1..n]
        let y = list[1..n]
        let a = []int32{1, n}
        let b = [n]int32{}
        let t string? = nil
        var d DateTime? = nil
    }
    return n
}
func Main() { }`, "")
            Add("array-element-conversion-removes-a-by-reference-fact (A3)", `package T
import System
import System.Collections.Generic
func Use(s ReadOnlySpan[char]) { }

func Run(ref text string?, dt DateTime, items List[DateTimeOffset], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let a = []DateTimeOffset{dt}
    }
    return n
}
func Main() { }`, "GS0158@9:16")
            Add("nil-to-a-value-type-counts-as-a-conversion (A3)", `package T
import System
import System.Collections.Generic
struct Token { var Raw int32 }
func operator implicit(value int32) Token { return Token{Raw: value} }
func operator implicit(value string?) Token { return Token{Raw: 2} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }

func Run(ref text string?, flag bool, k Key, arr []int32, items List[Token]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let t Token = nil
    }
    return n
}
func Main() { }`, "GS0158@13:16")
            Add("nil-argument-to-a-value-type-counts-as-a-conversion (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(value string?) Token { return Token{Raw: 2} }
func Use(t Token) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(nil)
    }
    return n
}
func Main() { }`, "GS0158@9:16")
            Add("explicit-type-argument-conversion-removes-a-by-reference-fact (A3)", `package T
import System
import System.Linq
import System.Collections.Generic
struct Token { var Raw int32 }
func Keep[T](x T) T -> x
class Box[T] {
    var Item T? = nil
    func Put(x T) { }
}

func Run(ref text string?, dt DateTime, tok Token, dict Dictionary[Token, DateTimeOffset], box Box[DateTimeOffset], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let r = Keep[DateTimeOffset](dt)
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("open-receiver-type-parameter-counts-as-a-conversion (A3)", `package T
import System
import System.Linq
import System.Collections.Generic
struct Token { var Raw int32 }
func Keep[T](x T) T -> x
class Box[T] {
    var Item T? = nil
    func Put(x T) { }
}

func Run(ref text string?, dt DateTime, tok Token, dict Dictionary[Token, DateTimeOffset], box Box[DateTimeOffset], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        dict.Add(tok, dt)
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("inferred-and-substituted-type-arguments-are-rejected-by-the-one-rule (A3, stricter than main)", `package T
import System
import System.Collections.Generic
struct Token { var Raw int32 }
func Keep[T](x T) T -> x
func Run(ref text string?, dt DateTime, tok Token, dict Dictionary[Token, DateTimeOffset]) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let k = Keep(dt)
        if dict.TryGetValue(tok, out var found) { n++ }
    }
    return n
}
func Main() { }`, "GS0158@9:16")
            Add("from-end-index-constructs-a-system-index (A3)", `package T
import System
import System.Text
import System.Collections.Generic

func Run(ref text string?, arr []int32, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let v = arr[^n]
    }
    return n
}
func Main() { }`, "GS0158@9:16")
            Add("range-value-constructs-a-system-range (A3)", `package T
import System
import System.Text
import System.Collections.Generic
import System.Collections.Immutable

func Run(ref text string?, arr []int32, s string, im ImmutableArray[int32], sp ReadOnlyMemory[char], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let r = 1..n
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("nested-array-element-conversion-counts-for-a-by-reference-fact (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let a = []Token{[]int32{1}}
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("range-bound-conversion-counts-for-a-by-reference-fact (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let v = arr[k..]
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("from-end-bound-conversion-counts-for-a-by-reference-fact (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let v = arr[..^k]
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("conversion-overload-beats-an-object-overload (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        Accept(dt)
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("string-argument-selects-a-span-overload (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        Consume("ab")
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("string-concatenation-selects-a-span-overload (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(v []int32) Token { return Token{Raw: 1} }
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Accept(d DateTimeOffset) { }
func Accept(o object) { }
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }

func Run(ref text string?, arr []int32, k Key, dt DateTime, n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        Consume("a" + "b")
    }
    return n
}
func Main() { }`, "GS0158@15:16")
            Add("operator-argument-reaches-a-conversion-overload (A3)", `package T
import System
struct Token { var Raw int32 }
func operator implicit(value int32) Token { return Token{Raw: value} }
func Use(t Token) { }
func Use(w int64) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(n + 1)
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("nested-arrays-and-exact-overloads-are-rejected-by-the-one-rule (A3, stricter than main)", `package T
import System
func Consume(n int32) { }
func Consume(s ReadOnlySpan[char]) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let a = [][]int32{[]int32{1}, []int32{n}}
        Console.WriteLine("a" + n.ToString())
        Console.WriteLine("n=${n}")
        Consume(n)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("pattern-member-getter-removes-a-by-reference-fact (R14)", `package T
import System
class Holder {
    prop P string {
        get { return "a" }
    }
}
func Run(ref text string?, holder Holder, key string) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if key is holder.P { n++ }
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("operator-result-of-a-concatenation-converts-by-its-type (A3)", `package T
import System
struct Tok { var Raw int32 }
func (a Tok) operator +(b string) DateTime { return DateTime.MinValue }
func Run(ref text string?, token Tok) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let d DateTimeOffset = token + "x"
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("named-type-argument-overload-is-not-proved-by-identity (A3)", `package T
import System
func Use[T](x T) { }
func Use(x DateTime) { }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use[DateTimeOffset](dt)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("reference-argument-of-another-type-is-not-an-identity-candidate (A3)", `package T
import System
func Use(ref a int64, b DateTime) { }
func Use(ref a int32, b DateTimeOffset) { }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    var n32 int32 = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(ref n32, dt)
    }
    return n
}
func Main() { }`, "GS0158@9:16")
            Add("type-and-enum-patterns-keep-a-by-reference-fact (A3)", `package T
import System
enum Color { Red, Green }
func Run(ref text string?, o object, c Color) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is System.String { n++ }
        if c is Color.Red { n++ }
    }
    return n
}
func Main() { }`, "")
            Add("conditional-arms-meet-through-a-conversion (A3)", `package T
import System
import System.Collections.Generic
class Payload { var N int32 = 0 }
func operator implicit(p Payload) List[int32] { return List[int32]() }
func Use[T](xs List[T], item T) { }

func Run(ref text string?, flag bool, dt DateTime, dto DateTimeOffset, payload Payload, ys List[int32], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let merged = flag ? dt : dto
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("if-expression-arms-meet-through-a-conversion (A3)", `package T
import System
import System.Collections.Generic
class Payload { var N int32 = 0 }
func operator implicit(p Payload) List[int32] { return List[int32]() }
func Use[T](xs List[T], item T) { }

func Run(ref text string?, flag bool, dt DateTime, dto DateTimeOffset, payload Payload, ys List[int32], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let merged = if flag { dt } else { dto }
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add(
                "arms-of-one-type-and-inferred-compound-parameters-are-rejected-by-the-one-rule (A3, stricter than main)",
                `package T
import System
import System.Collections.Generic
func Use[T](xs List[T], item T) { }
func Run(ref text string?, flag bool, dto DateTimeOffset, ys List[int32], n0 int32) int32 {
    if text == nil { return 0 }
    var n = n0
    while text.Length > 0 && n < 3 {
        n++
        let same = flag ? dto : dto
        let numbers = flag ? n : 2
        Use(ys, 1)
    }
    return n
}
func Main() { }`,
                "GS0158@8:16"
            )
            Add("base-call-is-not-a-call-of-a-function-of-its-name (A3)", `package T
import System
open class Parent {
    open func Touch() { }
}
func Touch() { }
class Child : Parent {
    override func Touch() { }
    func Run(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 3 {
            n++
            base.Touch()
        }
        return n
    }
}
func Main() { }`, "GS0158@12:20")
            Add("function-literal-argument-proves-no-identity-overload (A3)", `package T
import System
func Use(f (int32) -> int32, d DateTime) { }
func Use(f () -> int32, d DateTimeOffset) { }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(() -> 1, dt)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("literal-arm-is-a-conversion-target (A3)", `package T
import System
import System.Runtime.InteropServices
func Run(ref text string?, flag bool, nf NFloat) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let merged = flag ? nf : 1.0
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("nested-write-from-an-enclosing-pattern-variable-keeps-the-fact (Q4)", `package T
class Node {
    var V int32 = 0
    var Next Node? = nil
}
func Run(start Node?) int32 {
    var access = start
    if access == nil { return 0 }
    var total = 0
    var steps = 0
    while steps < 3 {
        steps++
        total = total + access.V
        if access.Next is Node inner {
            for var i = 0; i < 1; i++ {
                access = inner
            }
        }
    }
    return total
}
func Main() { }`, "")
            Add("arm-paths-are-taken-in-their-scopes (A3)", `package T
import System
func Run(ref text string?, flag bool, x DateTimeOffset, dt DateTime, dto DateTimeOffset) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let merged = if var x = dt; flag { x } else { dto }
    }
    return n
}
func Main() { }`, "GS0158@6:16")
            Add("if-let-expression-arms-meet-through-a-conversion (A3)", `package T
import System
func Run(ref text string?, maybe string?, dt DateTime, dto DateTimeOffset) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let merged = if let v = maybe { dt } else { dto }
    }
    return n
}
func Main() { }`, "GS0158@6:16")
            Add("merge-with-more-arms-than-the-bound-counts (A3)", `package T
func Run(ref text string?, k int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let picked = k == 1 ? 1 : k == 2 ? 2 : k == 3 ? 3 : k == 4 ? 4 : k == 5 ? 5 : k == 6 ? 6 : k == 7 ? 7 : k == 8 ? 8 : 9
    }
    return n
}
func Main() { }`, "GS0158@5:16")
            Add("operator-arms-meet-through-user-operator-results (A3)", `package T
import System
struct A { var Raw int32 }
struct B { var Raw int32 }
func (a A) operator +(k int32) DateTime { return DateTime.MinValue }
func (b B) operator +(k int32) DateTimeOffset { return DateTimeOffset.MinValue }
func Run(ref text string?, flag bool, a A, b B) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let merged = flag ? a + 1 : b + 1
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("pattern-index-of-a-variable-is-an-index-access (A3)", `package T
import System
struct Key { var Raw int32 }
func operator implicit(value Key) int32 { return value.Raw }
func Run(ref text string?, xs []int32, key Key, k int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if k is xs[key] { n++ }
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("generic-candidate-without-inferable-type-arguments-is-not-applicable (A3)", `package T
import System
func Use[T](x DateTime) { }
func Use(x DateTimeOffset) { }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(dt)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("typed-binding-converts-its-initializer (A3)", `package T
import System
func Run(ref text string?, maybe DateTime?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if let b DateTimeOffset = maybe { n++ }
    }
    return n
}
func Main() { }`, "GS0158@6:16")
            Add("while-let-initializers-see-the-enclosing-scope (W1)", `package T
func Next(n int32) string? { return "x" }
func Keep(v string?) string? { return "y" }
func Run(s0 string?) int32 {
    var s = s0
    if s == nil { return 0 }
    var n = 0
    while let s = Next(s.Length), let other = Keep(s = nil) {
        n++
        if n > 3 { break }
    }
    return n
}
func Main() { }`, "GS0158@8:26")
            Add("static-access-selects-static-candidates (A3)", `package T
import System
class Sink {
    func Use(x DateTime) { }
    shared {
        func Use(x DateTimeOffset) { }
    }
}
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Sink.Use(dt)
    }
    return n
}
func Main() { }`, "GS0158@12:16")
            Add("loop-entry-removals-are-restored-for-the-else-branch (R18)", `package T
var cleaner () -> void = func() { }
func Run(flag bool, text string) int32 {
    var s string? = "a"
    cleaner = func() { s = nil }
    if s == nil { return 0 }
    if flag {
        while flag {
            let n = text.Length
        }
    } else {
        return s.Length
    }
    return 0
}
func Main() { }`, "")
            Add("constant-pattern-with-a-user-equals-keeps-a-by-reference-fact (A3, R19)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run(ref s string?, o object) int32 {
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 && n < 3 {
        n++
        let m = o is 1
    }
    return n
}
func Main() { }`, "")
            Add("list-pattern-over-a-user-count-removes-a-by-reference-fact (R19)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
class L : IList[int32] {
    var Wipe () -> void = func() { }
    prop Count int32 {
        get {
            Wipe()
            return 1
        }
    }
    prop IsReadOnly bool -> true
    prop this[i int32] int32 {
        get { return 1 }
        set { }
    }
    func IndexOf(item int32) int32 -> 0
    func Insert(index int32, item int32) { }
    func RemoveAt(index int32) { }
    func Add(item int32) { }
    func Clear() { }
    func Contains(item int32) bool -> true
    func CopyTo(array []int32, index int32) { }
    func Remove(item int32) bool -> false
    func GetEnumerator() IEnumerator[int32] -> List[int32]{1}.GetEnumerator()
    func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}
func Run(ref s string?, items ReadOnlyCollection[int32]) int32 {
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 && n < 3 {
        n++
        let m = items is [1]
    }
    return n
}
func Main() { }`, "GS0158@45:13")
            Add("constant-pattern-with-a-user-equals-removes-a-captured-fact (R19)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
    var Go bool = true
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run() int32 {
    let e = E{}
    let o object = e
    let i int32 = 5
    let d = Dictionary[int32, int32]()
    let li = List[int32]{1}
    let arr = []int32{1}
    var x C? = C{}
    e.Clear = func() { x = nil }
    if x == nil { return 0 }
    var n = 0
    var more = true
    while true {
        if o is 1 { break }
        break
    }
    return x.Value
}
func Main() { }`, "GS0158@35:14")
            Add("constant-pattern-on-a-primitive-keeps-a-captured-fact (R19)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
    var Go bool = true
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run() int32 {
    let e = E{}
    let o object = e
    let i int32 = 5
    let d = Dictionary[int32, int32]()
    let li = List[int32]{1}
    let arr = []int32{1}
    var x C? = C{}
    e.Clear = func() { x = nil }
    if x == nil { return 0 }
    var n = 0
    var more = true
    while true {
        if i is 1 { break }
        break
    }
    return x.Value
}
func Main() { }`, "")
            Add("list-pattern-over-a-list-counts-as-a-read (W5, stricter than R19)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run(ref s string?, li List[int32]) int32 {
    if s == nil { return 0 }
    var n = 0
    while s.Length > 0 && n < 3 {
        n++
        let m = li is [1]
    }
    return n
}
func Main() { }`, "GS0158@21:13")
            Add("switch-case-continue-after-a-user-equals-removes-the-fact (R19, #5629)", `package T
import System
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class C {
    var Value int32 = 1
    var Go bool = true
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
var g C? = C{}
func Run() int32 {
    let e = E{}
    let o object = e
    e.Clear = func() { g = nil }
    if g == nil { return 0 }
    var k = 0
    while true {
        k = k + g.Value
        if k > 3 { break }
        switch o { case 1 { continue } default { } }
        break
    }
    return k
}
func Main() { }`, "GS0158@27:19")
            Add("out-declaration-takes-only-a-by-reference-overload (A3)", `package T
import System
func Use(v int32, d DateTime) { }
func Use(out v int32, d DateTimeOffset) { v = 1 }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(out var v, dt)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("nullable-value-argument-is-not-its-value-type (A3)", `package T
import System
func Use(d DateTime) { }
func Use(d DateTimeOffset?) { }
func Run(ref text string?, dt DateTime?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(dt)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("typed-range-loop-with-a-predefined-conversion-keeps-the-fact (T5)", `package T
import System
func Run(ref text string?, values []int32) int32 {
    if text == nil { return 0 }
    var n = 0
    for v int64 in values {
        n = n + text.Length
    }
    return n
}
func Main() { }`, "")
            Add("with-update-runs-a-setter (W4)", `package T
import System
data class D(Name string) {
    prop Extra int32 {
        get { return 0 }
        set { Hook.Run() }
    }
}
class Hook {
    shared {
        var Run () -> void = func() { }
    }
}
func Loop(ref text string?, d D) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let c = d with { Extra = 1 }
    }
    return n
}
func Main() { }`, "GS0158@17:16")
            Add("typed-nullable-local-keeps-its-question-mark (A3)", `package T
import System
func Use(d DateTime) { }
func Use(d DateTimeOffset?) { }
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        let local DateTime? = dt
        Use(local)
    }
    return n
}
func Main() { }`, "GS0158@8:16")
            Add("narrowing-that-the-loop-removes-leaves-the-nullable-argument (A3, stricter)", `package T
import System
func Use(d DateTime) { }
func Use(d DateTimeOffset?) { }
func Run(ref text string?, dt DateTime?) int32 {
    if text == nil { return 0 }
    var d = dt
    if d == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(d)
        d = nil
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("in-argument-takes-an-in-parameter (A3)", `package T
import System
func Read(in v int32) { }
func Run(ref text string?, x int32) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Read(in x)
    }
    return n
}
func Main() { }`, "")
            Add("comparison-with-an-unresolved-operand-counts (A3)", `package T
import System
func Pick[T](v T) T -> v
func Run(ref text string?, token DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if Pick(token) == Pick(token) { n++ }
    }
    return n
}
func Main() { }`, "GS0158@7:16")
            Add("bare-open-auto-property-read-can-run-an-override (R14, #5632)", `package T
import System
class Box {
    shared {
        var G string? = "x"
    }
}
open class Base {
    open prop Auto int32 { get; set; }
    func Run(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 3 {
            n++
            n = n + Auto * 0
        }
        return n
    }
}
class Derived : Base {
    override prop Auto int32 {
        get {
            Box.G = nil
            return 1
        }
        set { }
    }
}
func Main() { Console.WriteLine(Derived().Run(ref Box.G)) }`, "GS0158@13:20")
            Add("each-receiver-alternative-binds-its-own-overloads (A3)", `package T
import System
class A {
    func Use(d DateTime) { }
}
class B {
    func Use(d DateTimeOffset) { }
}
func Run(ref text string?, o object, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is A { }
        if o is B { o.Use(dt) }
    }
    return n
}
func Main() { }`, "GS0158@12:16")
            Add("receiver-alternative-with-an-optional-parameter-counts (A3)", `package T
import System
class A {
    func Use(d DateTime) { }
}
class B {
    func Use(d DateTimeOffset, extra int32 = 0) { }
}
func Run(ref text string?, o object, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is A { }
        if o is B { o.Use(dt) }
    }
    return n
}
func Main() { }`, "GS0158@12:16")
            Add("receiver-alternative-bound-by-an-extension-counts (A3)", `package T
import System
class A {
    func Use(d DateTime) { }
}
class B { }
func (b B) Use(d DateTimeOffset) { }
func Run(ref text string?, o object, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if o is A { }
        if o is B { o.Use(dt) }
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("receiver-alternative-imported-interface-with-a-base-interface-overload-counts (A3)", `package T
import System
import System.Collections.Generic
open class A {
    func Add(d DateTime) { }
}
func Run(ref text string?, x IList[DateTimeOffset], dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if x is A { }
        x.Add(dt)
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("typed-out-declaration-proves-no-candidate (A3)", `package T
import System
import System.Globalization
class S {
    func Use(out r string, d DateTime) { r = "" }
    func Use(out r int32, d DateTimeOffset) { r = 0 }
}
func Run(ref text string?, s S, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(out var v int32, dt)
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("shared-method-type-parameter-is-inferred-jointly (A3)", `package T
import System
import System.Globalization
class S {
    func Use[T](a T, b T) { }
}
func Run(ref text string?, s S, dto DateTimeOffset, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(dto, dt)
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("source-method-before-an-imported-base-exact-overload (A3)", `package T
import System
import System.Globalization
class D : GregorianCalendar {
    func AddDays(time DateTimeOffset, days int32) DateTime { return DateTime.Now }
}
func Run(ref text string?, d D, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        d.AddDays(dt, 1)
    }
    return n
}
func Main() { }`, "GS0158@10:16")
            Add("explicit-interface-method-is-not-the-binding-candidate (A3)", `package T
import System
interface IUse {
    func Use(d DateTime);
}
class D : IUse {
    func (IUse) Use(d DateTime) { }
    func Use(d DateTimeOffset) { }
}
func Run(ref text string?, d D, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        d.Use(dt)
    }
    return n
}
func Main() { }`, "GS0158@13:16")
            Add("receiver-alternative-source-interface-with-an-imported-base-overload-counts (A3)", `package T
import System
import System.Collections.Generic
interface I : IList[DateTimeOffset] { }
open class A {
    func Add(d DateTime) { }
}
func Run(ref text string?, x I, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        if x is A { }
        x.Add(dt)
    }
    return n
}
func Main() { }`, "GS0158@11:16")
            Add("static-call-on-an-interface-binds-its-shared-methods (A3)", `package T
import System
interface IS {
    shared {
        func Use(d DateTimeOffset) { }
    }
    func Use(d DateTime);
}
func Run(ref text string?, dt DateTime) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        IS.Use(dt)
    }
    return n
}
func Main() { }`, "GS0158@12:16")
            Add("function-literal-converted-by-an-operator-counts (A3, #5663)", `package T
import System
struct Payload { var Raw int32 }
var g string? = "ab"
func operator implicit(f () -> int32) Payload {
    g = nil
    return Payload{Raw: f()}
}
func Use(p Payload) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        Use(func() int32 { return 1 })
    }
    return n
}
func Main() { }`, "GS0158@13:16")
            Add("guard-else-sees-an-enclosing-name-that-a-later-binding-hides (W5)", `package T
import System
var g string? = "ab"
class Holder {
    prop Clear int32 {
        get {
            g = nil
            return 1
        }
    }
    func Run(ref text string?, one int32?, two int32?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 3 {
            n++
            guard let a = one, let Clear = two else {
                let ignored = Clear
                continue
            }
        }
        return n
    }
}
func Main() { }`, "GS0158@14:20")
            Add("relational-pattern-operand-is-a-conversion-site (W4)", `package T
import System
var g string? = "ab"
struct Threshold { var Raw int32 }
func operator implicit(t Threshold) int32 {
    g = nil
    return t.Raw
}
func Run(ref text string?, n int32, threshold Threshold) int32 {
    if text == nil { return 0 }
    var k = 0
    while text.Length > 0 && k < 3 {
        k++
        if n is > threshold { }
    }
    return k
}
func Main() { }`, "GS0158@12:16")
            Add("default-interface-bare-property-read-and-write-are-calls (#5470)", `package T
import System
class C { }
interface IAccess {
    prop P int32 { get; set; }
    func ReadInLoop(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        while n < 2 {
            let b C = item
            let v = P
            n = n + 1
        }
        return n
    }
    func WriteInLoop(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        while n < 2 {
            let b C = item
            P = 1
            n = n + 1
        }
        return n
    }
}
func Main() { }`, "GS0155@10:23 GS0155@20:23")
            Add("inherited-clr-bare-property-read-and-write-are-calls (#5470)", `package T
import System
class C { }
var g C? = C()
class MyError : Exception {
    func ReadInLoop(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        while n < 2 {
            let a C = g
            let b C = item
            let m = Message
            n = n + 1
        }
        return n
    }
    func WriteInLoop(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        while n < 2 {
            let a C = g
            let b C = item
            HelpLink = "x"
            n = n + 1
        }
        return n
    }
}
func Main() { }`, "GS0155@10:23 GS0155@11:23 GS0155@21:23 GS0155@22:23")
            Add("inherited-stable-clr-bare-getter-keeps-a-by-reference-fact (#5470, R16)", `package T
import System
import System.Collections.Generic
class MyList : List[int32] {
    func Run(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 2 {
            n = n + Count + 1
        }
        return n
    }
}
func Main() { }`, "")
            Add("conversion-free-declarations-and-assignments-keep-every-fact (#5657)", `package T
import System
class C { var Value int32 }
class Box {
    let Item C?
    init(item C?) { Item = item }
}
var g C? = C()
func RunGlobal() C {
    if g == nil { return C() }
    while true {
        let n = 1
        return g
    }
    return C()
}
func RunCapturedAndMember(box Box) int32 {
    var local C? = C()
    let clear = func() { local = nil }
    if local == nil || box.Item == nil { return 0 }
    var k = 0
    while k < 2 {
        let step = 1
        let typedStep int32 = step
        var copy int32 = 0
        copy = typedStep
        k = k + 1
    }
    return local.Value + box.Item.Value + k
}
func Main() { }`, "")
            Add("static-import-bare-getter-and-type-initializer-are-calls (#5470, #5657)", `package T
import System
import T.Host
class C { }
var g C? = C()
class Host {
    shared {
        var Seed int32 = Init()
        func Init() int32 {
            g = nil
            return 1
        }
        prop Level int32 {
            get {
                g = nil
                return 1
            }
        }
    }
}
func ReadGetter(ref item C?) int32 {
    if g == nil || item == nil { return 0 }
    var n = 0
    while n < 2 {
        let a C = g
        let b C = item
        let v = Level
        n = n + 1
    }
    return n
}
func ReadInitializingField(ref item C?) int32 {
    if g == nil || item == nil { return 0 }
    var n = 0
    while n < 2 {
        let a C = g
        let b C = item
        let v = Seed
        n = n + 1
    }
    return n
}
func Main() { }`, "GS0155@25:19 GS0155@26:19 GS0155@36:19 GS0155@37:19")
            Add("populated-map-literal-is-a-call (#5657)", `package T
import System
class C { }
var g C? = C()
class Key {
    override func GetHashCode() int32 {
        g = nil
        return 1
    }
    override func Equals(o object?) bool -> true
}
func Run(ref item C?, key Key) int32 {
    if g == nil || item == nil { return 0 }
    var n = 0
    while n < 2 {
        let a C = g
        let b C = item
        let m = map[Key, int32]{key: 1}
        n = n + 1
    }
    return n
}
func Main() { }`, "GS0155@16:19 GS0155@17:19")
            Add("channel-capacity-conversion-and-static-import-lexical-collision-are-calls (#5470, #5657)", `package T
import System
import T.Host
class C { }
var g C? = C()
struct Cap { var Raw int32 }
func operator implicit(c Cap) int32 {
    g = nil
    return c.Raw
}
class Host {
    shared {
        const Message string = "const"
    }
}
class SubError : Exception {
    func RunCollision(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        while n < 2 {
            let a C = g
            let b C = item
            let m = Message
            n = n + 1
        }
        return n
    }
}
func RunChannel(ref item C?, cap Cap) int32 {
    if g == nil || item == nil { return 0 }
    var n = 0
    while n < 2 {
        let a C = g
        let b C = item
        let ch = chan[int32](cap)
        n = n + 1
    }
    return n
}
func Main() { }`, "GS0155@33:19 GS0155@34:19 GS0155@21:23 GS0155@22:23")
            return rows
        }
    }
}
