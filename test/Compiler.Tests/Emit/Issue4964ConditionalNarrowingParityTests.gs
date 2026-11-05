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
    @InlineData("return !string.IsNullOrEmpty(g) ? ClearInt() + g.Length : 0")
    @InlineData("return if !string.IsNullOrEmpty(g) { ClearInt() + g.Length } else { 0 }")
    @InlineData("return string.IsNullOrEmpty(g) ? 0 : ClearInt() + g.Length")
    @InlineData("return if string.IsNullOrEmpty(g) { 0 } else { ClearInt() + g.Length }")
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

    @Fact
    func ValueType_Nullable_Reassignment_In_ShortCircuit_Rhs_And_MaybeNullWhen_On_ValueTypes_Behave_Soundly() {
        let reassignedRhs = `package Issue4969.ValueTypeRhsReassign
func TakesInt(x int32) bool -> x > 0
func Check(ref n int32?) bool -> n != nil && ((n = nil) == nil && TakesInt(n))
`
        Assert.Equal("GS0154:n", DiagnoseSource(reassignedRhs))

        let valueTypeMaybeNull = `package Issue4969.ValueTypeMaybeNull
import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis

struct Pair {
    let X int32
    init(x int32) { X = x }
}

func TryGetSourceInt(@MaybeNullWhen(false) out value int32) bool {
    value = 0
    return false
}

func CheckRhsLifted(n int32?) bool {
    var local = n
    return local != nil && ((local = nil) == nil && local > 0)
}

func CheckRhsOrLifted(n int32?) bool {
    var local = n
    return local == nil || ((local = nil) != nil || local > 0)
}

func CheckDict(dict Dictionary[string, int32]) int32 {
    var value = 0
    let a = dict.TryGetValue("missing", out value) ? 1 : value
    let b = if dict.TryGetValue("missing", out value) { 1 } else { value }
    let c = TryGetSourceInt(out value) ? 1 : value
    return a + b + c
}

func CheckStructDict(dict Dictionary[string, Pair]) int32 {
    var pair = Pair(7)
    let p Pair = dict.TryGetValue("missing", out pair) ? Pair(1) : pair
    return p.X
}

let dict = Dictionary[string, int32]()
let structDict = Dictionary[string, Pair]()
Console.WriteLine(CheckRhsLifted(5))
Console.WriteLine(CheckRhsOrLifted(5))
Console.WriteLine(CheckDict(dict))
Console.WriteLine(CheckStructDict(structDict))
`
        let (output, _) = CompileAndRun(valueTypeMaybeNull)
        Assert.Equal(`False
False
0
0`, output.Replace("\r\n", "\n").TrimEnd('\n'))
    }

    @Fact
    func Callable_Reassignment_Callback_Writes_And_Nested_Statement_Or_Switch_Branches_Respect_Narrowing() {
        let callableReassignment = `package Issue4969.CallableReassign
import System
import System.Diagnostics.CodeAnalysis

func Has(@NotNullWhen(true) value string?, a () -> bool, b bool) bool -> value != nil

func CheckConditionAnd(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return ((action = reset) is {} a && !string.IsNullOrEmpty(s) && action()) ? s.Length : 0
}

func CheckConditionOr(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return false
    }
    return ((action = reset) is not {} a || string.IsNullOrEmpty(s) || action()) ? 0 : s.Length
}

@SuppressDiagnostic("GS0524")
func CheckSubsequentArguments(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return Has(s, (action = reset), action()) ? s.Length : 0
}

func CheckLateExternalAssignmentInNestedArm(external () -> bool, seed string?, n int32?) int32 {
    var s = seed
    var action = () -> {
        s = nil
        return true
    }
    return n != nil ? ((!string.IsNullOrEmpty(s) && action() && ((action = external) is {} a)) ? s.Length : 0) : 0
}

func CheckNestedIfBranchAliasRestore(external () -> bool, seed string?, flag bool) int32 {
    var s = seed
    var action = () -> {
        s = nil
        return true
    }
    return if s != nil {
        if flag {
            action = external
            0
        } else {
            let n = action() ? s.Length : 0
            n
        }
    } else {
        0
    }
}

func CheckNilFrameAliasPropagation(external () -> bool, seed string?) bool {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return ((action = reset) is {} a) && (!string.IsNullOrEmpty(s) && action() && s.Length > 0)
}

func Consume(a () -> bool, b () -> int32, c int32) int32 -> b() + c

@SuppressDiagnostic("GS0524")
func CheckLambdaArgAfterCallableReassignment(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return s != nil ? Consume(action = reset, () -> 0, action() ? s.Length : 0) : 0
}

@SuppressDiagnostic("GS0524")
func CheckBlockTupleAfterCallableReassignment(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return s != nil ? (action = reset, {
        let _ = 0
        0
    }, action() ? s.Length : 0).Item3 : 0
}

@SuppressDiagnostic("GS0524")
func CheckTupleAssignmentOrderNoReplay(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    var reset = () -> {
        s = nil
        return true
    }
    return s != nil ? ((action = reset, reset = external), action() ? s.Length : 0).Item2 : 0
}

func CheckBlockValuedConditionPrefixAliases(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return {
        action = reset
        Has(s, external, action())
    } ? s.Length : 0
}

func CheckBlockValuedConditionPrefixAliasesOutwardAnd(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return ({
        action = reset
        !string.IsNullOrEmpty(s)
    } && action()) ? s.Length : 0
}

@SuppressDiagnostic("GS0524")
func CheckSiblingBeforeNarrowingFrame(external () -> bool, seed string?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return (action = reset, (!string.IsNullOrEmpty(s) && action()) ? s.Length : 0).Item2
}

func CheckIfLetExitEffectsInNarrowedArm(ref s string?, n int32?) int32 ->
    s != nil ? (if let x = n { (s = nil) == nil ? 0 : 0 } else { 0 }) + s.Length : 0

func CheckSwitchExitEffectsInNarrowedArm(ref s string?, flag bool) int32 ->
    s != nil ? (switch flag { case true: (s = nil) == nil ? 0 : 0 default: 0 }) + s.Length : 0

func CheckSwitchDefaultFirstExitEffectsInNarrowedArm(ref s string?, flag bool) int32 ->
    s != nil ? (switch flag { default: (s = nil) == nil ? 0 : 0 case true: 0 }) + s.Length : 0

class OptBox {
    func Use(fn () -> bool) int32 -> 1
}

@SuppressDiagnostic("GS0524")
func CheckIfLetThreeBindingsMiddleInitializerAliasExit(external () -> bool, seed string?, a int32?, b int32?, c int32?) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return s != nil ? (if let x = a, let y = ((action = reset) is {} _ ? b : nil), let z = ((action = external) is {} _ ? c : nil) {
        0
    } else {
        action() ? s.Length : 0
    }) : 0
}

@SuppressDiagnostic("GS0524")
func CheckNullConditionalArgumentAliasJoin(external () -> bool, seed string?, box OptBox?) int32 {
    var s = seed
    var action = () -> {
        s = nil
        return true
    }
    return (box?.Use(action = external), (!string.IsNullOrEmpty(s) && action()) ? s.Length : 0).Item2
}

func CheckCalleeProvenanceBeforeArgumentReassignment(external (bool) -> bool, seed string?) int32 {
    var s = seed
    var action = (flag bool) -> {
        s = nil
        return flag
    }
    return s != nil ? (action((action = external) is {} a) ? 1 : 0) + s.Length : 0
}

func CheckDelegateInvokeProvenanceBeforeArgumentReassignment(external Func[bool, bool], seed string?) int32 {
    var s = seed
    var action Func[bool, bool] = (flag bool) -> {
        s = nil
        return flag
    }
    return s != nil ? (action.Invoke((action = external) is {} a), s.Length).Item2 : 0
}

@SuppressDiagnostic("GS0524")
func CheckNonFinalDefaultArmCallableAliasExit(external () -> bool, seed string?, flag bool) int32 {
    var s = seed
    var action = external
    let reset = () -> {
        s = nil
        return true
    }
    return s != nil ? ((switch flag {
        default: (action = reset) is {} _ ? 0 : 0
        case true: 0
    }), action() ? s.Length : 0).Item2 : 0
}
`
        Assert.Equal(
            "GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length;GS0158:Length",
            DiagnoseSource(callableReassignment)
        )

        let nestedIfAndSwitch = `package Issue4969.NestedIfAndSwitch
import System.Diagnostics.CodeAnalysis

var gOut string? = nil

func TryGetWithRefCount(@NotNullWhen(true) out text string?, ref count int32) bool {
    count += 1
    text = "ok"
    return true
}

func OutGlobalWithUnrelatedRefCount(ref count int32) int32 ->
    TryGetWithRefCount(out gOut, ref count) ? gOut.Length : 0

func NestedIfInIfExpr(ref s string?, flag bool) int32 -> if s != nil {
    if flag {
        s = nil
        0
    } else {
        let n = s.Length
        n
    }
} else {
    0
}

func SwitchExprInTernary(ref s string?, flag bool) int32 -> s != nil ? switch flag {
    case true: (s = nil) == nil ? 0 : 0
    default: s.Length
} : 0
`
        Assert.Equal("", DiagnoseSource(nestedIfAndSwitch))

        let outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4964ConditionalNarrowingParityTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(outputDirectory)
        try {
            let helperSourcePath = Path.Combine(outputDirectory, "CallbackHelper.gs")
            let helperPath = Path.Combine(outputDirectory, "CallbackHelper.dll")
            File.WriteAllText(helperSourcePath, `package Issue4969.CallbackLib
import System
import System.Diagnostics.CodeAnalysis

public struct Token {
    public func operator implicit(t Token) float64 -> 0.0
}

public shared class CallbackPredicates {
    public func Has(@NotNullWhen(true) value string?, callback Action) bool {
        callback()
        return value != nil
    }
}
`)

            let consumerPath = Path.Combine(outputDirectory, "Consumer.gs")
            let consumerOut = Path.Combine(outputDirectory, "Consumer.dll")
            File.WriteAllText(consumerPath, `package Issue4969.CallbackConsumer
import Issue4969.CallbackLib
var g string? = "seed"
func Consume(x float64, n int32) int32 -> n
func Consume3(x float64, n int32, extra int32) int32 -> n + extra
func ConsumeOverloaded(x Token, n int32) int32 -> n
func ConsumeOverloaded(x float64, b bool) int32 -> b ? 1 : 0
func CheckOverloadProbeDoesNotInvalidate(token Token) int32 ->
    !string.IsNullOrEmpty(g) ? ConsumeOverloaded(token, g.Length) : 0
func CheckReboundCallArgDropsRedundantAssertionWarning(token Token) int32 ->
    !string.IsNullOrEmpty(g) ? Consume(token, g!!.Length) : 0
func CheckReboundTupleElementDropsRedundantAssertionWarning(token Token) int32 {
    let pair (float64, int32) = !string.IsNullOrEmpty(g) ? (token, g!!.Length) : (0.0, 0)
    return pair.Item2
}
func Check() int32 -> CallbackPredicates.Has(g, () -> { g = nil }) ? g.Length : 0
func CheckCondArmConv(flag bool, token Token) float64 ->
    !string.IsNullOrEmpty(g) ? (flag ? token : 0.0) + float64(g.Length) : 0.0
func CheckSwitchArmConv(flag bool, token Token) float64 ->
    !string.IsNullOrEmpty(g) ? (switch flag { case false: 0.0 default: token }) + float64(g.Length) : 0.0
func CheckIfLetExplicitTypeConv(token Token?) int32 ->
    !string.IsNullOrEmpty(g) ? (if let x float64 = token { g.Length } else { 0 }) : 0
func CheckIfLetExplicitTypeConvElse(token Token?) int32 ->
    !string.IsNullOrEmpty(g) ? (if let x float64 = token { 0 } else { g.Length }) : 0
func CheckCallArgImplicitConv(token Token) int32 ->
    !string.IsNullOrEmpty(g) ? Consume(token, g.Length) : 0
func CheckCallArgImplicitConvWithLaterTernaryArg(token Token, flag bool) int32 ->
    !string.IsNullOrEmpty(g) ? Consume3(token, g.Length, flag ? 1 : 2) : 0
func CheckTargetTypedTupleElementConv(token Token) int32 {
    let pair (float64, int32) = !string.IsNullOrEmpty(g) ? (token, g.Length) : (0.0, 0)
    return pair.Item2
}
func CheckDirectTargetTypedTupleConv(token Token) int32 ->
    !string.IsNullOrEmpty(g) ? {
        let pair (float64, int32) = (token, g.Length)
        pair.Item2
    } : 0
func CheckFalseArmPatternIsolation(o object, token Token) float64 {
    let v = g != nil ? (!(o is string text) ? token : float64(text.Length)) : 0.0
    return v
}
`)
            using let standardOut = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOut)
            Console.SetError(standardError)
            var helperExit int32
            var exitCode int32
            try {
                helperExit = Program.Main(
                    []string{"/out:" + helperPath, "/target:library", "/targetframework:net10.0", helperSourcePath}
                )
                exitCode = Program.Main(
                    []string{
                        "/out:" + consumerOut,
                        "/target:library",
                        "/targetframework:net10.0",
                        "/reference:" + helperPath,
                        consumerPath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.Equal(0, helperExit)
            Assert.NotEqual(0, exitCode)
            let consumerDiagnostics = standardOut.ToString() + standardError.ToString()
            Assert.Equal(9, consumerDiagnostics.Split("GS0158").Length - 1)
            Assert.DoesNotContain("GS0536", consumerDiagnostics)
            Assert.DoesNotContain("GS0130", consumerDiagnostics)
        } finally {
            if Directory.Exists(outputDirectory) {
                Directory.Delete(outputDirectory, recursive: true)
            }
        }

        let identityArgRebindRun = CompileAndRun(`import System
var n int32? = 5
struct Token {
    shared {
        func operator implicit(t Token) float64 {
            n = nil
            return 0.0
        }
    }
}
func Consume(x float64, b bool) bool -> b
func ConsumeThree(x float64, b bool, tail int32?) bool -> b
func ConsumeNamed(b bool, x float64) bool -> b
func ConsumeVariadic(x float64, values ...bool) bool -> values[0]
delegate VariadicDelegate(x float64, values ...bool) bool;
struct VariadicSink {
    func Use(x float64, values ...bool) bool -> values[0]
}
struct Reader {
    func Read(x int32, out r int32) bool {
        r = x
        return true
    }
    func Read(x int32?, out r string) bool {
        r = "null"
        return false
    }
}
func TryRead(out r int32) bool {
    r = 42
    return true
}
func ConsumeOverload(x float64, v int32) bool -> true
func ConsumeOverload(x float64, v int32?) bool -> v != nil
func Id[T](x float64, v T) T -> v
func OuterOverload(v int32) bool -> true
func OuterOverload(v int32?) bool -> v != nil
let token = Token{}
let sink = VariadicSink{}
let reader = Reader{}
let o object = "hi"
let del VariadicDelegate = (x float64, values ...bool) -> values[0]
Console.WriteLine(n != nil ? Consume(token, n > 0) : false)
n = 5
Console.WriteLine(n != nil ? ConsumeThree(token, n > 0, (n = nil)) : false)
n = 5
let tupleTarget (float64, bool, int32?) = if n != nil { (token, n > 0, (n = nil)) } else { (0.0, false, nil) }
Console.WriteLine(tupleTarget.Item2)
n = 5
Console.WriteLine(n != nil ? ConsumeNamed(x: token, b: n > 0) : false)
n = 5
Console.WriteLine(n != nil ? ConsumeVariadic(token, n > 0) : false)
n = 5
Console.WriteLine(n != nil ? sink.Use(token, n > 0) : false)
n = 5
Console.WriteLine(n != nil ? del(token, n > 0) : false)
n = 5
Console.WriteLine(n != nil ? Consume(token, reader.Read(n, out var rCall)) : false)
n = 5
let tupleOutOverload (float64, bool) = if n != nil { (token, reader.Read(n, out var rTup)) } else { (0.0, false) }
Console.WriteLine(tupleOutOverload.Item2)
n = 5
Console.WriteLine(n != nil ? Consume(token, o is string p1 && TryRead(out var resCall) && p1.Length + resCall == 44) : false)
n = 5
let tuplePatternOut (float64, bool) = if n != nil { (token, o is string p2 && TryRead(out var resTup) && p2.Length + resTup == 44) } else { (0.0, false) }
Console.WriteLine(tuplePatternOut.Item2)
n = 5
Console.WriteLine(!(n == nil) ? ConsumeOverload(token, n) : false)
n = 5
Console.WriteLine(!(n == nil) ? OuterOverload(Id(token, n)) : false)
`)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "False",
                "False",
                "False",
                "False",
                "False",
                "False",
                "False",
                "False",
                "False",
                "True",
                "True",
                "False",
                "False"
            ) +
                Environment.NewLine,
            identityArgRebindRun.Output
        )
        Assert.DoesNotContain("GS0536", identityArgRebindRun.CompilerOutput)

        let throwingArmAndCtorFieldWriteDiag = DiagnoseSource(`package Issue4969.ThrowingArmAndCtorFieldWrite
import System
func CheckThrowingConditionalArms(ref s string?, n int32?, flag bool) int32 {
    let a = s != nil ? (flag ? 0 : {
        s = nil
        throw Exception()
    }) + s.Length : 0
    let b = s != nil ? (if flag {
        0
    } else {
        s = nil
        throw Exception()
    }) + s.Length : 0
    let c = s != nil ? (if let x = n {
        x
    } else {
        s = nil
        throw Exception()
    }) + s.Length : 0
    let d = s != nil ? (switch flag {
        case true: 0
        default: {
            s = nil
            throw Exception()
        }
    }) + s.Length : 0
    return a + b + c + d
}
class CtorHolder {
    let n int32?
    init(seed int32?) {
        this.n = seed
        let _ int32 = (this.n != nil && (this.n = nil) == nil) ? this.n : 0
    }
}
func CheckIfLetEmptyAliasesNotCorrupted(external () -> bool, seed string?, n int32?) int32 {
    var s = seed
    let reset = () -> {
        s = nil
        return true
    }
    let first = if let x = n {
        var action = external
        action() ? x : 0
    } else {
        0
    }
    return first + (s != nil ? (reset() ? s.Length : 0) : 0)
}
`)
        Assert.Equal("GS0156:this.n;GS0158:Length", throwingArmAndCtorFieldWriteDiag)

        let deferredCoalesceAndSwitchDiag = DiagnoseSource(`package Issue4969.DeferredBranchyRetry
interface I {}
class A : I {}
class B : I {}
func TakeI(v I) int32 -> 1
func TakeObj(v object) int32 -> 1
func CheckCoalesce(ref s string?, a A?) int32 -> s != nil ? TakeI((s.Length, a).Item2 ?? (s = nil, B{}).Item2) : 0
func CheckSwitch(ref s string?, flag bool) int32 -> s != nil ? TakeObj(switch flag { case true: (s.Length, A{}).Item2 default: (s = nil, B{}).Item2 }) : 0
`)
        Assert.Equal("", deferredCoalesceAndSwitchDiag)

        let voidSwitchUnnamedEnumDiag = DiagnoseSource(`package Issue4969.VoidSwitchUnnamedEnum
import System.Collections.Generic
enum E { One = 1, Two = 2 }
func VoidOp() {}
func Check(dict Dictionary[string, string], e E) int32 {
    var value = "seed"
    return dict.TryGetValue("missing", out value) ? 0 : ({
        switch e {
            case E.One: {
                value = "a"
                VoidOp()
            }
            case E.Two: {
                value = "b"
                VoidOp()
            }
        }
        value.Length
    })
}
`)
        Assert.Equal("GS0158:Length", voidSwitchUnnamedEnumDiag)

        let voidSwitchWithDefaultDischargesDiag = DiagnoseSource(`package Issue4969.VoidSwitchWithDefault
import System.Collections.Generic
enum E { One = 1, Two = 2 }
func VoidOp() {}
func Check(dict Dictionary[string, string], e E) int32 {
    var value = "seed"
    return dict.TryGetValue("missing", out value) ? 0 : ({
        switch e {
            case E.One: {
                value = "a"
                VoidOp()
            }
            default: {
                value = "b"
                VoidOp()
            }
        }
        value.Length
    })
}
`)
        Assert.Equal("", voidSwitchWithDefaultDischargesDiag)

        let constrainedComparerDiag = DiagnoseSource(`package Issue4969.ConstrainedComparerRebind
import System.Collections.Generic
var n int32? = 5
struct Token {
    shared {
        func operator implicit(t Token) int32 {
            n = nil
            return 0
        }
    }
}
func Check[T IComparer[int32]](comparer T, token Token) int32 -> !(n == nil) ? comparer.Compare(token, n) : 0
`)
        Assert.Contains("GS0156:n", constrainedComparerDiag)
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
    @InlineData(
        "return (dict.TryGetValue(\"a\", out value) || (flag || dict.TryGetValue(\"b\", out value))) ? value.Length : 0",
        "GS0158:Length"
    )
    @InlineData(
        "return (!dict.TryGetValue(\"a\", out value) && (flag && !dict.TryGetValue(\"b\", out value))) ? 0 : value.Length",
        "GS0158:Length"
    )
    @InlineData(
        "return (dict.TryGetValue(\"a\", out value) || (dict.TryGetValue(\"b\", out value) || dict.TryGetValue(\"c\", out value))) ? value.Length : 0",
        ""
    )
    @InlineData(
        "return (!dict.TryGetValue(\"a\", out value) && (!dict.TryGetValue(\"b\", out value) && !dict.TryGetValue(\"c\", out value))) ? 0 : value.Length",
        ""
    )
    @InlineData("return dict.TryGetValue(\"missing\", out value) ? 0 : (value = \"ok\", value.Length).Item2", "")
    @InlineData(
        "return dict.TryGetValue(\"missing\", out value) ? 0 : (dict.TryGetValue(\"other\", out value), value.Length).Item2",
        "GS0158:Length"
    )
    @InlineData(
        "return dict.TryGetValue(\"missing\", out value) ? 0 : (flag ? \"no\" : (value = \"ok\"), value.Length).Item2",
        "GS0158:Length"
    )
    @InlineData(
        "return (!dict.TryGetValue(\"missing\", out value) && ((value = \"ok\") == \"ok\")) ? value.Length : 0",
        ""
    )
    @InlineData(
        "return (!dict.TryGetValue(\"missing\", out value) && ((value = \"ok\") == \"ok\")) ? 0 : value.Length",
        ""
    )
    @InlineData(
        "return (dict.TryGetValue(\"missing\", out value) || ((value = \"ok\") == \"ok\")) ? value.Length : 0",
        ""
    )
    @InlineData(
        "return (dict.TryGetValue(\"missing\", out value) || ((value = \"ok\") == \"ok\")) ? 0 : value.Length",
        ""
    )
    @InlineData(
        "return (!dict.TryGetValue(\"missing\", out value) && { value = \"ok\"\n true }) ? value.Length : 0",
        ""
    )
    @InlineData("return (dict.TryGetValue(\"missing\", out value) || { value = \"ok\"\n true }) ? value.Length : 0", "")
    @InlineData("return (!dict.TryGetValue(\"missing\", out value) && ((value = \"ok\") is {})) ? value.Length : 0", "")
    @InlineData("return (dict.TryGetValue(\"missing\", out value) || ((value = \"ok\") is {})) ? value.Length : 0", "")
    @InlineData(
        "return dict.TryGetValue(\"missing\", out value) ? 0 : (switch flag { case true: (value = \"a\", 1).Item2 default: (value = \"b\", 2).Item2 }) + value.Length",
        ""
    )
    @InlineData("return dict.TryGetValue(\"missing\", out value) ? 0 : (Reset(out value), value.Length).Item2", "")
    @InlineData("if !dict.TryGetValue(\"missing\", out value) { Reset(out value) }\n return value.Length", "")
    @InlineData("return (!dict.TryGetValue(\"missing\", out value) && ResetBool(out value)) ? value.Length : 0", "")
    func Composed_MaybeNullWhen_Preserves_Widening_Across_And_And_Or(body string, expected string) {
        let source = (`package Issue4969.ComposedMaybeNull
import System.Collections.Generic
func Reset(out v string) int32 {
    v = "ok"
    return 1
}
func ResetBool(out v string) bool {
    v = "ok"
    return true
}
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

    /// Issue #4974: in an expression-tree lambda a narrowed value-type nullable
    /// read lowers its synthesized unwrap to `Expression.Convert` in both
    /// conditional forms, while an explicit user `!!` on a nullable value type
    /// remains rejected with GS0473.
    @Theory
    @InlineData("v != nil ? v + 1 : 0")
    @InlineData("if v != nil { v + 1 } else { 0 }")
    @InlineData("!(v == nil) ? v + 1 : 0")
    @InlineData("if !(v == nil) { v + 1 } else { 0 }")
    func Expression_Tree_Narrowed_Value_Type_Read_Compiles_And_Runs_In_Both_Forms(conditional string) {
        let result = CompileAndRun(`import System
import System.Linq.Expressions
let e Expression[Func[int32?, int32]] = (v int32?) -> ` + conditional + `
let fn = e.Compile()
Console.WriteLine("${fn(4)} ${fn(nil)}")
`)
        Assert.Equal("5 0" + Environment.NewLine, result.Output)
    }

    /// Issue #4974: type-test and value-type-nullable narrowed reads inside
    /// expression-tree lambdas lower to `Expression.Convert` across parameters,
    /// captured locals, and stable field/property member paths,
    /// while explicit user `!!` on a value-type nullable still reports GS0473.
    @Fact
    func Issue4974_Expression_Tree_Narrowed_Reads_Lower_To_Convert_And_Evaluate() {
        let result = CompileAndRun(`import System
import System.Linq.Expressions

open class Animal {
    let Tag int32 = 1
}

class Dog : Animal {
    let BarkLen int32 = 4
    func Bark() int32 -> this.BarkLen + this.Tag
}

struct Point {
    var X int32
    var Y int32
}

enum Color { Red, Green }

class Holder {
    let Pet Animal = Dog()
    prop CurrentPet Animal { get; init; }
    let Count int32? = 7
    prop MaybeCount int32? { get; init; }
    init() {
        this.CurrentPet = Dog()
        this.MaybeCount = 7
    }
}

func runCaptured(capturedObj object, capturedInt int32?) int32 {
    let capTree Expression[Func[int32]] = () -> ((capturedObj is string) ? capturedObj.Length : 0) + (capturedInt != nil ? capturedInt : 0)
    return capTree.Compile()()
}

let ifType Expression[Func[object, int32]] = (value object) -> if value is string { value.Length } else { 0 }
let terType Expression[Func[object, int32]] = (value object) -> (value is string) ? value.Length : 0
let andType Expression[Func[object, bool]] = (value object) -> value is string && value.Length > 1
let orType Expression[Func[object, bool]] = (value object) -> !(value is string) || value.Length > 1
let unboxInt Expression[Func[object, int32]] = (value object) -> (value is int32) ? value + 10 : -1
let derivedClass Expression[Func[Animal, int32]] = (a Animal) -> (a is Dog) ? a.Bark() : 0
let fieldPath Expression[Func[Holder, int32]] = (h Holder) -> (h.Pet is Dog) ? h.Pet.Bark() : -1
let propPath Expression[Func[Holder, int32]] = (h Holder) -> if h.CurrentPet is Dog { h.CurrentPet.Bark() } else { -1 }

let valIf Expression[Func[int32?, int32]] = (v int32?) -> if v != nil { v + 1 } else { 0 }
let valTer Expression[Func[int32?, int32]] = (v int32?) -> v != nil ? v + 1 : 0
let valElse Expression[Func[int32?, int32]] = (v int32?) -> v == nil ? -1 : v * 2
let valStruct Expression[Func[Point?, int32]] = (p Point?) -> p != nil ? p.X + p.Y : -1
let valEnum Expression[Func[Color?, string]] = (c Color?) -> c == nil ? "none" : c.ToString()
let valFieldPath Expression[Func[Holder, int32]] = (h Holder) -> h.Count != nil ? h.Count + 1 : 0
let valPropPath Expression[Func[Holder, int32]] = (h Holder) -> if h.MaybeCount != nil { h.MaybeCount + 2 } else { 0 }

Console.WriteLine("${ifType.Compile()("abc")} ${ifType.Compile()(1)} ${terType.Compile()("abcd")} ${terType.Compile()(1)}")
Console.WriteLine("${andType.Compile()("ab")} ${andType.Compile()("a")} ${andType.Compile()(1)} ${orType.Compile()(1)} ${orType.Compile()("a")} ${orType.Compile()("ab")}")
Console.WriteLine("${unboxInt.Compile()(5)} ${unboxInt.Compile()("x")} ${derivedClass.Compile()(Dog())} ${derivedClass.Compile()(Animal())}")
Console.WriteLine("${fieldPath.Compile()(Holder())} ${propPath.Compile()(Holder())}")
Console.WriteLine("${valIf.Compile()(4)} ${valIf.Compile()(nil)} ${valTer.Compile()(4)} ${valTer.Compile()(nil)} ${valElse.Compile()(4)} ${valElse.Compile()(nil)}")
Console.WriteLine("${valStruct.Compile()(Point{X: 2, Y: 5})} ${valStruct.Compile()(nil)} ${valEnum.Compile()(Color.Green)} ${valEnum.Compile()(nil)}")
Console.WriteLine("${valFieldPath.Compile()(Holder())} ${valPropPath.Compile()(Holder())} ${runCaptured("captured", 9)} ${runCaptured(42, nil)}")
`)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "3 0 4 0",
                "True False False True False True",
                "15 -1 5 0",
                "5 5",
                "5 0 5 0 8 -1",
                "7 -1 Green none",
                "8 9 17 0"
            ) +
                Environment.NewLine,
            result.Output
        )

        let explicitUserBangBang = `package Issue4974.ExplicitAssertion
import System
import System.Linq.Expressions
func f() int32 {
    let e Expression[Func[int32?, int32]] = (v int32?) -> v!! + 1
    return e.Compile()(1)
}
`
        Assert.Equal("GS0473:v!!", DiagnoseSource(explicitUserBangBang))
    }

    @Fact
    func Left_Associated_Arithmetic_Chain_In_Narrowed_Arm_Scales_Linearly() {
        let buildChainSource = func (terms int32) string {
            let chain = string.Join(" + ", Enumerable.Repeat("F()", terms))
            var nested = "1"
            let nestedDepth = terms / 2
            for var i = 0; i < nestedDepth; i++ {
                nested = "flag ? (" + nested + ") : 0"
            }
            return (`package Issue4969.ChainScaling
func F() int32 -> 1
func Compute(s string?, n int32?) int32 -> s != nil ? (n != nil ? (` + chain + ` + s.Length + n) : 0) : 0
func NestedConditionals(flag bool) int32 -> ` + nested + `
`)
        }
        // Warm up compilation pipeline.
        Assert.Equal("", DiagnoseSource(buildChainSource(16)))
        let swSmall = Stopwatch.StartNew()
        Assert.Equal("", DiagnoseSource(buildChainSource(32)))
        swSmall.Stop()
        let swLarge = Stopwatch.StartNew()
        Assert.Equal("", DiagnoseSource(buildChainSource(128)))
        swLarge.Stop()
        Assert.True(swLarge.ElapsedMilliseconds < 10_000, "128-term chain took ${swLarge.ElapsedMilliseconds}ms")
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
