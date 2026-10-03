// <copyright file="Issue4663SymbolSourceOrderComparerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using System.Linq;
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

    /// <summary>
    /// Same-shaped top-level functions in two packages are ordered by package,
    /// not tied (they share a name, signature and the lack of a file name).
    /// </summary>
    [Fact]
    public void TopLevelFunctionsInDifferentPackages_AreOrderedByPackage()
    {
        FunctionSymbol inB = TopLevelFunction("B");
        FunctionSymbol inA = TopLevelFunction("A");

        Assert.True(SymbolSourceOrderComparer.Instance.Compare(inA, inB) < 0);
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(inB, inA) > 0);
    }

    /// <summary>
    /// A field-initializer view is in field source order whatever order the
    /// identity-keyed map enumerates (the lowering passes number temporaries
    /// while walking it).
    /// </summary>
    [Fact]
    public void FieldInitializers_AreWalkedInFieldSourceOrder()
    {
        const int Count = 64;
        var source = new System.Text.StringBuilder("package P\nclass Holder {\n");
        for (int i = 0; i < Count; i++)
        {
            source.Append($"    var F{i} int32 = {i}\n");
        }

        source.Append("}\n");
        var members = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(source.ToString(), "Fields.gs"))
            .Root.DescendantNodesAndSelf()
            .OfType<GSharp.Core.CodeAnalysis.Syntax.FieldDeclarationSyntax>()
            .ToArray();
        Assert.Equal(Count, members.Length);

        // Insert in reverse source order; give every field its member as declaration.
        var map = System.Collections.Immutable.ImmutableDictionary<FieldSymbol, GSharp.Core.CodeAnalysis.Binding.BoundExpression>.Empty;
        for (int i = Count - 1; i >= 0; i--)
        {
            var field = new FieldSymbol($"F{i}", TypeSymbol.Int32, Accessibility.Public, declaration: members[i]);
            map = map.Add(field, new GSharp.Core.CodeAnalysis.Binding.BoundLiteralExpression(null, i));
        }

        var ordered = GSharp.Core.CodeAnalysis.Binding.BoundProgramOrder.FieldInitializers(map);

        Assert.Equal(
            Enumerable.Range(0, Count).Select(i => $"F{i}").ToArray(),
            ordered.Select(pair => pair.Key.Name).ToArray());
    }

    private static FunctionSymbol TopLevelFunction(string package) => new FunctionSymbol(
        "f",
        ImmutableArray<ParameterSymbol>.Empty,
        TypeSymbol.Int32,
        declaration: null,
        package: new PackageSymbol(package, declaration: null));

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
