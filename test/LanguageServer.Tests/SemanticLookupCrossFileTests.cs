// <copyright file="SemanticLookupCrossFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression tests for cross-file symbol resolution. Syntax spans are per-file offsets, so
/// in a multi-file compilation the SemanticModel's span-based lookups
/// (FindContainingFunction, ResolveImplicitThisMember) must restrict themselves to the token's
/// own tree. Before that guard, a declaration in another file whose offset range overlapped the
/// token's offset would shadow the real one, causing hover / go-to-definition / completion on
/// locals and implicit-this members to resolve to the wrong file or to nothing.
/// </summary>
public class SemanticLookupCrossFileTests
{
    // Two structurally identical classes in two files: `Width` sits at the same offset in both,
    // and their method bodies share the same span — so a non-tree-scoped lookup can pick the
    // wrong file's type.
    private const string Template =
        "class {0} {{\n    prop Width int32\n    func M() int32 {{\n        return Width\n    }}\n}}\n";

    [Fact]
    public void ResolveImplicitThisProperty_PicksDeclarationFromTokensOwnFile()
    {
        var srcA = string.Format(Template, "AA");
        var treeA = SyntaxTree.Parse(SourceText.From(srcA, "/a.gs"));
        var treeB = SyntaxTree.Parse(SourceText.From(string.Format(Template, "BB"), "/b.gs"));

        // Put B first so a cross-file collision would resolve the token to B.
        var compilation = new Compilation(treeB, treeA);

        var off = srcA.IndexOf("return Width", StringComparison.Ordinal) + "return ".Length;
        var token = SemanticLookup.FindTokenAt(treeA, off);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token) as PropertySymbol;

        Assert.NotNull(symbol);
        Assert.NotNull(symbol.Declaration);
        Assert.Equal("/a.gs", symbol.Declaration.Identifier.SyntaxTree.Text.FileName);
    }

    [Fact]
    public void ResolveLocal_InMethodBody_ResolvesAcrossMultipleFiles()
    {
        // A local inside a class method must resolve even when many other files are present.
        const string withLocal = "class CC {{\n    func M() int32 {{\n        var answer = {0}\n        return answer\n    }}\n}}\n";
        var srcA = string.Format(withLocal, "1");
        var treeA = SyntaxTree.Parse(SourceText.From(srcA, "/a.gs"));
        var treeB = SyntaxTree.Parse(SourceText.From(string.Format(withLocal, "2").Replace("CC", "DD"), "/b.gs"));

        var compilation = new Compilation(treeB, treeA);

        var off = srcA.IndexOf("return answer", StringComparison.Ordinal) + "return ".Length;
        var token = SemanticLookup.FindTokenAt(treeA, off);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        Assert.IsType<LocalVariableSymbol>(symbol);
        Assert.Equal("answer", symbol.Name);
    }
}
