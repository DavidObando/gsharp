// <copyright file="Issue1958StructMemberGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression test mirroring <see cref="Issue1958InterfaceMemberGenericSubstitutionTests"/>:
/// <c>StructSymbol.SubstituteTypeForConstruction</c> had the identical
/// un-projected <c>MakeGenericType</c> erasure bug as <c>InterfaceSymbol</c>
/// before this fix (blocking review #2032). A G# <c>struct S[T]</c> with an
/// imported generic-CLR-typed field over the struct's OWN type parameter
/// (e.g. <c>IEnumerator[T]</c>) would silently erase to the definition's
/// open <c>T</c> when constructed under a
/// <see cref="System.Reflection.MetadataLoadContext"/>-style resolver, because
/// <c>StructSymbol.Construct</c> dropped the projector on the floor instead of
/// threading it (like <c>InterfaceSymbol.Construct</c>) into
/// <c>MakeGenericType</c>.
/// </summary>
public class Issue1958StructMemberGenericSubstitutionTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies, forcing gsc into the <see cref="System.Reflection.MetadataLoadContext"/>
    /// resolution path — reproducing the cross-reflection-context scenario
    /// inside the unit-test process. Mirrors
    /// <c>Issue1958InterfaceMemberGenericSubstitutionTests.MetadataLoadContextResolver</c>.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    [Fact]
    public void StructSymbol_SubstituteTypeForConstruction_ProjectsClrArgsAcrossReflectionContexts()
    {
        // Direct symbol-layer check (mirrors the interface-layer test): a
        // struct definition Box[T] with a field typed as a constructed CLR
        // generic (IEnumerator[T]) over the struct's OWN type parameter must,
        // when constructed as Box[int32] under a mapClrType-bearing resolver,
        // substitute T -> int32 in the field's imported generic type. Before
        // the fix, StructSymbol.Construct dropped mapClrType on the floor, so
        // MakeGenericType mixed the MLC-resolved open definition with the
        // host runtime's typeof(int) CLR arg, threw ArgumentException, and
        // silently fell back to the still-open `IEnumerator[T]` field type.
        var resolver = MetadataLoadContextResolver();
        var mapClrType = resolver.MapClrTypeToReferences;

        var enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator<>));
        var mlcObject = resolver.MapClrTypeToReferences(typeof(object));

        var tp = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var erasedFieldType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create<TypeSymbol>(tp));

        var fields = ImmutableArray.Create(new FieldSymbol("Items", erasedFieldType, Accessibility.Public));
        var definition = new StructSymbol("Box", fields, Accessibility.Public, declaration: null, packageName: "P");
        definition.SetTypeParameters(ImmutableArray.Create(tp));

        var constructed = StructSymbol.Construct(definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32), mapClrType);

        var substitutedFieldType = Assert.IsType<ImportedTypeSymbol>(constructed.Fields[0].Type);
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedFieldType.TypeArguments));
    }

    [Fact]
    public void StructSymbol_SubstituteTypeForConstruction_WithoutMapClrType_ErasesUnderMetadataLoadContext()
    {
        // Control case proving the failure mode this test guards against: with
        // no projector supplied (mapClrType: null, the pre-#1958 behavior),
        // MakeGenericType throws under MLC and the fix's own graceful fallback
        // (catch -> Debug.WriteLine + return the erased member) kicks in, so
        // the field type stays the still-open `IEnumerator[T]` instead of
        // throwing out of Construct entirely.
        var resolver = MetadataLoadContextResolver();

        var enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator<>));
        var mlcObject = resolver.MapClrTypeToReferences(typeof(object));

        var tp = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var erasedFieldType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create<TypeSymbol>(tp));

        var fields = ImmutableArray.Create(new FieldSymbol("Items", erasedFieldType, Accessibility.Public));
        var definition = new StructSymbol("Box", fields, Accessibility.Public, declaration: null, packageName: "P");
        definition.SetTypeParameters(ImmutableArray.Create(tp));

        var constructed = StructSymbol.Construct(definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        var unsubstitutedFieldType = Assert.IsType<ImportedTypeSymbol>(constructed.Fields[0].Type);
        Assert.Same(tp, Assert.Single(unsubstitutedFieldType.TypeArguments));
    }
}
