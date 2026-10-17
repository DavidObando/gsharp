// <copyright file="Issue4961IfLetStatementGuardBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #4961 / ADR-0200 — binder coverage for the aligned `if let`
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
        // ADR-0200: every binding strips one nullable layer, in both forms, so
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
        // Before ADR-0200 the statement form parsed `a && b ? x : y` as one
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

    shared {
        private func Ids(result EmittedOracleResult)[]string {
            return result
                .Diagnostics
                .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
                .ToArray()
        }
    }
}
