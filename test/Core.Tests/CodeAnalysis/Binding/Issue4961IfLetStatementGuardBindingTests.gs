// <copyright file="Issue4961IfLetStatementGuardBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #4961 / ADR-0201 — binder coverage for the aligned `if let`
/// statement and expression: the guard sees the bound names, the bound names
/// are visible in later initializers, the guard and the then-region only, and
/// each unsupported compound form names its syntax instead of reporting
/// GS0157 on the bound name. Diagnostics are compared as exact
/// `ID@line:column` lists.
open class Issue4961IfLetStatementGuardBindingTests {
    @Fact
    func IssueRepro_BindsWithoutDiagnostics() {
        let result = EmittedOracle.Evaluate(`func HasText(value string?) bool {
    if let text = value && text.Length > 0 {
        return true
    }
    return false
}
HasText("x")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func Statement_BoundName_IsNotVisibleInElse_OrAfterTheStatement() {
        let result = EmittedOracle.Evaluate(`func Use(s string) int32 { return s.Length }
func Run(s string?) int32 {
    if let v = s && v.Length > 0 {
        return Use(v)
    } else {
        return Use(v)
    }
}
func After(s string?) int32 {
    if let w = s && w.Length > 0 {
        Use(w)
    }
    return Use(w)
}
Run("x")`)
        Assert.Equal([]string{"GS0125@6:20", "GS0125@13:16"}, Ids(result))
    }

    @Fact
    func Expression_BoundName_IsNotVisibleInElse() {
        let result = EmittedOracle.Evaluate(`func Use(s string) int32 { return s.Length }
func Run(s string?) int32 {
    return if let v = s && v.Length > 0 { Use(v) } else { Use(v) }
}
Run("x")`)
        Assert.Equal([]string{"GS0125@3:63"}, Ids(result))
    }

    @Fact
    func BothForms_LaterInitializer_SeesEarlierBindingNarrowed() {
        let result = EmittedOracle.Evaluate(`func Len(s string) int32? { return s.Length }
func Statement(s string?) int32 {
    if let a = s, let n = Len(a) && n > a.Length - 1 {
        return n
    }
    return 0
}
func Expression(s string?) int32 {
    return if let a = s, let n = Len(a) && n > a.Length - 1 { n } else { 0 }
}
Statement("abc") + Expression("ab")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BothForms_NonNullableLaterInitializer_IsGS0296() {
        // ADR-0201: every binding strips one nullable layer, in both forms, so
        // a later initializer that is already non-nullable stays GS0296.
        let result = EmittedOracle.Evaluate(`func Run(s string?) string {
    if let t = s, let u = t.ToUpper() {
        return u
    }
    return if let t = s, let u = t.ToUpper() { u } else { "" }
}
Run("x")`)
        Assert.Equal([]string{"GS0296@2:27", "GS0296@5:34"}, Ids(result))
    }

    @Fact
    func Statement_NonBooleanGuard_IsGS0155_AtTheGuard() {
        let result = EmittedOracle.Evaluate(`func Run(s string?) int32 {
    if let v = s && v.Length {
        return 1
    }
    return 0
}
Run("x")`)
        Assert.Equal([]string{"GS0155@2:21"}, Ids(result))
    }

    @Fact
    func Compatibility_LogicalAndConditionalInitializer_ReportsGS0624() {
        // Before ADR-0201 the statement form parsed `a && b ? x : y` as one
        // initializer. The `&&` now starts the guard, which leaves a `bool`
        // initializer: GS0624 says to parenthesize instead of GS0296, and
        // nothing reports GS0157 on the bound name.
        let result = EmittedOracle.Evaluate(`func Run(a bool, b bool, x string?, y string?) string {
    if let v = a && b ? x : y {
        return v
    }
    return if let w = a && b ? x : y { w } else { "" }
}
Run(true, true, "x", "y")`)
        let ids = Ids(result)
        Assert.Equal(
            []string{"GS0624@2:16", "GS0624@5:23"},
            ids.Where((id string) -> id.StartsWith("GS0624")).ToArray()
        )
        Assert.DoesNotContain(ids, (id string) -> id.StartsWith("GS0157") || id.StartsWith("GS0296"))
    }

    @Fact
    func Compatibility_NullableAssignmentBeforeGuard_ReportsGS0624() {
        let result = EmittedOracle.Evaluate(`func Run(a bool, b bool) bool {
    var cached bool? = nil
    if let v = cached = a && b { return v }
    return if let w = cached = a && b { w } else { false }
}
func Conditional(flag bool, fallback bool?, b bool) bool {
    if let v = flag ? fallback : false && b { return v }
    return false
}
func Compound(a bool, b bool) {
    var cached bool? = true
    if let v = cached &= a && b { }
}
Run(true, false)`)
        Assert.Equal([]string{"GS0624@3:16", "GS0624@4:23", "GS0624@7:16", "GS0624@12:16"}, Ids(result))
    }

    @Fact
    func Compatibility_NullableIndexerAssignmentBeforeGuard_ReportsGS0624() {
        let result = EmittedOracle.Evaluate(`class Box {
    var stored bool? = true
    prop this[index int32] bool? {
        get -> stored
        set { stored = value }
    }
    func Run(a bool, b bool) bool {
        if let v = this[0] = a && b { return v }
        return if let w = this[0] = a && b { w } else { false }
    }
}
Box().Run(true, false)`)
        Assert.Equal([]string{"GS0624@8:20", "GS0624@9:27"}, Ids(result))
    }

    @Fact
    func Compatibility_NullableBasePropertyCompoundBeforeGuard_ReportsGS0624() {
        let result = EmittedOracle.Evaluate(`open class Base {
    protected prop P bool? { get; set; }
}
class Derived : Base {
    func Run(a bool, b bool) bool {
        base.P = true
        if let v = base.P &= a && b { return v }
        return if let w = base.P &= a && b { w } else { false }
    }
}
Derived().Run(true, false)`)
        Assert.Equal([]string{"GS0624@7:20", "GS0624@8:27"}, Ids(result))
    }

    @Theory
    @InlineData("cast[bool?](false)")
    @InlineData("default(bool?)")
    func ExplicitNullableValueBeforeGuard_IsNotAnAmbiguousBooleanContinuation(initializer string) {
        let result = EmittedOracle.Evaluate(`func Run(b bool) bool {
    var cached bool? = nil
    if let v = cached = VALUE && b { }
    return if let w = cached = VALUE && b { w } else { false }
}
Run(false)`.Replace("VALUE", initializer))
        Assert.Empty(result.Diagnostics)
    }

    @Theory
    @InlineData("if flag { a } else { false }")
    @InlineData("if let other = cached { a } else { false }")
    @InlineData("{ a }")
    func Compatibility_TargetTypedBooleanValueBeforeGuard_ReportsGS0624(initializer string) {
        let result = EmittedOracle.Evaluate(`func Run(flag bool, a bool, b bool) bool {
    var cached bool? = nil
    if let v = cached = INITIALIZER && b { return v }
    return if let w = cached = INITIALIZER && b { w } else { false }
}
Run(true, true, false)`.Replace("INITIALIZER", initializer))
        Assert.Equal([]string{"GS0624@3:16", "GS0624@4:23"}, Ids(result))
    }

    @Theory
    @InlineData("if flag { fallback } else { false }")
    @InlineData("if let other = fallback { fallback } else { false }")
    @InlineData("cached = (flag ? fallback : false)")
    @InlineData("flag ? fallback : (cached = false)")
    func ClosedNestedInitializerBeforeGuard_IsNotAnAmbiguousContinuation(initializer string) {
        let source = `func Run(flag bool, fallback bool?, ok bool) bool {
    var cached bool? = nil
    if let v = INITIALIZER && ok { }
    return if let w = INITIALIZER && ok { w } else { false }
}
Run(false, nil, true)`.Replace("INITIALIZER", initializer)
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func Compatibility_TargetTypedSwitchBeforeGuard_ChecksEveryResultArm() {
        const source = `func Run(n int32, fallback bool?, b bool) bool {
    var cached bool? = nil
    if let v = cached = switch n { case 0: ARM default: false } && b { return v }
    return if let w = cached = switch n { case 0: ARM default: false } && b { w } else { false }
}
Run(0, true, false)`
        let nullable = EmittedOracle.Evaluate(source.Replace("ARM", "fallback"))
        Assert.Empty(nullable.Diagnostics)
        Assert.Equal(false, nullable.Value)
        let boolean = EmittedOracle.Evaluate(source.Replace("ARM", "true"))
        Assert.Equal([]string{"GS0624@3:16", "GS0624@4:23"}, Ids(boolean))
    }

    @Theory
    @InlineData("left ?? ARM")
    @InlineData("(left ?? ARM)")
    @InlineData("(left != nil ? default : ARM)")
    func Compatibility_TargetTypedIndexerValueBeforeGuard_ChecksItsResultValues(initializer string) {
        const source = `class Box {
    var stored bool? = nil
    prop this[index int32] bool? {
        get -> stored
        set { stored = value }
    }
    func Run(left bool?, fallback bool?, b bool) bool {
        if let v = this[0] = INITIALIZER && b { return v }
        return if let w = this[0] = INITIALIZER && b { w } else { false }
    }
}
Box().Run(nil, true, false)`
        let nullable = EmittedOracle.Evaluate(source.Replace("INITIALIZER", initializer.Replace("ARM", "fallback")))
        Assert.Empty(nullable.Diagnostics)
        Assert.Equal(false, nullable.Value)
        let boolean = EmittedOracle.Evaluate(source.Replace("INITIALIZER", initializer.Replace("ARM", "false")))
        Assert.Equal([]string{"GS0624@8:20", "GS0624@9:27"}, Ids(boolean))
    }

    @Fact
    func Compatibility_BoxedAssignmentCoalescingTailBeforeGuard_ReportsGS0624() {
        let result = EmittedOracle.Evaluate(`func Run(value object?, b bool) string {
    var cached object? = nil
    if let v = cached = value ?? false && b { return "body" }
    return if let w = cached = value ?? false && b { "body" } else { "skip" }
}
Run("present", false)`)
        Assert.Equal([]string{"GS0624@3:16", "GS0624@4:23"}, Ids(result))
    }

    @Theory
    @InlineData("if flag { a } else { false }")
    @InlineData("if let inner = optional { a } else { false }")
    @InlineData("(flag ? a : false)")
    @InlineData("{ a }")
    @InlineData("switch flag { case true: a default: false }")
    @InlineData("(optional ?? a)")
    func Compatibility_ImplicitUserConversionBeforeGuard_PreservesItsOperand(initializer string) {
        const source = `struct Box { var Value bool }
func operator implicit (value bool) Box -> Box{Value: value}
func Make(value bool) Box -> Box{Value: value}
func Run(flag bool, optional bool?, a bool, b bool) string {
    var cached Box? = nil
    if let v = cached = INITIALIZER && b { return if v.Value { "true" } else { "false" } }
    return if let w = cached = INITIALIZER && b { if w.Value { "true" } else { "false" } } else { "skip" }
}
Run(true, true, true, false)`
        let boolean = EmittedOracle.Evaluate(source.Replace("INITIALIZER", initializer))
        Assert.Equal([]string{"GS0624@6:16", "GS0624@7:23"}, Ids(boolean))

        let parenthesized = EmittedOracle.Evaluate(
            source.Replace("cached = INITIALIZER && b", "(cached = " + initializer + " && b)")
        )
        Assert.Empty(parenthesized.Diagnostics)
        Assert.Equal("false", parenthesized.Value)

        for opaque in[]string{"Make(a)", "cast[Box](a)", "if flag { cached } else { a }"} {
            let preserved = EmittedOracle.Evaluate(source.Replace("INITIALIZER", opaque))
            Assert.Empty(preserved.Diagnostics)
            Assert.Equal("skip", preserved.Value)
        }
    }

    @Theory
    @InlineData("checked")
    @InlineData("unchecked")
    func Compatibility_CheckedValueBeforeGuard_PreservesItsOriginalType(wrapper string) {
        const source = `func Run(a bool, fallback bool?, b bool) bool {
    var cached bool? = nil
    if let v = cached = WRAPPER(VALUE) && b { return v }
    return if let w = cached = WRAPPER(VALUE) && b { w } else { false }
}
Run(true, nil, false)`
        let wrapped = source.Replace("WRAPPER", wrapper)
        let nullable = EmittedOracle.Evaluate(wrapped.Replace("VALUE", "fallback"))
        Assert.Empty(nullable.Diagnostics)
        Assert.Equal(false, nullable.Value)
        let boolean = EmittedOracle.Evaluate(wrapped.Replace("VALUE", "a"))
        Assert.Equal([]string{"GS0624@3:16", "GS0624@4:23"}, Ids(boolean))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedJoin_InternalIfLetLabels_DoNotProveNullableLocalNonNull(initiallyNonNull bool) {
        let source = `func Run(flag bool, s string?, t string?) int32 {
    var text string? = INITIAL
    if flag {
        if let a = s, let b = t { MUTATE } else { }
    } else { text = "ok" }
    return text.Length
}
Run(false, "s", "t")`.Replace(
            "INITIAL",
            if initiallyNonNull {
                `"initial"`
            } else {
                "nil"
            }
        )
            .Replace(
            "MUTATE",
            if initiallyNonNull {
                "text = nil"
            } else {
                ""
            }
        )
        let result = EmittedOracle.Evaluate(source)
        Assert.Equal([]string{"GS0158@6:17"}, Ids(result))
    }

    @Fact
    func Compatibility_ParenthesizedInitializer_KeepsItsMeaning() {
        let result = EmittedOracle.Evaluate(`func Run(a bool, b bool, x string?, y string?) string {
    if let v = (a && b ? x : y) {
        return v
    }
    return "none"
}
Run(true, false, "x", "y")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("y", result.Value)
    }

    @Fact
    func WhileLetAndGuardLet_Guard_ReportsGS0625_NotGS0157() {
        let result = EmittedOracle.Evaluate(`func Run(value string?) int32 {
    while let text = value && text.Length > 0 {
        break
    }
    guard let other = value && other.Length > 0 else {
        return 0
    }
    return 1
}
Run("x")`)
        let ids = Ids(result)
        Assert.Equal(
            []string{"GS0625@2:28", "GS0625@5:29"},
            ids.Where((id string) -> id.StartsWith("GS0625")).ToArray()
        )
        Assert.DoesNotContain(ids, (id string) -> id.StartsWith("GS0157"))
    }

    @Fact
    func BothForms_TopLevelLogicalOr_ReportsGS0626() {
        let result = EmittedOracle.Evaluate(`func Run(value string?, other bool) int32 {
    if let text = value || other {
        return 1
    }
    return if let t = value || other { 1 } else { 0 }
}
Run("x", true)`)
        let ids = Ids(result)
        Assert.Equal(
            []string{"GS0626@2:25", "GS0626@5:29"},
            ids.Where((id string) -> id.StartsWith("GS0626")).ToArray()
        )
        Assert.DoesNotContain(ids, (id string) -> id.StartsWith("GS0157"))
    }

    @Fact
    func Statement_GuardInvokedClosure_ChangesExternalCallableAlias() {
        // The if-let variant of Issue4519's
        // ForwardGoto_ConditionInvokedClosureChangesExternalCallableAlias: the
        // guard runs before the then-region like an `if` condition, so the
        // closure it invokes (which makes `action` the clearing closure) must
        // be folded into the alias state before the then-region is bound.
        let result = EmittedOracle.Evaluate(`func Run(callback (() -> void), maybe string?) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    if let m = maybe && func() bool { action = clear; return true }() {
        try {
            goto Done
        }
        finally {
            action()
        }
    }
Done:
    return text.Length
}

Run(func() { }, "a")`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    shared {
        private func Ids(result EmittedOracleResult)[]string {
            return result
                .Diagnostics
                .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
                .ToArray()
        }
    }
}
