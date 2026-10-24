// <copyright file="SemanticLookupSpanFallbackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import Xunit

/// Exercises the (file, span) fallback inside `SemanticLookup.SemanticModel.Resolve`.
///
/// The compilation's declarations dictionary is keyed by (cref:SyntaxToken) reference
/// equality. When a caller hands in a token from a different parse of the same file (for
/// example, a cached DocumentContent that has not yet been refreshed after a project-wide
/// reparse), reference equality fails. Top-level names recover via the globals dictionary,
/// but type members have no name-based fallback — so the span-based lookup is what keeps
/// hover, find-references, rename, and CodeLens working through such desyncs.
open class SemanticLookupSpanFallbackTests {
    @Fact
    func Resolve_StaleMemberToken_RecoversViaSpanFallback() {
        let (compilation, staleTree) = BuildDesyncedCompilation()
        let nameToken SyntaxToken? = FindFirstIdentifier(staleTree, "Name")
        Assert.NotNull(nameToken)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, nameToken)
        Assert.NotNull(resolved)
        Assert.Equal("Name", resolved!!.Name)
    }

    @Fact
    func Resolve_StaleMemberToken_FindsDeclaration() {
        let (compilation, staleTree) = BuildDesyncedCompilation()
        let nameToken SyntaxToken? = FindFirstIdentifier(staleTree, "Name")
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, nameToken)
        Assert.NotNull(symbol)
        // FindReferences must return at least the declaration; the exact reference count
        // depends on binder behaviour and is covered by FindReferences-specific tests.
        var refCount = 0
        for _ in SemanticLookup.FindReferences(compilation, symbol!!) {
            refCount++
        }
        Assert.True(refCount >= 1, "Expected at least the declaration, got $refCount.")
    }

    @Fact
    func Resolve_StaleLocalAndParameterTokens_RecoverThroughTheMatchingTree() {
        // A local and a parameter have no declaration-token entry: their stale tokens resolve
        // through the compilation's tree of the same file and text, not to a same-named global.
        let (compilation, staleTree) = BuildDesyncedCompilation()
        let parameterUse SyntaxToken? = FindLastIdentifier(staleTree, "prefix")
        let localUse SyntaxToken? = FindLastIdentifier(staleTree, "greeting")
        let parameter Symbol? = SemanticLookup.ResolveSymbol(compilation, parameterUse)
        let local Symbol? = SemanticLookup.ResolveSymbol(compilation, localUse)
        Assert.IsType[ParameterSymbol](parameter)
        Assert.IsType[LocalVariableSymbol](local)
    }

    @Fact
    func Resolve_FreshMemberToken_StillResolvesByReference() {
        let sourceText = SourceText.From(Source, FilePath)
        let tree = SyntaxTree.Parse(sourceText)
        let compilation = Compilation(tree)
        let nameToken SyntaxToken? = FindFirstIdentifier(tree, "Name")
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, nameToken)
        Assert.NotNull(resolved)
        Assert.Equal("Name", resolved!!.Name)
    }

    shared {
        private const Source string = "package Temp\n" +
            "\n" +
            "class Person {\n" +
            "    public prop Name string\n" +
            "    public prop Age int32\n" +
            "\n" +
            "    func ToString() string {\n" +
            "        return \"Name: $${Name}\"\n" +
            "    }\n" +
            "\n" +
            "    func Greet(prefix string) string {\n" +
            "        let greeting = prefix + Name\n" +
            "        return greeting\n" +
            "    }\n" +
            "}\n"
        private const FilePath string = "/virtual/Program.gs"

        private func BuildDesyncedCompilation()(Compilation Compilation, StaleTree SyntaxTree) {
            let freshText = SourceText.From(Source, FilePath)
            let freshTree = SyntaxTree.Parse(freshText)
            let compilation = Compilation(freshTree)
            // A second parse of the identical source produces a tree whose SyntaxToken instances
            // do not reference-equal anything in the compilation's declarations dictionary. This
            // is the situation a stale DocumentContent leaves callers in.
            let staleText = SourceText.From(Source, FilePath)
            let staleTree = SyntaxTree.Parse(staleText)
            return (compilation, staleTree)
        }

        private func FindFirstIdentifier(tree SyntaxTree, text string) SyntaxToken? {
            for token in EnumerateTokens(tree.Root) {
                if token.Kind == SyntaxKind.IdentifierToken && token.Text == text {
                    return token
                }
            }
            return nil
        }

        private func FindLastIdentifier(tree SyntaxTree, text string) SyntaxToken? {
            var found SyntaxToken? = nil
            for token in EnumerateTokens(tree.Root) {
                if token.Kind == SyntaxKind.IdentifierToken && token.Text == text {
                    found = token
                }
            }
            return found
        }

        private func EnumerateTokens(node SyntaxNode) sequence[SyntaxToken] {
            for child in node.GetChildren() {
                if child is SyntaxToken token {
                    yield token
                } else {
                    for nested in EnumerateTokens(child) {
                        yield nested
                    }
                }
            }
        }
    }
}
