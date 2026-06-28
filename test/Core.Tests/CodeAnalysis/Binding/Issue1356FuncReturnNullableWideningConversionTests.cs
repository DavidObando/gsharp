// <copyright file="Issue1356FuncReturnNullableWideningConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1356: a function type whose return type is a bare type parameter
/// <c>T</c> implicitly converts to a function returning the nullable form
/// <c>T?</c> of the same type parameter (return-type covariance via the
/// always-safe <c>T → T?</c> widening). The reverse, null-dropping direction
/// (<c>T? → T</c>) must stay rejected. These tests pin
/// <see cref="Conversion.Classify"/> so the rule survives future refactors.
/// </summary>
public class Issue1356FuncReturnNullableWideningConversionTests
{
    private static TypeParameterSymbol NewTypeParameter() =>
        new("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

    [Fact]
    public void FuncReturningTypeParameter_WidensToFuncReturningNullable()
    {
        var t = NewTypeParameter();
        var parameters = ImmutableArray.Create<TypeSymbol>(t);
        var from = FunctionTypeSymbol.Get(parameters, t);
        var to = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(t));

        var conversion = Conversion.Classify(from, to);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
        Assert.False(conversion.IsIdentity);
    }

    [Fact]
    public void FuncReturningNullable_DoesNotNarrowToFuncReturningTypeParameter()
    {
        var t = NewTypeParameter();
        var parameters = ImmutableArray.Create<TypeSymbol>(t);
        var from = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(t));
        var to = FunctionTypeSymbol.Get(parameters, t);

        var conversion = Conversion.Classify(from, to);

        Assert.False(conversion.Exists);
    }

    [Fact]
    public void FuncReturningConcreteReference_WidensToFuncReturningNullable()
    {
        // Control: the concrete reference-return widening keeps working.
        var parameters = ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32);
        var from = FunctionTypeSymbol.Get(parameters, TypeSymbol.String);
        var to = FunctionTypeSymbol.Get(parameters, NullableTypeSymbol.Get(TypeSymbol.String));

        var conversion = Conversion.Classify(from, to);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
    }
}
