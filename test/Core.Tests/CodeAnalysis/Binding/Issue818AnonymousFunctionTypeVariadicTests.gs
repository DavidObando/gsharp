// <copyright file="Issue818AnonymousFunctionTypeVariadicTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #818 — binder / diagnostic / identity tests for variadic
/// parameters in anonymous function-type clauses
/// (`(T1, ...T2) -> R`). ADR-0102 follow-up closing the v1
/// carve-out from ADR-0102 §6.
open class Issue818AnonymousFunctionTypeVariadicTests {
    @Fact
    func Issue818_Repro_VariadicAnonymousFunctionType_Binds() {
        // The exact repro from issue #818 — must bind and produce 4 + 1 = 5.
        let result = Evaluate(`
let f (int32, ...string) -> int32 = (a, args) -> args.Length + a
f(1, "a", "b", "c", "d")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func Issue818_PassThroughSlice_NoPack() {
        let result = Evaluate(`
let f (int32, ...string) -> int32 = (a, args) -> args.Length + a
f(10, []string{"a", "b"})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func Issue818_VariadicAnonymousType_EmptyTrailingArgs() {
        let result = Evaluate(`
let f (int32, ...string) -> int32 = (a, args) -> args.Length + a
f(7)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Issue818_FunctionTypeIdentity_VariadicFlagMatters() {
        // Two anonymous function-type symbols with the same parameter
        // shape but different variadic flags must NOT be identical.
        let variadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32
        )
        let nonVariadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, false),
            TypeSymbol.Int32
        )
        Assert.NotSame(variadic, nonVariadic)
        Assert.True(variadic.HasVariadic)
        Assert.False(nonVariadic.HasVariadic)
    }

    @Fact
    func Issue818_FunctionTypeIdentity_SameShape_SameVariadic_AreIdentical() {
        let a = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32
        )
        let b = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32
        )
        Assert.Same(a, b)
    }

    @Fact
    func Issue818_FunctionTypeIdentity_NoVariadicArray_EqualsAllFalse() {
        // Backwards-compat overload: `Get(paramTypes, returnType)` is the
        // legacy pre-#818 entry point and must produce the same instance as
        // the new overload with an all-false flag array (or an empty/default
        // flag array indicating "no variadic anywhere").
        let legacy = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            TypeSymbol.Int32
        )
        let explicitNonVariadic = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, false),
            TypeSymbol.Int32
        )
        Assert.Same(legacy, explicitNonVariadic)
    }

    @Fact
    func Issue818_DisplayName_ShowsEllipsisOnVariadicSlot() {
        let t = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, SliceTypeSymbol.Get(TypeSymbol.String)),
            ImmutableArray.Create(false, true),
            TypeSymbol.Int32
        )
        Assert.Contains("...", t.Name)
    }

    @Fact
    func Issue818_NamedDelegateInvoke_FromAnonymousVariadicCall() {
        // A named variadic delegate type is callable through a variable
        // typed as the matching anonymous variadic function-type. This
        // exercises the call-site pack on the variable path.
        let result = Evaluate(`
let f (int32, ...string) -> int32 = (a, args) -> a + args.Length
f(3, "x", "y")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func Issue818_Misuse_VariadicNotLast_ReportsGS0145() {
        let diags = Bind(`
package P
let f (...string, int32) -> int32 = (xs, n) -> n
`)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0145")
    }

    @Fact
    func Issue818_Misuse_MultiVariadic_ReportsGS0364() {
        let diags = Bind(`
package P
let f (...int32, ...string) -> int32 = (xs, ys) -> 0
`)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0364")
    }

    @Fact
    func Issue818_AnonymousVariadic_AcceptsRegularLambda_OfTheRightShape() {
        // A regular-form (non-variadic) lambda whose parameter shape
        // matches the variadic target's stored shape is assignable into
        // the variadic anonymous function-type slot. The implicit
        // conversion bridges the variadic-flag-only difference.
        let result = Evaluate(`
let count (int32, ...string) -> int32 = (a, args) -> a + args.Length
count(2, "x", "y", "z")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

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
