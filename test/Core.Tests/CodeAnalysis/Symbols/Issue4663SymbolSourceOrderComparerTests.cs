// <copyright file="Issue4663SymbolSourceOrderComparerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>Issue #4663: the symbol order must not tie on distinct containing-type paths.</summary>
public class Issue4663SymbolSourceOrderComparerTests
{
    /// <summary>
    /// Two functions that differ only in the outermost type of a 100-deep
    /// containing chain are ordered, not tied (a truncated chain tied them,
    /// leaving their order to the input enumeration).
    /// </summary>
    [Fact]
    public void FunctionsInDeeplyNestedTypes_DifferingOnlyAtTheOutermostType_AreOrdered()
    {
        FunctionSymbol first = FunctionIn(NestedChain("A", depth: 100));
        FunctionSymbol second = FunctionIn(NestedChain("B", depth: 100));

        int forward = SymbolSourceOrderComparer.Instance.Compare(first, second);
        int backward = SymbolSourceOrderComparer.Instance.Compare(second, first);

        Assert.True(forward < 0);
        Assert.True(backward > 0);
    }

    private static StructSymbol NestedChain(string outermost, int depth)
    {
        StructSymbol? outer = null;
        for (int i = 0; i < depth; i++)
        {
            var type = new StructSymbol(
                i == 0 ? outermost : "Inner",
                ImmutableArray<FieldSymbol>.Empty,
                Accessibility.Public,
                declaration: null,
                packageName: "p");
            if (outer is not null)
            {
                type.SetContainingType(outer);
            }

            outer = type;
        }

        return outer!; // depth is positive, so the loop assigned it.
    }

    private static FunctionSymbol FunctionIn(TypeSymbol container)
    {
        var function = new FunctionSymbol("f", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
        function.AnchorContainingType(container);
        return function;
    }
}
