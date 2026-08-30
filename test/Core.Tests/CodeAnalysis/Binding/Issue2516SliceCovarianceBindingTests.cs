// <copyright file="Issue2516SliceCovarianceBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2516 conversion-matrix guards for source slices, imported CLR
/// arrays, nullable envelopes, overload resolution, and invariant targets.
/// </summary>
public class Issue2516SliceCovarianceBindingTests
{
    private static readonly TypeSymbol EnumerableObject =
        TypeSymbol.FromClrType(typeof(IEnumerable<object>));

    private static readonly TypeSymbol ListObject =
        TypeSymbol.FromClrType(typeof(IList<object>));

    [Fact]
    public void SourceSlice_ComposesCovariantInterfaceAndNullableEnvelope()
    {
        var source = SliceTypeSymbol.Get(TypeSymbol.String);
        var direct = Conversion.Classify(source, EnumerableObject);
        var nullable = Conversion.Classify(source, NullableTypeSymbol.Get(EnumerableObject));

        Assert.True(direct.Exists && direct.IsImplicit);
        Assert.True(nullable.Exists && nullable.IsImplicit);
    }

    [Fact]
    public void SourceSlice_RejectsMutableArrayAndValueTypeVariance()
    {
        var strings = SliceTypeSymbol.Get(TypeSymbol.String);
        var integers = SliceTypeSymbol.Get(TypeSymbol.Int32);

        Assert.False(Conversion.Classify(strings, ListObject).Exists);
        Assert.False(Conversion.Classify(integers, EnumerableObject).Exists);

        // Issue #3685: `[]string -> []object` gained an EXPLICIT spelling
        // (`cast[[]object](strings)`), so the conversion now exists — but the
        // #2516 invariance rule is unchanged, which is what this guard pins:
        // it must never be IMPLICIT.
        var covariantSlice = Conversion.Classify(strings, SliceTypeSymbol.Get(TypeSymbol.Object));
        Assert.True(covariantSlice.Exists);
        Assert.False(covariantSlice.IsImplicit);
    }

    [Fact]
    public void ImportedArray_UsesSameSafeVarianceMatrix()
    {
        var strings = TypeSymbol.FromClrType(typeof(string[]));

        Assert.True(Conversion.Classify(strings, EnumerableObject) is
        {
            Exists: true,
            IsImplicit: true,
        });
        Assert.False(Conversion.Classify(strings, ListObject).Exists);

        // Issue #3685, imported-array arm of the same rule: explicit-only.
        var covariantArray = Conversion.Classify(strings, TypeSymbol.FromClrType(typeof(object[])));
        Assert.True(covariantArray.Exists);
        Assert.False(covariantArray.IsImplicit);
    }

    [Fact]
    public void ClrOverloadClassification_UsesDeclaredVarianceOnly()
    {
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.Reference,
            ClrOverloadResolution.ClassifyImplicit(typeof(IEnumerable<object>), typeof(string[])));
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(IList<object>), typeof(string[])));
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(object[]), typeof(string[])));
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(IEnumerable<object>), typeof(int[])));
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(ICovariant<object>), typeof(string[])));
    }

    private interface ICovariant<out T>
    {
    }
}
