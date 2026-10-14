// <copyright file="Issue1151NullableBranchUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1151: an `if`/`switch`-expression whose branches are a
/// value type `T` and `nil` must unify to `T?` — both when the
/// result type is inferred and when it is explicitly target-typed to `T?`.
/// The value arm is lifted to `T?` and the `nil` arm becomes the null
/// `T?`, mirroring C#'s target-typed conditional. Reference-type and
/// already-nullable arms are left unchanged (never double-wrapped).
open class Issue1151NullableBranchUnifyTests {
    @Fact
    func IfExpression_ValueTypeAndNil_Inferred_UnifiesToNullable() {
        let scope_ = BindGlobalScope(`
let x = if true { 5 } else { nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType)
    }

    @Fact
    func IfExpression_ValueTypeAndNil_TargetTyped_BindsCleanly() {
        let scope_ = BindGlobalScope(`
let x int32? = if true { 5 } else { nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType)
    }

    @Fact
    func SwitchExpression_ValueTypeAndNil_Inferred_UnifiesToNullable() {
        let scope_ = BindGlobalScope(`
let x = switch true { case true: 5 default: nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType)
    }

    @Fact
    func SwitchExpression_ValueTypeAndNil_TargetTyped_BindsCleanly() {
        let scope_ = BindGlobalScope(`
let x int32? = switch true { case true: 5 default: nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.Int32, nullable.UnderlyingType)
    }

    @Fact
    func IssueRepro_FAndG_BindWithNoDiagnostics() {
        let diagnostics = Bind(`
package p
class C {
    func F(present bool) int32? {
        let x = if present { 5 } else { nil }
        return x
    }
    func G(present bool) int32? {
        let x int32? = if present { 5 } else { nil }
        return x
    }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfExpression_NullableReferenceAndNil_NotDoubleWrapped() {
        // Regression guard: a `string?` arm unified with `nil` stays `string?`
        // (NullableTypeSymbol.Get is idempotent) — it must NOT become
        // `string??`. Reference types are left untouched by the value-type lift.
        let scope_ = BindGlobalScope(`
let s string? = "hi"
let x = if true { s } else { nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType)
        Assert.IsNotType[NullableTypeSymbol](nullable.UnderlyingType)
    }

    @Fact
    func IfExpression_Mpeg4StyleUInt32AndNil_UnifiesToNullable() {
        // The MPEG-4 optional-field pattern from the issue: a uint32 value arm
        // and a nil arm infer uint32?.
        let scope_ = BindGlobalScope(`
let d = if true { 7u } else { nil }
`)
        Assert.Empty(scope_.Diagnostics)
        let d = scope_.Variables.Single((v VariableSymbol) -> v.Name == "d").Type
        let nullable = Assert.IsType[NullableTypeSymbol](d)
        Assert.Equal(TypeSymbol.UInt32, nullable.UnderlyingType)
    }

    @Fact
    func SwitchExpression_GenuineTypeMismatch_StillDiagnoses_GS0179() {
        // The fix must NOT suppress the pre-existing arm-mismatch diagnostic
        // for genuinely incompatible arms.
        let diagnostics = Bind(`
let x = switch true { case true: 5 default: "x" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0179")
    }

    @Fact
    func IfExpression_GenuineTypeMismatch_StillDiagnoses_GS0263() {
        // Two incompatible value/reference arms (no nil) still have no common
        // type and report GS0263.
        let diagnostics = Bind(`
let x = if true { 5 } else { "x" }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0263")
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

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
