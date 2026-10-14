// <copyright file="Issue1428ConditionalNullableOrderTests.cs" company="GSharp">
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

/// Issue #1428: the best-common-type of a value-producing `if`/conditional
/// expression must UNION the nullable annotation of BOTH arms regardless of arm
/// order. When a non-nullable reference arm `T` appears first and a
/// nullable arm `T?` second (both mutually reference-convertible), the
/// merged type must still be `T?` — mirroring C# where `cond ? e : null`
/// (and the reversed form) both yield `T?`.
open class Issue1428ConditionalNullableOrderTests {
    @Fact
    func IfExpression_NonNullThenNullableElse_UnifiesToNullable() {
        let scope_ = BindGlobalScope(`
let s string? = "hi"
let x = if true { "lit" } else { s }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func IfExpression_NullableThenNonNullElse_UnifiesToNullable() {
        // The reversed arm order already worked before the fix; it must keep
        // yielding the same nullable result so both orders agree.
        let scope_ = BindGlobalScope(`
let s string? = "hi"
let x = if true { s } else { "lit" }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        let nullable = Assert.IsType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func IfExpression_NonNullBothArms_StaysNonNull() {
        // Regression guard: two non-nullable reference arms must NOT be lifted.
        let scope_ = BindGlobalScope(`
let a string = "a"
let b string = "b"
let x = if true { a } else { b }
`)
        Assert.Empty(scope_.Diagnostics)
        let x = scope_.Variables.Single((v VariableSymbol) -> v.Name == "x").Type
        Assert.IsNotType[NullableTypeSymbol](x)
        Assert.Equal(TypeSymbol.String, x)
    }

    @Fact
    func IfExpression_GenericInterfaceArm_NonNullFirst_AssignNilSucceeds() {
        // The issue repro: arm0 is the non-null `IEnumerator[T]` and arm1 is the
        // nullable `IEnumerator[T]?`. The unified type must be nullable so a
        // later `x = nil` assignment is legal.
        let diagnostics = Bind(`
import System.Collections.Generic
func F[T](e IEnumerator[T]) {
    var x = if true { e } else { default(IEnumerator[T]?) }
    x = nil
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IfExpression_GenericInterfaceArm_NullableFirst_AssignNilSucceeds() {
        let diagnostics = Bind(`
import System.Collections.Generic
func F[T](e IEnumerator[T]) {
    var x = if true { default(IEnumerator[T]?) } else { e }
    x = nil
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

        private func BindGlobalScope(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
