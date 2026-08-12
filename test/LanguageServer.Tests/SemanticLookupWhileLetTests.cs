// <copyright file="SemanticLookupWhileLetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>LSP symbol mapping coverage for issue #3352.</summary>
public sealed class SemanticLookupWhileLetTests
{
    [Fact]
    public void BindingDeclarationAndBodyUseResolveToSameSymbol()
    {
        const string Source = """
            func Run(maybe string?) {
                while let value = maybe {
                    let copy = value
                    break
                }
            }
            """;
        var tree = SyntaxTree.Parse(Source);
        var compilation = new Compilation(tree);
        var declaration = IdentifierAt(tree, "value", occurrence: 1);
        var bodyUse = IdentifierAt(tree, "value", occurrence: 2);

        var declarationSymbol = SemanticLookup.ResolveSymbol(compilation, declaration);
        var bodySymbol = SemanticLookup.ResolveSymbol(compilation, bodyUse);

        Assert.IsAssignableFrom<VariableSymbol>(declarationSymbol);
        Assert.Same(declarationSymbol, bodySymbol);
    }

    [Fact]
    public void BindingScopeShadowsAndThenRestoresOuterLocal()
    {
        const string Source = """
            func Run(maybe string?) {
                let value string? = maybe
                while let value = value {
                    let inside = value
                }
                let after = value
            }
            """;
        var tree = SyntaxTree.Parse(Source);
        var compilation = new Compilation(tree);

        var outer = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1));
        var binding = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2));
        var initializerUse = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3));
        var bodyUse = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4));
        var afterUse = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5));

        Assert.NotSame(outer, binding);
        Assert.Same(outer, initializerUse);
        Assert.Same(binding, bodyUse);
        Assert.Same(outer, afterUse);
    }

    [Fact]
    public void NestedBindingsResolveToInnermostLoop()
    {
        const string Source = """
            func Run(outerMaybe string?, innerMaybe string?) {
                while let value = outerMaybe {
                    let before = value
                    while let value = innerMaybe {
                        let inside = value
                    }
                    let after = value
                }
            }
            """;
        var tree = SyntaxTree.Parse(Source);
        var compilation = new Compilation(tree);

        var outer = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1));
        var before = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2));
        var inner = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3));
        var inside = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4));
        var after = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5));

        Assert.Same(outer, before);
        Assert.NotSame(outer, inner);
        Assert.Same(inner, inside);
        Assert.Same(outer, after);
    }

    [Fact]
    public void BindingResolvesInsideInterpolationHole()
    {
        const string Source = """
            func Run(maybe string?) {
                while let value = maybe {
                    let message = "value=${value}"
                    break
                }
            }
            """;
        var tree = SyntaxTree.Parse(Source);
        var compilation = new Compilation(tree);
        var declaration = IdentifierAt(tree, "value", occurrence: 1);
        var holeUse = IdentifierAt(tree, "value", occurrence: 2);

        Assert.Same(
            SemanticLookup.ResolveSymbol(compilation, declaration),
            SemanticLookup.ResolveSymbol(compilation, holeUse));
    }

    private static SyntaxToken IdentifierAt(SyntaxTree tree, string text, int occurrence)
    {
        var seen = 0;
        foreach (var token in EnumerateTokens(tree.Root))
        {
            if (token.Kind == SyntaxKind.IdentifierToken && token.Text == text && ++seen == occurrence)
            {
                return token;
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
            foreach (var childToken in EnumerateTokens(child))
            {
                yield return childToken;
            }
        }
    }
}
