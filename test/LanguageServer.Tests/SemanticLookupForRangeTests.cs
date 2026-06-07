// <copyright file="SemanticLookupForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class SemanticLookupForRangeTests
{
    [Fact]
    public void ForInLoopVariable_ResolvesInHeaderAndBody_InsideFunction()
    {
        const string source = "func main() {\n    var collectionItems = []int32{1, 2, 3}\n    for loopItem in collectionItems {\n        var copy = loopItem\n    }\n}\n";
        var (compilation, tree) = Compile(source);

        var loopDeclaration = IdentifierAt(tree, "loopItem", occurrence: 1);
        var loopBodyUse = IdentifierAt(tree, "loopItem", occurrence: 2);
        var collectionDeclaration = IdentifierAt(tree, "collectionItems", occurrence: 1);
        var collectionInHeader = IdentifierAt(tree, "collectionItems", occurrence: 2);

        var declarationSymbol = SemanticLookup.ResolveSymbol(compilation, loopDeclaration);
        var bodySymbol = SemanticLookup.ResolveSymbol(compilation, loopBodyUse);
        var collectionDeclarationSymbol = SemanticLookup.ResolveSymbol(compilation, collectionDeclaration);
        var collectionHeaderSymbol = SemanticLookup.ResolveSymbol(compilation, collectionInHeader);

        Assert.IsAssignableFrom<VariableSymbol>(declarationSymbol);
        Assert.Same(declarationSymbol, bodySymbol);
        Assert.IsAssignableFrom<VariableSymbol>(collectionHeaderSymbol);
        Assert.Same(collectionDeclarationSymbol, collectionHeaderSymbol);
    }

    [Fact]
    public void ForInLoopVariable_ResolvesInBody_AtTopLevel()
    {
        const string source = "var collectionItems = []int32{1, 2, 3}\nfor loopItem in collectionItems {\n    var copy = loopItem\n}\n";
        var (compilation, tree) = Compile(source);

        var loopDeclaration = IdentifierAt(tree, "loopItem", occurrence: 1);
        var loopBodyUse = IdentifierAt(tree, "loopItem", occurrence: 2);
        var collectionDeclaration = IdentifierAt(tree, "collectionItems", occurrence: 1);
        var collectionInHeader = IdentifierAt(tree, "collectionItems", occurrence: 2);

        var declarationSymbol = SemanticLookup.ResolveSymbol(compilation, loopDeclaration);
        var bodySymbol = SemanticLookup.ResolveSymbol(compilation, loopBodyUse);
        var collectionDeclarationSymbol = SemanticLookup.ResolveSymbol(compilation, collectionDeclaration);
        var collectionHeaderSymbol = SemanticLookup.ResolveSymbol(compilation, collectionInHeader);

        Assert.IsAssignableFrom<VariableSymbol>(declarationSymbol);
        Assert.Same(declarationSymbol, bodySymbol);
        Assert.IsAssignableFrom<VariableSymbol>(collectionHeaderSymbol);
        Assert.Same(collectionDeclarationSymbol, collectionHeaderSymbol);
    }

    private static (Compilation Compilation, SyntaxTree Tree) Compile(string source)
    {
        var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source));
        return (new Compilation(tree), tree);
    }

    private static SyntaxToken IdentifierAt(SyntaxTree tree, string text, int occurrence)
    {
        var seen = 0;
        foreach (var token in EnumerateTokens(tree.Root))
        {
            if (token.Kind == SyntaxKind.IdentifierToken && token.Text == text)
            {
                seen++;
                if (seen == occurrence)
                {
                    return token;
                }
            }
        }

        return null;
    }

    private static IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
    {
        if (node is SyntaxToken token)
        {
            yield return token;
            yield break;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var inner in EnumerateTokens(child))
            {
                yield return inner;
            }
        }
    }
}
