// <copyright file="Issue2919ImportedGenericProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2919: all three imported-generic type-clause paths preserve the same
/// symbolic arguments while retaining their established CLR erasures.
/// </summary>
public class Issue2919ImportedGenericProjectionTests
{
    [Fact]
    public void ImportedGenericProjection_PreservesCallerSpecificErasureAndSymbolicTypes()
    {
        var scope = BindSource("""
            package Issue2919Projection
            import System
            import System.Collections.Generic

            class Src {}
            enum Mode { First, Second }

            func Probe(
                unqualified Action[Src],
                qualified System.Action[Src],
                nested List[Src].Enumerator,
                unqualifiedEnum List[Mode],
                qualifiedEnum System.Collections.Generic.List[Mode],
                nestedEnum List[Mode].Enumerator,
                unqualifiedNullableEnum List[Mode?],
                qualifiedNullableEnum System.Collections.Generic.List[Mode?],
                nestedNullableEnum List[Mode?].Enumerator) {}
            """);

        Assert.Empty(scope.Diagnostics);

        var parameters = scope.Functions.Single(function => function.Name == "Probe").Parameters;
        AssertProjection(parameters[0].Type, "System.Action`1", "System.Object", "Src");
        AssertProjection(parameters[1].Type, "System.Action`1", "System.Object", "Src");
        AssertProjection(
            parameters[2].Type,
            "System.Collections.Generic.List`1+Enumerator",
            "System.Object",
            "Src");

        AssertProjection(parameters[3].Type, "System.Collections.Generic.List`1", "System.Int32", "Mode");
        AssertProjection(parameters[4].Type, "System.Collections.Generic.List`1", "System.Object", "Mode");
        AssertProjection(
            parameters[5].Type,
            "System.Collections.Generic.List`1+Enumerator",
            "System.Object",
            "Mode");
        AssertNullableEnumProjection(
            parameters[6].Type,
            "System.Collections.Generic.List`1");
        AssertNullableEnumProjection(
            parameters[7].Type,
            "System.Collections.Generic.List`1");
        AssertNullableEnumProjection(
            parameters[8].Type,
            "System.Collections.Generic.List`1+Enumerator");
    }

    [Fact]
    public void NullableSourceEnum_GenericArguments_EmitAndRun()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            enum Mode { First, Second }

            let unqualified = List[Mode?]()
            let qualified = System.Collections.Generic.List[Mode?]()
            unqualified.Add(Mode.Second)
            qualified.Add(Mode.First)
            unqualified[0] == Mode.Second && qualified[0] == Mode.First
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    private static void AssertProjection(
        TypeSymbol type,
        string expectedOpenDefinition,
        string expectedClrArgument,
        string expectedSymbolicArgument)
    {
        var imported = Assert.IsType<ImportedTypeSymbol>(type);
        Assert.NotNull(imported.OpenDefinition);
        Assert.Equal(expectedOpenDefinition, imported.OpenDefinition.FullName);
        Assert.Equal(expectedClrArgument, Assert.Single(imported.ClrType.GetGenericArguments()).FullName);
        Assert.Equal(expectedSymbolicArgument, Assert.Single(imported.TypeArguments).Name);
    }

    private static void AssertNullableEnumProjection(
        TypeSymbol type,
        string expectedOpenDefinition)
    {
        var imported = Assert.IsType<ImportedTypeSymbol>(type);
        Assert.NotNull(imported.OpenDefinition);
        Assert.Equal(expectedOpenDefinition, imported.OpenDefinition.FullName);
        Assert.Equal(
            typeof(object).FullName,
            Assert.Single(imported.ClrType.GetGenericArguments()).FullName);

        var symbolicArgument = Assert.IsType<NullableTypeSymbol>(Assert.Single(imported.TypeArguments));
        Assert.Equal("Mode", symbolicArgument.UnderlyingType.Name);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
