// <copyright file="Issue3332MissingTokenTextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3332 (part of #1364): a token the parser inserts during error
/// recovery carries <see cref="string.Empty"/> as its text, never
/// <see langword="null"/>, and reports <see cref="SyntaxToken.IsMissing"/>
/// separately.
///
/// Before this change <c>IsMissing</c> was defined as <c>Text == null</c>, so
/// every consumer of <c>token.Text</c> could dereference null on any recovery
/// path — the shape that produced issue #2144. Making the text empty removes
/// that hazard; keeping <c>IsMissing</c> as its own flag preserves the
/// distinction it encoded, which CodeLens, SemanticLookup and function
/// declaration in the binder all depend on.
/// </summary>
public class Issue3332MissingTokenTextTests
{
    /// <summary>
    /// The discriminating assertion: <c>Text</c> is empty rather than null.
    /// This is RED before the change (Text is null) and green after.
    /// </summary>
    [Fact]
    public void MissingToken_HasEmptyTextRatherThanNull()
    {
        // `func` with no name: the parser reports the unexpected token and
        // synthesises the identifier it wanted.
        var tree = SyntaxTree.Parse("func (");

        var missing = AllTokens(tree).Where(t => t.IsMissing).ToList();
        Assert.NotEmpty(missing);
        Assert.All(missing, t => Assert.Equal(string.Empty, t.Text));
        Assert.All(missing, t => Assert.NotNull(t.Text));
    }

    /// <summary>
    /// The regression guard: <c>IsMissing</c> must keep discriminating once it
    /// no longer reads <c>Text == null</c>. Without this, defining missing
    /// tokens as empty-texted would silently make <c>IsMissing</c> false
    /// everywhere and re-enable code lenses and name lookups on tokens that do
    /// not exist in source.
    /// </summary>
    [Fact]
    public void IsMissing_StillDistinguishesSynthesisedFromRealTokens()
    {
        var broken = SyntaxTree.Parse("func (");
        var wellFormed = SyntaxTree.Parse("func f() { }");

        Assert.Contains(AllTokens(broken), t => t.IsMissing);
        Assert.DoesNotContain(AllTokens(wellFormed), t => t.IsMissing);
    }

    /// <summary>
    /// A missing token occupies no source, so its span stays zero-width. The
    /// old <c>Text?.Length ?? 0</c> produced that from null; an empty string
    /// must produce the same.
    /// </summary>
    [Fact]
    public void MissingToken_SpanRemainsZeroWidth()
    {
        var tree = SyntaxTree.Parse("func (");

        Assert.All(
            AllTokens(tree).Where(t => t.IsMissing),
            t => Assert.Equal(0, t.Span.Length));
    }

    /// <summary>
    /// A real token is unaffected: it keeps its source text and is not missing.
    /// Pairs the quantifier in the tests above, which would otherwise pass on a
    /// tree with no tokens at all (ADR-0154 anti-pattern 5).
    /// </summary>
    [Fact]
    public void RealToken_KeepsItsSourceText()
    {
        var tree = SyntaxTree.Parse("func f() { }");

        var identifier = AllTokens(tree).Single(
            t => t.Kind == SyntaxKind.IdentifierToken && t.Text == "f");
        Assert.False(identifier.IsMissing);
    }

    private static System.Collections.Generic.IEnumerable<SyntaxToken> AllTokens(SyntaxTree tree)
        => Descend(tree.Root).OfType<SyntaxToken>();

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Descend(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in Descend(child))
            {
                yield return descendant;
            }
        }
    }
}
