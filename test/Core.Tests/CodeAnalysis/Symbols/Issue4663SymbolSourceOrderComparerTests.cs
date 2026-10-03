// <copyright file="Issue4663SymbolSourceOrderComparerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>Issue #4663: the symbol order must not tie on distinct containing-type paths.</summary>
public class Issue4663SymbolSourceOrderComparerTests
{
    /// <summary>Namespace segments must not alias nested-type segments.</summary>
    [Fact]
    public void ConstructorsInNamespaceAndNestedType_AreDistinctInTheBoundProgram()
    {
        var compilation = new Compilation(
            SyntaxTree.Parse("package p\nclass A { class B { init() { } } }"),
            SyntaxTree.Parse("package p.A\nclass B { init() { } }"));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var bound = compilation.BoundProgram;
        Assert.Empty(bound.Diagnostics.Where(d => d.IsError));
        var constructors = bound.Structs.SelectMany(s => s.ExplicitConstructors)
            .Where(c => c.DeclaringType?.Name == "B").Select(c => c.Function).ToArray();
        Assert.Equal(2, constructors.Length);
        AssertOrderedBothWays(constructors[0], constructors[1]);
    }

    /// <summary>Explicit constructors have no FunctionDeclarationSyntax: signatures must disambiguate them.</summary>
    [Theory]
    [InlineData("x Foo.X", "x Bar.X", "")]
    [InlineData("x Foo.Box[int32]", "x Bar.Box[int32]", "")]
    [InlineData("x List[Foo.X]", "x List[Bar.X]", "")]
    [InlineData("x int32", "ref x int32", "")]
    [InlineData("x int32", "out x int32", "x = 0")]
    public void QualifiedConstructorSignatures_AreDistinctInBoundSymbols(string first, string second, string body)
    {
        var constructors = new[] { first, second }.Select(parameter =>
        {
            var compilation = new Compilation(
                SyntaxTree.Parse("package Foo\nclass X { }\nclass Box[T] { }"),
                SyntaxTree.Parse("package Bar\nclass X { }\nclass Box[T] { }"),
                SyntaxTree.Parse($"package P\nimport System.Collections.Generic\nclass Host {{ init({parameter}) {{ {(parameter == second ? body : string.Empty)} }} }}"));
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
            var bound = compilation.BoundProgram;
            Assert.Empty(bound.Diagnostics.Where(d => d.IsError));
            return Assert.Single(Assert.Single(bound.Structs, s => s.Name == "Host").ExplicitConstructors).Function;
        }).ToArray();
        Assert.All(constructors, constructor => Assert.Null(constructor.Declaration));
        AssertOrderedBothWays(constructors[0], constructors[1]);
    }

    /// <summary>Generic arity and lowered sequence specialization are identity, even at identical source coordinates.</summary>
    [Fact]
    public void ArityAndNullableSequenceSpecialization_BreakOtherwiseIdenticalKeys()
    {
        var ordinary = TopLevelFunction("P");
        var generic = TopLevelFunction("P");
        generic.TypeParameters = ImmutableArray.Create(new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None));
        AssertOrderedBothWays(ordinary, generic);

        var reference = TopLevelFunction("P");
        var value = TopLevelFunction("P");
        reference.NullableSequenceSpecialization = NullableSequenceSpecializationKind.ReferenceType;
        value.NullableSequenceSpecialization = NullableSequenceSpecializationKind.ValueType;
        AssertOrderedBothWays(reference, value);
    }

    /// <summary>Source kinds and constructed owner arguments are retained, not only their display names.</summary>
    [Fact]
    public void ClassStructAndConstructedOwnerKinds_AreDistinct()
    {
        var structure = new StructSymbol("Owner", ImmutableArray<FieldSymbol>.Empty, Accessibility.Public, declaration: null, packageName: "P");
        var referenceType = new StructSymbol("Owner", ImmutableArray<FieldSymbol>.Empty, Accessibility.Public, declaration: null, packageName: "P", isData: false, isInline: false, isClass: true);
        AssertOrderedBothWays(FunctionIn(structure), FunctionIn(referenceType));
        var compilation = new Compilation(SyntaxTree.Parse("package P\nclass Owner[T] { }"));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var definition = Assert.Single(compilation.BoundProgram.Structs);
        var first = StructSymbol.Construct(definition, ImmutableArray.Create(TypeSymbol.Int32));
        var second = StructSymbol.Construct(definition, ImmutableArray.Create(TypeSymbol.String));
        AssertOrderedBothWays(FunctionIn(first), FunctionIn(second));
    }

    /// <summary>The pre-existing untied MethodDef keys take precedence over every new identity tie-break.</summary>
    [Fact]
    public void HistoricalUntiedMethodDefKeysAndFilePathOrder_ArePreserved()
    {
        var earlier = DeclaredFunction("package Z\nfunc z() { }", "Z.gs");
        var later = DeclaredFunction("package A\n\nfunc a() { }", "A.gs");
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(earlier, later) < 0);
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(
            DeclaredFunction("package Z\nfunc a() { }", "Z.gs"),
            DeclaredFunction("package A\nfunc z() { }", "A.gs")) < 0);
        Assert.True(SymbolSourceOrderComparer.Instance.Compare(
            DeclaredFunction("package P\nfunc f() { }", "A.gs"),
            DeclaredFunction("package P\nfunc f() { }", "Z.gs")) < 0);
    }

    private static FunctionSymbol DeclaredFunction(string source, string file)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, file));
        var declaration = Assert.Single(tree.Root.DescendantNodesAndSelf().OfType<FunctionDeclarationSyntax>());
        return new FunctionSymbol(declaration.Identifier.Text, ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, declaration);
    }

    private static void AssertOrderedBothWays(FunctionSymbol first, FunctionSymbol second)
    {
        int forward = SymbolSourceOrderComparer.Instance.Compare(first, second);
        int backward = SymbolSourceOrderComparer.Instance.Compare(second, first);
        Assert.NotEqual(0, forward);
        Assert.Equal(System.Math.Sign(forward), -System.Math.Sign(backward));
        Assert.Equal(new[] { first, second }.OrderBy(s => s, SymbolSourceOrderComparer.Instance),
            new[] { second, first }.OrderBy(s => s, SymbolSourceOrderComparer.Instance));
    }

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
