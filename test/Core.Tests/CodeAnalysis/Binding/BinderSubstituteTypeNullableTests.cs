// <copyright file="BinderSubstituteTypeNullableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class BinderSubstituteTypeNullableTests
{
    [Fact]
    public void ImportedGeneric_ConcreteNullableSubstitution_PreservesNullableClrArgument()
    {
        var typeParameter = TypeParameter();
        var openDefinition = typeof(List<>);
        var imported = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(typeof(object)),
            openDefinition,
            ImmutableArray.Create<TypeSymbol>(typeParameter));

        var substituted = Binder.SubstituteType(
            imported,
            new Dictionary<TypeParameterSymbol, TypeSymbol>
            {
                [typeParameter] = NullableTypeSymbol.Get(TypeSymbol.Int32),
            });

        Assert.Equal(typeof(List<int?>), substituted.ClrType);
    }

    [Fact]
    public void ImportedGeneric_UnconstrainedNullableTypeParameter_PreservesErasure()
    {
        var typeParameter = TypeParameter();
        var openDefinition = typeof(List<>);
        var imported = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(typeof(object)),
            openDefinition,
            ImmutableArray.Create<TypeSymbol>(NullableTypeSymbol.Get(typeParameter)));

        var substituted = Binder.SubstituteType(
            imported,
            new Dictionary<TypeParameterSymbol, TypeSymbol>
            {
                [typeParameter] = TypeSymbol.Int32,
            });

        Assert.Equal(typeof(List<int>), substituted.ClrType);
    }

    private static TypeParameterSymbol TypeParameter()
        => new("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
}
