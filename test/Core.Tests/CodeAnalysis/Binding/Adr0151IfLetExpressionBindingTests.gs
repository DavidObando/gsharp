// <copyright file="Adr0151IfLetExpressionBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0151 — binder coverage for the value-producing `if let`
/// expression: the ADR-0071 nullable-binding rules (GS0296, explicit type
/// clause), the ADR-0064 branch rules (GS0276 / GS0277 / GS0263), name
/// scoping (later initializers and the guard see earlier bindings; the else
/// branch does not), guard typing, and target typing.
open class Adr0151IfLetExpressionBindingTests {
    @Fact
    func IfLetExpression_NullableInitializer_NarrowsInThenBranch() {
        let diagnostics = Bind(`
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    return if let v = s { Take(v) } else { 0 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_NonNullableInitializer_Diagnoses_GS0296() {
        let diagnostics = Bind(`
func Run(s string) int32 {
    return if let v = s { v.Length } else { 0 }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func IfLetExpression_MissingElse_Diagnoses_GS0276() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s { v.Length }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0276")
    }

    @Fact
    func IfLetExpression_EmptyThenBlock_Diagnoses_GS0277() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s { } else { 0 }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0277")
    }

    @Fact
    func IfLetExpression_NoCommonBranchType_Diagnoses_GS0263() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    let x = if let v = s { true } else { "no" }
    return 0
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func IfLetExpression_BindingNotVisibleInElseBranch() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s { v.Length } else { v.Length }
}
`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125" || d.Message.Contains("v"))
    }

    @Fact
    func IfLetExpression_LaterInitializer_SeesEarlierBindingNarrowed() {
        // `first` is observed at `string` (not `string?`) inside the SECOND
        // initializer, so it can be passed to a `string`-typed parameter.
        let diagnostics = Bind(`
func Second(a string) string? { return a }
func Run(s string?) int32 {
    return if let first = s, let second = Second(first) { second.Length } else { 0 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_Guard_SeesAllBindingsNarrowed() {
        let diagnostics = Bind(`
func Run(a string?, b string?) int32 {
    return if let x = a, let y = b && x.Length + y.Length > 0 { x.Length } else { 0 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_NonBooleanGuard_IsDiagnosed() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s && v.Length { 1 } else { 0 }
}
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func IfLetExpression_GuardCannotSeeUnboundNames() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s && missing > 0 { 1 } else { 0 }
}
`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125" || d.Message.Contains("missing"))
    }

    @Fact
    func IfLetExpression_ExplicitUnderlyingTypeClause_Binds() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v string = s { v.Length } else { 0 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_ObjectTargetedLet_UnifiesOtherwiseUnrelatedArms() {
        // Mirrors Issue1158ConditionalSiblingUnifyTests: `string` and `int32`
        // share only `object`, so this arm pair is GS0263 without a target
        // type (companion test below) and binds cleanly with one.
        let diagnostics = Bind(`
func Run(s string?) int32 {
    let r object = if let v = s { v } else { 0 }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_UntargetedUnrelatedArms_StillReport_GS0263() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    let r = if let v = s { v } else { 0 }
    return 0
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func IfLetExpression_ObjectTargetedReturn_UnifiesOtherwiseUnrelatedArms() {
        let diagnostics = Bind(`
func Run(s string?) object {
    return if let v = s { v } else { 0 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_ElseIfLetChain_Binds() {
        let diagnostics = Bind(`
func Run(a string?, b string?) string {
    return if let x = a { x } else if let y = b { y } else { "none" }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_NullableValueTypeBinding_Binds() {
        let diagnostics = Bind(`
func Run(n int32?) int32 {
    return if let v = n && v > 0 { v } else { -1 }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfLetExpression_BlockPrefixStatements_AreAllowedBeforeTheTail() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    return if let v = s {
        let n = v.Length
        n + 1
    } else {
        0
    }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func StatementForm_IfLet_Unchanged() {
        // Regression guard: factoring the binding-clause rules into the shared
        // IfLetBindingSupport must not change the ADR-0071 statement form.
        let diagnostics = Bind(`
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    if let v = s {
        return Take(v)
    }
    return 0
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func StatementForm_IfLet_NonNullableRhs_StillDiagnoses_GS0296() {
        let diagnostics = Bind(`
func Run(s string) {
    if let v = s {
        let x = v
    }
}
`)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func StatementForm_GuardLet_Unchanged() {
        let diagnostics = Bind(`
func Run(s string?) int32 {
    guard let v = s else {
        return 0
    }
    return v.Length
}
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
