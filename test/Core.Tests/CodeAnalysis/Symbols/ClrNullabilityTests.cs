// <copyright file="ClrNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Phase 3.C.5 / ADR-0001: BCL nullable interop.
///
/// Covers value-type lift (<c>Nullable&lt;T&gt;</c> on the CLR side becomes
/// <see cref="NullableTypeSymbol"/> on the GSharp side) and reference-type
/// surfacing via <c>[NullableContext]</c> / <c>[Nullable]</c> attributes.
/// </summary>
public class ClrNullabilityTests
{
    [Fact]
    public void NullableValueType_LiftsToNullableTypeSymbol()
    {
        var sym = TypeSymbol.FromClrType(typeof(int?));
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.Int, nullable.UnderlyingType);
    }

    [Fact]
    public void NonNullableValueType_StaysFlat()
    {
        var sym = TypeSymbol.FromClrType(typeof(int));
        Assert.Same(TypeSymbol.Int, sym);
        Assert.IsNotType<NullableTypeSymbol>(sym);
    }

    [Fact]
    public void ReferenceTypeAnnotation_SurfacesAsNullable()
    {
        // Sample.AnnotatedReturn is annotated `string?` so the binder should
        // see NullableTypeSymbol(String).
        var method = typeof(Sample).GetMethod(nameof(Sample.AnnotatedReturn));
        var sym = ClrNullability.GetReturnTypeSymbol(method);
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void ReferenceTypeNonNullAnnotation_StaysFlat()
    {
        var method = typeof(Sample).GetMethod(nameof(Sample.NonNullReturn));
        var sym = ClrNullability.GetReturnTypeSymbol(method);
        Assert.Same(TypeSymbol.String, sym);
    }

    /// <summary>
    /// Carries the C# 8 nullability annotations we need to test against.
    /// Compiled with the surrounding project's nullable context — the
    /// <c>?</c> on <see cref="AnnotatedReturn"/> emits a
    /// <c>[NullableAttribute(2)]</c> on the return parameter and the
    /// non-annotated <see cref="NonNullReturn"/> picks up the
    /// <c>[NullableContextAttribute(1)]</c> from the enclosing type.
    /// </summary>
    public class Sample
    {
        public string? AnnotatedReturn()
        {
            return null;
        }

        public string NonNullReturn()
        {
            return string.Empty;
        }
    }
}
