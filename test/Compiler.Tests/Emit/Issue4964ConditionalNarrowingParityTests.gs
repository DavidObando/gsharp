// <copyright file="Issue4964ConditionalNarrowingParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #4964: the conditional operator (`c ? a : b`) and the
/// if-expression (`if c { a } else { b }`) are two spellings of one value
/// form, and both lower to `BoundConditionalExpression`. Only the
/// if-expression bound its branches under the smart-cast narrowing its
/// condition implies, so `s != nil ? s.Length : 0` reported GS0158 while
/// `if s != nil { s.Length } else { 0 }` compiled.
///
/// Both binders now take their branch frames from one helper,
/// `ExpressionBinder.ClassifyConditionalNarrowing`. The parity theory binds
/// each case in both spellings and requires the same diagnostics, so the
/// two forms cannot drift apart again. The execution facts run the
/// value-type `Nullable<T>` shapes through ilverify, because a narrowed
/// value-type read that skips the `BuildNarrowedRead` unwrap leaves a
/// `Nullable<T>` on the stack.
open class Issue4964ConditionalNarrowingParityTests {
    /// The issue's repro, verbatim: every `?:` variant reported GS0158.
    @Fact
    func Issue_Repro_Compiles_Verifies_And_Prints_21() {
        let result = CompileAndRun(`import System
func ifx(s string?) int32 -> if s != nil { s.Length } else { 0 }
func ifs(s string?) int32 {
    if s != nil { return s.Length } else { return 0 }
}
func ter(s string?) int32 -> s != nil ? s.Length : 0
func terNeg(s string?) int32 -> s == nil ? 0 : s.Length
func terAnd(s string?, t string?) int32 -> (s != nil && t != nil) ? s.Length + t.Length : 0
func ifType(o object) int32 -> if o is string { o.Length } else { 0 }
func terType(o object) int32 -> (o is string) ? o.Length : 0
Console.WriteLine(ifx("abc") + ifs("abc") + ter("abc") + terNeg("abc") + terAnd("a", "bc") + ifType("abc") + terType("abc"))
`)
        Assert.Equal("21" + Environment.NewLine, result.Output)
    }

    /// A narrowed `int32?` read in a `?:` branch must be unwrapped from its
    /// `Nullable<int32>` storage. ilverify rejects the method if it is not,
    /// and the emitter throws GS9998 first. Covers `!= nil`, `== nil`, a
    /// nested ternary, the nil branch at run time, and a user struct and
    /// enum (the `IsUserValueTypeNullable` path).
    @Fact
    func Value_Type_Nullable_Branches_Unwrap_Verify_And_Run() {
        let result = CompileAndRun(`import System
struct Point {
    var X int32
    var Y int32
}
enum Color { Red, Green }
func plusOne(n int32?) int32 -> n != nil ? n + 1 : -1
func twice(n int32?) int32 -> n == nil ? -1 : n * 2
func nested(a int32?, b int32?) int32 -> a != nil ? (b != nil ? a + b : a) : 0
func sum(p Point?) int32 -> p != nil ? p.X + p.Y : -1
func name(c Color?) string -> c == nil ? "none" : c.ToString()
func pass(n int32?) int64 -> n != nil ? n : 7
Console.WriteLine("${plusOne(4)} ${plusOne(nil)} ${twice(4)} ${twice(nil)}")
Console.WriteLine("${nested(2, 3)} ${nested(2, nil)} ${nested(nil, 3)}")
Console.WriteLine("${sum(Point{X: 2, Y: 5})} ${sum(nil)} ${name(Color.Green)} ${name(nil)}")
Console.WriteLine(pass(9) + pass(nil))
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "5 -1 8 -1", "5 2 0", "7 -1 Green none", "16") + Environment.NewLine,
            result.Output
        )
    }

    /// `&&`, `||`, `!` and `!is` compose in a `?:` condition exactly as they
    /// do in an if-expression condition, and the branch that is taken at
    /// run time reads the narrowed value.
    @Fact
    func Composed_Conditions_Narrow_And_Run() {
        let result = CompileAndRun(`import System
func both(s string?, t string?) int32 -> (s != nil && t != nil) ? s.Length + t.Length : 0
func either(s string?, t string?) int32 -> (s == nil || t == nil) ? 0 : s.Length + t.Length
func negated(o object) int32 -> !(o is string) ? 0 : o.Length
func isNot(o object) int32 -> (o !is string) ? 0 : o.Length
func mixed(o object, s string?) int32 -> (o is string && s != nil) ? o.Length + s.Length : -1
Console.WriteLine("${both("a", "bc")} ${both(nil, "bc")} ${either("a", "bc")} ${either("a", nil)}")
Console.WriteLine("${negated("abc")} ${negated(1)} ${isNot("abcd")} ${isNot(1)} ${mixed("ab", "c")} ${mixed(1, "c")}")
`)
        Assert.Equal(string.Join(Environment.NewLine, "3 0 3 0", "3 0 4 0 3 -1") + Environment.NewLine, result.Output)
    }

    /// Issue #4969: composed nil guards (`!`, `&&`, `||`) over value-type
    /// nullables (`int32?`, user struct `?`, enum `?`) and `[NotNullWhen]`
    /// bool-call predicates narrow in if-expressions, `?:` ternaries, and
    /// short-circuit `&&`/`||` operands, matching the if-statement.
    @Fact
    func Issue4969_ComposedValueTypeNullableAndBoolCallGuards_NarrowVerifyAndRun() {
        let result = CompileAndRun(`import System
import System.Diagnostics.CodeAnalysis

struct Pair {
    var A int32
    var B int32
}

enum Mode { Off = 2, On = 5 }

func tryRead(flag bool, v int32?, @NotNullWhen(true) out res int32?) bool {
    res = flag ? v : nil
    return flag && v != nil
}

func exprNot(n int32?) int32 -> if !(n == nil) { n + 1 } else { -1 }
func terNot(n int32?) int32 -> !(n == nil) ? n + 1 : -1

func exprAnd(a int32?, b int32?) int32 -> if a != nil && b != nil {
    let x int32 = a
    let y int32 = b
    x + y
} else { 0 }
func terAnd(a int32?, b int32?) int32 -> (a != nil && b != nil) ? a + b : 0

func exprOrElse(a int32?, b int32?) int32 -> if a == nil || b == nil { 0 } else { a + b }
func terOrElse(a int32?, b int32?) int32 -> (a == nil || b == nil) ? 0 : a + b

func structGuard(p Pair?, q Pair?) int32 -> (p != nil && !(q == nil)) ? p.A + q.B : -1
func enumGuard(m Mode?) int32 -> if !(m == nil) { int32(m) } else { 0 }

func shortCircuitAnd(n int32?, p Pair?) bool -> n != nil && p != nil && (n + p.A) > 3
func shortCircuitOr(n int32?) bool -> n == nil || (n + 1) > 3

func exprPred(s string?) int32 -> if !string.IsNullOrEmpty(s) { s.Length } else { 0 }
func terPred(s string?) int32 -> !string.IsNullOrEmpty(s) ? s.Length : 0
func terPredElse(s string?) int32 -> string.IsNullOrEmpty(s) ? 0 : s.Length
func shortPredAnd(s string?) bool -> !string.IsNullOrEmpty(s) && s.Length == 3
func shortPredOr(s string?) bool -> string.IsNullOrEmpty(s) || s.Length == 3
func userPred(flag bool, v int32?) int32 -> tryRead(flag, v, out var r) ? r + 10 : -1

Console.WriteLine("${exprNot(4)} ${exprNot(nil)} ${terNot(4)} ${terNot(nil)}")
Console.WriteLine("${exprAnd(2, 3)} ${exprAnd(2, nil)} ${terAnd(2, 3)} ${terAnd(nil, 3)}")
Console.WriteLine("${exprOrElse(4, 5)} ${exprOrElse(4, nil)} ${terOrElse(4, 5)} ${terOrElse(nil, 5)}")
Console.WriteLine("${structGuard(Pair{A: 3, B: 1}, Pair{A: 2, B: 4})} ${structGuard(nil, Pair{A: 2, B: 4})} ${enumGuard(Mode.On)} ${enumGuard(nil)}")
Console.WriteLine("${shortCircuitAnd(2, Pair{A: 3, B: 0})} ${shortCircuitAnd(nil, Pair{A: 3, B: 0})} ${shortCircuitOr(nil)} ${shortCircuitOr(5)} ${shortCircuitOr(1)}")
Console.WriteLine("${exprPred("abc")} ${exprPred(nil)} ${terPred("abcd")} ${terPred("")} ${terPredElse("xy")} ${terPredElse(nil)}")
Console.WriteLine("${shortPredAnd("abc")} ${shortPredAnd(nil)} ${shortPredOr(nil)} ${shortPredOr("abc")} ${userPred(true, 7)} ${userPred(false, 7)}")
`)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "5 -1 5 -1",
                "5 0 5 0",
                "9 0 9 0",
                "7 -1 5 0",
                "True False True True False",
                "3 0 4 0 2 0",
                "True False True True 17 -1"
            ) +
                Environment.NewLine,
            result.Output
        )
    }

    /// Narrowing changes a branch's type, so it can change the conditional's
    /// result type: `n != nil ? n : 0` is now `int32` (it was `int32?`), as
    /// the if-expression already was. The overload chosen for the result
    /// follows, in both spellings.
    @Fact
    func Narrowed_Result_Type_Selects_The_Same_Overload_In_Both_Forms() {
        let result = CompileAndRun(`import System
func pick(x int32) string -> "int32"
func pick(x int32?) string -> "int32?"
func viaTernary(n int32?) string -> pick(n != nil ? n : 0)
func viaIf(n int32?) string -> pick(if n != nil { n } else { 0 })
Console.WriteLine("${viaTernary(1)} ${viaIf(1)} ${viaTernary(nil)} ${viaIf(nil)}")
`)
        Assert.Equal("int32 int32 int32 int32" + Environment.NewLine, result.Output)
    }

    /// Binds each case as `(c) ? a : b` and as `if c { a } else { b }` and
    /// requires identical diagnostics (id and the text each one covers).
    /// `expected` pins the result too, so a change that broke both forms the
    /// same way would still fail.
    @Theory
    @InlineData("s string?", "int32", "s != nil", "s.Length", "0", "")
    @InlineData("s string?", "int32", "s == nil", "0", "s.Length", "")
    @InlineData("s string?", "int32", "nil != s", "s.Length", "0", "")
    @InlineData("s string?, t string?", "int32", "s != nil && t != nil", "s.Length + t.Length", "0", "")
    @InlineData("s string?, t string?", "int32", "s == nil || t == nil", "0", "s.Length + t.Length", "")
    @InlineData("o object", "int32", "o is string", "o.Length", "0", "")
    @InlineData("o object", "int32", "!(o is string)", "0", "o.Length", "")
    @InlineData("o object", "int32", "(o !is string)", "0", "o.Length", "")
    @InlineData("o object, s string?", "int32", "o is string && s != nil", "o.Length + s.Length", "0", "")
    @InlineData("n int32?", "int32", "n != nil", "n + 1", "-1", "")
    @InlineData("n int32?", "int32", "n == nil", "-1", "n", "")
    @InlineData("s string?", "string", "s != nil", "s", "\"x\"", "")
    // A guard narrows only the branch it proves: the other branch keeps
    // the declared nullable type.
    @InlineData("s string?", "int32", "s == nil", "s.Length", "0", "GS0158:Length")
    @InlineData("s string?", "int32", "s != nil", "0", "s.Length", "GS0158:Length")
    @InlineData("o object", "int32", "o is string", "0", "o.Length", "GS0158:Length")
    @InlineData("s string?, t string?", "int32", "s != nil || t != nil", "s.Length", "0", "GS0158:Length")
    // A `Nullable<T>` member the narrowed type does not have binds against
    // the `Nullable<T>` storage, in both forms (issue #4986).
    @InlineData("n int32?", "int32", "n != nil", "n.Value", "0", "")
    @InlineData("n int32?", "int32", "n != nil", "n.GetValueOrDefault()", "0", "")
    @InlineData("n int32?", "bool", "n == nil", "false", "n.HasValue", "")
    // A narrowed value makes a user `!!` redundant (GS0536) in both forms,
    // including an ADR-0186 platform (`T!`) value, which a nil guard
    // narrows to `T`.
    @InlineData("s string?", "int32", "s != nil", "s!!.Length", "0", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s != nil", "s!!.Length", "0", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s == nil", "0", "s!!.Length", "GS0536:!!")
    @InlineData("@Oblivious s string", "int32", "s != nil", "0", "s!!.Length", "")
    // Composed nil guards over a VALUE-type nullable narrow in both forms
    // (issue #4969), as do [NotNullWhen] bool-call guards.
    @InlineData("n int32?", "int32", "!(n == nil)", "n", "-1", "")
    @InlineData("a int32?, b int32?", "int32", "a != nil && b != nil", "a + b", "0", "")
    @InlineData("a int32?, b int32?", "int32", "a == nil || b == nil", "0", "a + b", "")
    @InlineData("s string?", "int32", "!string.IsNullOrEmpty(s)", "s.Length", "0", "")
    @InlineData("s string?", "int32", "string.IsNullOrEmpty(s)", "0", "s.Length", "")
    @InlineData(
        "a string?, b string?",
        "int32",
        "!string.IsNullOrEmpty(a) && !string.IsNullOrEmpty(b)",
        "a.Length + b.Length",
        "0",
        ""
    )
    @InlineData(
        "a string?, b string?",
        "int32",
        "string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)",
        "0",
        "a.Length + b.Length",
        ""
    )
    @InlineData("s string?, n int32?", "int32", "!string.IsNullOrEmpty(s) && !(n == nil)", "s.Length + n", "0", "")
    @InlineData("s string?", "int32", "s != nil || !string.IsNullOrEmpty(s)", "s.Length", "0", "")
    @InlineData("s string?", "int32", "string.IsNullOrEmpty(s)", "s.Length", "0", "GS0158:Length")
    @InlineData("a int32?, b int32?", "int32", "a != nil || b != nil", "a + b", "0", "GS0156:a + b")
    @InlineData(
        "ref s string?",
        "int32",
        "!string.IsNullOrEmpty(s) && (s = nil) == nil",
        "s.Length",
        "0",
        "GS0158:Length"
    )
    @InlineData(
        "ref s string?",
        "int32",
        "string.IsNullOrEmpty(s) || (s = nil) != nil",
        "0",
        "s.Length",
        "GS0158:Length"
    )
    func Ternary_And_If_Expression_Report_The_Same_Diagnostics(
        parameters string,
        returnType string,
        condition string,
        whenTrue string,
        whenFalse string,
        expected string
    ) {
        // The condition is parenthesized because `o is string ? 0 : …` does
        // not parse as a conditional (issue #4970).
        let ternary = Diagnose(parameters, returnType, "(${condition}) ? ${whenTrue} : ${whenFalse}")
        let ifExpression = Diagnose(parameters, returnType, "if ${condition} { ${whenTrue} } else { ${whenFalse} }")
        Assert.Equal(ifExpression, ternary)
        Assert.Equal(expected, ternary)
    }

    /// Narrowing is scoped to the branch: a guarded read after the
    /// conditional is not narrowed in either form.
    @Theory
    @InlineData("s != nil ? s.Length : 0")
    @InlineData("if s != nil { s.Length } else { 0 }")
    func Narrowing_Does_Not_Leak_Past_The_Conditional(conditional string) {
        let source = (`package Issue4964.Leak
func f(s string?) int32 {
    let n = ` + conditional + `
    return n + s.Length
}
`)
        Assert.Equal("GS0158:Length", DiagnoseSource(source))
    }

    @Fact
    func Mixed_NilGuard_And_BoolCall_Or_Narrows_In_If_Statement() {
        let source = `package Issue4969.MixedOr
func f(s string?) int32 {
    if s != nil || !string.IsNullOrEmpty(s) {
        return s.Length
    }
    return 0
}
`
        Assert.Equal("", DiagnoseSource(source))
    }

    @Theory
    @InlineData("if !string.IsNullOrEmpty(g) && Clear() { return g.Length } else { return 0 }")
    @InlineData("if string.IsNullOrEmpty(g) || Clear() { return 0 } else { return g.Length }")
    @InlineData("if g != nil && Clear() { return g.Length } else { return 0 }")
    @InlineData("if g == nil || Clear() { return 0 } else { return g.Length }")
    @InlineData("return (!string.IsNullOrEmpty(g) && Clear()) ? g.Length : 0")
    @InlineData("return (string.IsNullOrEmpty(g) || Clear()) ? 0 : g.Length")
    @InlineData("return if !string.IsNullOrEmpty(g) && Clear() { g.Length } else { 0 }")
    @InlineData("return if string.IsNullOrEmpty(g) || Clear() { 0 } else { g.Length }")
    @InlineData("return (g != nil && Clear()) ? g.Length : 0")
    @InlineData("return (g == nil || Clear()) ? 0 : g.Length")
    @InlineData("return (!string.IsNullOrEmpty(g) && ClearInt() < g.Length) ? 1 : 0")
    @InlineData("return (string.IsNullOrEmpty(g) || ClearInt() < g.Length) ? 1 : 0")
    @InlineData("return HasGlobal(g) ? g.Length : 0")
    @InlineData("if HasGlobal(g) { return g.Length } else { return 0 }")
    @InlineData("return HasViaReset(g) ? g.Length : 0")
    func Right_Operand_Invalidation_Clears_Left_Narrowing_In_Statements_And_Expressions(body string) {
        let source = (`package Issue4969.RightInvalidation
import System.Diagnostics.CodeAnalysis
var g string? = "seed"
struct Reset {
    init() { g = nil }
}
func Clear() bool {
    g = nil
    return true
}
func ClearInt() int32 {
    g = nil
    return 0
}
func HasGlobal(@NotNullWhen(true) value string?) bool {
    g = nil
    return value != nil
}
func HasViaReset(@NotNullWhen(true) value string?) bool {
    let _ = Reset{}
    return value != nil
}
func f() int32 {
    ` + body + `
}
`)
        Assert.Equal("GS0158:Length", DiagnoseSource(source))
    }

    @Fact
    func MaybeNullWhen_With_Aliased_Ref_Argument_Widens_Conservatively_And_Unrelated_Ref_Preserves_NotNullWhen() {
        let aliased = `package Issue4969.MaybeNullAliased
import System.Diagnostics.CodeAnalysis
func TryGet(@MaybeNullWhen(false) out value string, ref other string) bool {
    value = "ok"
    other = "ok"
    return false
}
func Check() int32 {
    var s = "seed"
    return TryGet(out s, ref s) ? s.Length : s.Length
}
`
        Assert.Equal("GS0158:Length;GS0158:Length", DiagnoseSource(aliased))

        let unrelatedRef = `package Issue4969.UnrelatedRef
import System.Diagnostics.CodeAnalysis
func TryCheck(@NotNullWhen(true) ref text string?, ref count int32) bool {
    count = count + 1
    return text != nil
}
func Check(ref text string?, ref count int32) int32 -> TryCheck(ref text, ref count) ? text.Length : 0
`
        Assert.Equal("", DiagnoseSource(unrelatedRef))
    }

    @Theory
    @InlineData("return (dict.TryGetValue(\"missing\", out value) && flag) ? 0 : value.Length", "GS0158:Length")
    @InlineData("return (flag && dict.TryGetValue(\"missing\", out value)) ? 0 : value.Length", "GS0158:Length")
    @InlineData(
        "if dict.TryGetValue(\"missing\", out value) && flag { return 0 } else { return value.Length }",
        "GS0158:Length"
    )
    @InlineData("return (!dict.TryGetValue(\"missing\", out value) || flag) ? value.Length : 0", "GS0158:Length")
    @InlineData("return (flag || !dict.TryGetValue(\"missing\", out value)) ? value.Length : 0", "GS0158:Length")
    @InlineData("return (dict.TryGetValue(\"missing\", out value) || flag) ? value.Length : 0", "GS0158:Length")
    @InlineData(
        "if !dict.TryGetValue(\"missing\", out value) || flag { return value.Length } else { return 0 }",
        "GS0158:Length"
    )
    @InlineData("return (dict.TryGetValue(\"missing\", out value) && flag) ? value.Length : 0", "")
    @InlineData("return (!dict.TryGetValue(\"missing\", out value) || flag) ? 0 : value.Length", "")
    @InlineData(
        "return (dict.TryGetValue(\"a\", out value) || dict.TryGetValue(\"b\", out value)) ? value.Length : 0",
        ""
    )
    func Composed_MaybeNullWhen_Preserves_Widening_Across_And_And_Or(body string, expected string) {
        let source = (`package Issue4969.ComposedMaybeNull
import System.Collections.Generic
func Check(dict Dictionary[string, string], flag bool) int32 {
    var value = "seed"
    ` + body + `
}
`)
        Assert.Equal(expected, DiagnoseSource(source))
    }

    @Theory
    @InlineData("Has(s, (s = nil)) ? s.Length : 0")
    @InlineData("if Has(s, (s = nil)) { s.Length } else { 0 }")
    @InlineData("Has(s, (s = nil)) && s.Length > 0 ? 1 : 0")
    func ByValue_NotNullWhen_Invalidated_By_Subsequent_Argument_Does_Not_Narrow(expr string) {
        let source = (`package Issue4969.ByValueArgInvalidation
import System.Diagnostics.CodeAnalysis
func Has(@NotNullWhen(true) value string?, ignored string?) bool -> value != nil
func Check(ref s string?) int32 -> ` + expr + `
`)
        Assert.Equal("GS0158:Length", DiagnoseSource(source))
    }

    @Theory
    @InlineData("other.TryGet() ? _name.Length : 0")
    @InlineData("if other.TryGet() { _name.Length } else { 0 }")
    @InlineData("other.TryGet() && _name.Length > 0 ? 1 : 0")
    @InlineData("box.HasName((box = empty)) ? box.Name.Length : 0")
    @InlineData("if box.HasName((box = empty)) { box.Name.Length } else { 0 }")
    @InlineData("d.Ready() ? d.Name.Length : 0")
    @InlineData("if d.Ready() { d.Name.Length } else { 0 }")
    func MemberNotNullWhen_On_NonThis_Or_Mutated_Or_Hidden_Receiver_Does_Not_Narrow(expr string) {
        let source = (`package Issue4969.MemberNotNullReceiver
import System.Diagnostics.CodeAnalysis
open class BaseBox {
    public let Name string?
    init(name string?) { Name = name }
    @MemberNotNullWhen(true, "Name")
    public func Ready() bool -> Name != nil
    @MemberNotNullWhen(true, "Name")
    public func HasName(ignored BaseBox) bool -> Name != nil
}
class DerivedBox : BaseBox {
    public let Name string?
    init(baseName string?, derivedName string?) : base(baseName) { Name = derivedName }
}
class Box {
    var _name string?
    @MemberNotNullWhen(true, "_name")
    func TryGet() bool -> _name != nil
    func Check(other Box, ref box BaseBox, empty BaseBox, d DerivedBox) int32 -> ` + expr + `
}
`)
        Assert.Equal("GS0158:Length", DiagnoseSource(source))
    }

    /// In an expression-tree lambda the narrowed `int32?` read is rejected in
    /// both forms, because the expression-tree lowerer does not lower the
    /// value-type unwrap yet (issue #4974). Before #4964 the ternary form
    /// compiled and then threw when the tree was built.
    @Theory
    @InlineData("v != nil ? v + 1 : 0")
    @InlineData("if v != nil { v + 1 } else { 0 }")
    @InlineData("!(v == nil) ? v + 1 : 0")
    @InlineData("if !(v == nil) { v + 1 } else { 0 }")
    func Expression_Tree_Narrowed_Value_Type_Read_Is_Rejected_In_Both_Forms(conditional string) {
        let source = (`package Issue4964.ExpressionTree
import System
import System.Linq.Expressions
func f() int32 {
    let e Expression[Func[int32?, int32]] = (v int32?) -> ` + conditional + `
    return e.Compile()(1)
}
`)
        Assert.Equal("GS0473:v", DiagnoseSource(source))
    }

    shared {
        /// Binds `func f(<parameters>) <returnType> -> <body>` and renders its
        /// diagnostics as `id:covered-text` entries joined by `;`.
        private func Diagnose(parameters string, returnType string, body string) string {
            let source = (`package Issue4964.Parity
import System
func f(` + parameters + ") " + returnType + " -> " + body + `
`)
            return DiagnoseSource(source)
        }

        private func DiagnoseSource(source string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let diagnostics = compilation.Emit(peStream).Diagnostics
            return string.Join(
                ";",
                diagnostics.OrderBy((d Diagnostic) -> d.Location.Span.Start).Select(
                    (d Diagnostic) -> d.Id + ":" + source.Substring(d.Location.Span.Start, d.Location.Span.Length)
                )
            )
        }

        /// Compiles the program through the real driver, verifies it with
        /// ilverify, runs it and returns its standard output and the
        /// compiler's output.
        private func CompileAndRun(source string)(Output string, CompilerOutput string) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4964ConditionalNarrowingParityTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4964.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                let (sampleExit, stdout, stderr) = IlVerifier.RunProcess(startInfo, outputPath, 30_000)
                Assert.True(sampleExit == 0, (`sample exited ` + "$sampleExit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    standardOut.ToString() + standardError.ToString()
                )
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
