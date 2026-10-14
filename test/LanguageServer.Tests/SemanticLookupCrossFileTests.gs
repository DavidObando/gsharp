// <copyright file="SemanticLookupCrossFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import System
import Xunit

/// Regression tests for cross-file symbol resolution. Syntax spans are per-file offsets, so
/// in a multi-file compilation the SemanticModel's span-based lookups
/// (FindContainingFunction, ResolveImplicitThisMember) must restrict themselves to the token's
/// own tree. Before that guard, a declaration in another file whose offset range overlapped the
/// token's offset would shadow the real one, causing hover / go-to-definition / completion on
/// locals and implicit-this members to resolve to the wrong file or to nothing.
open class SemanticLookupCrossFileTests {
    @Fact
    func ResolveImplicitThisProperty_PicksDeclarationFromTokensOwnFile() {
        let srcA = string.Format(Template, "AA")
        let treeA = SyntaxTree.Parse(SourceText.From(srcA, "/a.gs"))
        let treeB = SyntaxTree.Parse(SourceText.From(string.Format(Template, "BB"), "/b.gs"))
        // Put B first so a cross-file collision would resolve the token to B.
        let compilation = Compilation(treeB, treeA)
        let off = srcA.IndexOf("return Width", StringComparison.Ordinal) + "return ".Length
        let token SyntaxToken? = SemanticLookup.FindTokenAt(treeA, off)
        let symbol PropertySymbol? = SemanticLookup.ResolveSymbol(compilation, token) as PropertySymbol
        Assert.NotNull(symbol)
        Assert.NotNull(symbol!!.Declaration)
        Assert.Equal("/a.gs", symbol!!.Declaration!!.Identifier.SyntaxTree.Text.FileName)
    }

    @Fact
    func ResolveLocal_InMethodBody_ResolvesAcrossMultipleFiles() {
        // A local inside a class method must resolve even when many other files are present.
        const withLocal = `class CC {{
    func M() int32 {{
        var answer = {0}
        return answer
    }}
}}
`
        let srcA = string.Format(withLocal, "1")
        let treeA = SyntaxTree.Parse(SourceText.From(srcA, "/a.gs"))
        let treeB = SyntaxTree.Parse(SourceText.From(string.Format(withLocal, "2").Replace("CC", "DD"), "/b.gs"))
        let compilation = Compilation(treeB, treeA)
        let off = srcA.IndexOf("return answer", StringComparison.Ordinal) + "return ".Length
        let token SyntaxToken? = SemanticLookup.FindTokenAt(treeA, off)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        Assert.IsType[LocalVariableSymbol](symbol)
        Assert.Equal("answer", symbol!!.Name)
    }

    shared {
        // Two structurally identical classes in two files: `Width` sits at the same offset in both,
        // and their method bodies share the same span — so a non-tree-scoped lookup can pick the
        // wrong file's type.
        private const Template string = `class {0} {{
    prop Width int32
    func M() int32 {{
        return Width
    }}
}}
`
    }
}
