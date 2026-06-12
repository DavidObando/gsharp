// <copyright file="SemanticLookupSpanFallbackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Exercises the (file, span) fallback inside <c>SemanticLookup.SemanticModel.Resolve</c>.
///
/// The compilation's declarations dictionary is keyed by <see cref="SyntaxToken"/> reference
/// equality. When a caller hands in a token from a different parse of the same file (for
/// example, a cached DocumentContent that has not yet been refreshed after a project-wide
/// reparse), reference equality fails. Top-level names recover via the globals dictionary,
/// but type members have no name-based fallback — so the span-based lookup is what keeps
/// hover, find-references, rename, and CodeLens working through such desyncs.
/// </summary>
public class SemanticLookupSpanFallbackTests
{
    private const string Source =
        "package Temp\n" +
        "\n" +
        "class Person {\n" +
        "    public prop Name string\n" +
        "    public prop Age int32\n" +
        "\n" +
        "    func ToString() string {\n" +
        "        return \"Name: ${Name}\"\n" +
        "    }\n" +
        "}\n";

    private const string FilePath = "/virtual/Program.gs";

    [Fact]
    public void Resolve_StaleMemberToken_RecoversViaSpanFallback()
    {
        var (compilation, staleTree) = BuildDesyncedCompilation();

        var nameToken = FindFirstIdentifier(staleTree, "Name");
        Assert.NotNull(nameToken);

        var resolved = SemanticLookup.ResolveSymbol(compilation, nameToken);

        Assert.NotNull(resolved);
        Assert.Equal("Name", resolved.Name);
    }

    [Fact]
    public void Resolve_StaleMemberToken_FindsDeclaration()
    {
        var (compilation, staleTree) = BuildDesyncedCompilation();

        var nameToken = FindFirstIdentifier(staleTree, "Name");
        var symbol = SemanticLookup.ResolveSymbol(compilation, nameToken);
        Assert.NotNull(symbol);

        // FindReferences must return at least the declaration; the exact reference count
        // depends on binder behaviour and is covered by FindReferences-specific tests.
        var refCount = 0;
        foreach (var _ in SemanticLookup.FindReferences(compilation, symbol))
        {
            refCount++;
        }

        Assert.True(refCount >= 1, $"Expected at least the declaration, got {refCount}.");
    }

    [Fact]
    public void Resolve_FreshMemberToken_StillResolvesByReference()
    {
        var sourceText = SourceText.From(Source, FilePath);
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(tree);

        var nameToken = FindFirstIdentifier(tree, "Name");
        var resolved = SemanticLookup.ResolveSymbol(compilation, nameToken);

        Assert.NotNull(resolved);
        Assert.Equal("Name", resolved.Name);
    }

    private static (Compilation Compilation, SyntaxTree StaleTree) BuildDesyncedCompilation()
    {
        var freshText = SourceText.From(Source, FilePath);
        var freshTree = SyntaxTree.Parse(freshText);
        var compilation = new Compilation(freshTree);

        // A second parse of the identical source produces a tree whose SyntaxToken instances
        // do not reference-equal anything in the compilation's declarations dictionary. This
        // is the situation a stale DocumentContent leaves callers in.
        var staleText = SourceText.From(Source, FilePath);
        var staleTree = SyntaxTree.Parse(staleText);

        return (compilation, staleTree);
    }

    private static SyntaxToken FindFirstIdentifier(SyntaxTree tree, string text)
    {
        foreach (var token in EnumerateTokens(tree.Root))
        {
            if (token.Kind == SyntaxKind.IdentifierToken && token.Text == text)
            {
                return token;
            }
        }

        return null;
    }

    private static System.Collections.Generic.IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken token)
            {
                yield return token;
            }
            else
            {
                foreach (var nested in EnumerateTokens(child))
                {
                    yield return nested;
                }
            }
        }
    }
}
