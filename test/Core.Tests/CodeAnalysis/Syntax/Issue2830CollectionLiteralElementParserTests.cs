// <copyright file="Issue2830CollectionLiteralElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #2830: <c>ParseCollectionElement</c> treated <i>every</i> leading
/// <c>[</c> inside a collection initializer as the start of an indexed entry
/// (<c>["key"] = value</c>), so an array literal used as an <i>element</i>
/// (<c>List[[]object]{ []object{1} }</c>) failed with GS0005. The parser now
/// looks ahead past the balanced bracket group and only takes the indexed-entry
/// path when an <c>=</c> follows. These tests pin both shapes.
/// </summary>
public class Issue2830CollectionLiteralElementParserTests
{
    [Theory]

    // The exact repro from the issue body.
    [InlineData("List[[]object]{ []object{1} }")]

    // Multiple array-literal elements.
    [InlineData("List[[]object]{ []object{1}, []object{2, 3} }")]

    // Sized array literal as an element.
    [InlineData("List[[]int32]{ [2]int32{1, 2} }")]

    // Jagged: an array-of-arrays literal as an element.
    [InlineData("List[[][]int32]{ [][]int32{ []int32{1} } }")]

    // Non-array elements still parse.
    [InlineData("List[int32]{ 1, 2, 3 }")]
    public void ArrayLiteral_AsCollectionElement_Parses(string initializer)
    {
        AssertParses(initializer);
    }

    [Theory]

    // The indexed-entry form must keep working.
    [InlineData("Dictionary[string,int32]{ [\"a\"] = 1 }")]
    [InlineData("Dictionary[string,int32]{ [\"a\"] = 1, [\"b\"] = 2 }")]
    [InlineData("map[string,int32]{ \"a\": 1 }")]
    public void IndexedEntry_AndMapLiteral_StillParse(string initializer)
    {
        AssertParses(initializer);
    }

    [Fact]
    public void ArrayLiteralElement_ProducesCollectionInitializerWithArrayCreationElement()
    {
        var collection = ParseCollectionInitializer("List[[]object]{ []object{1}, []object{2} }");

        Assert.Equal(2, collection.Elements.Count);
        Assert.All(
            collection.Elements,
            element => Assert.IsType<ArrayCreationExpressionSyntax>(
                Assert.IsType<ExpressionCollectionElementSyntax>(element).Expression));
    }

    [Fact]
    public void IndexedEntry_ProducesIndexedCollectionElement()
    {
        var collection = ParseCollectionInitializer("Dictionary[string,int32]{ [\"a\"] = 1 }");

        var element = Assert.Single(collection.Elements);
        Assert.IsType<IndexedCollectionElementSyntax>(element);
    }

    private static void AssertParses(string initializer)
    {
        var tree = SyntaxTree.Parse($@"
package P
func Use() {{
    let value = {initializer}
}}
");

        Assert.Empty(tree.Diagnostics);
    }

    private static CollectionInitializerExpressionSyntax ParseCollectionInitializer(string initializer)
    {
        var tree = SyntaxTree.Parse($@"
package P
func Use() {{
    let value = {initializer}
}}
");

        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var decl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        return Assert.IsType<CollectionInitializerExpressionSyntax>(decl.Initializer);
    }
}
