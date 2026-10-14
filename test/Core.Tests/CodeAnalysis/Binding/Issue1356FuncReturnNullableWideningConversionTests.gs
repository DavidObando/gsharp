// <copyright file="Issue1356FuncReturnNullableWideningConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import Xunit

/// Issue #1356: a function type whose return type is a bare type parameter
/// `T` implicitly converts to a function returning the nullable form
/// `T?` of the same type parameter (return-type covariance via the
/// always-safe `T → T?` widening). Issue #2714 permits the reverse
/// delegate conversion too because an unconstrained `T?` is a
/// nullable-reference annotation with the same runtime signature. These tests pin
/// (cref:Conversion.Classify) so the rule survives future refactors.
open class Issue1356FuncReturnNullableWideningConversionTests {
    @Fact
    func FuncReturningTypeParameter_WidensToFuncReturningNullable() {
        let t = NewTypeParameter()
        let parameters = ImmutableArray.Create[TypeSymbol](t)
        let from = FunctionTypeSymbol.Get(parameters, t)
        let to = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(t))
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
        Assert.False(conversion.IsIdentity)
    }

    @Fact
    func FuncReturningNullable_ConvertsToSameRuntimeTypeParameterSignature() {
        let t = NewTypeParameter()
        let parameters = ImmutableArray.Create[TypeSymbol](t)
        let from = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(t))
        let to = FunctionTypeSymbol.Get(parameters, t)
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
    }

    @Fact
    func FuncReturningConcreteReference_WidensToFuncReturningNullable() {
        // Control: the concrete reference-return widening keeps working.
        let parameters = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let from = FunctionTypeSymbol.Get(parameters, TypeSymbol.String)
        let to = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(TypeSymbol.String))
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
    }

    shared {
        private func NewTypeParameter() TypeParameterSymbol -> TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
    }
}
