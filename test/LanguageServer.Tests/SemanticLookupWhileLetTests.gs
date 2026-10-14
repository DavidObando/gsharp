// <copyright file="SemanticLookupWhileLetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import System.Collections.Generic
import Xunit

/// LSP symbol mapping coverage for issue #3352.
class SemanticLookupWhileLetTests {
    @Fact
    func BindingDeclarationAndBodyUseResolveToSameSymbol() {
        const Source = `func Run(maybe string?) {
    while let value = maybe {
        let copy = value
        break
    }
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let declaration SyntaxToken? = IdentifierAt(tree, "value", occurrence: 1)
        let bodyUse SyntaxToken? = IdentifierAt(tree, "value", occurrence: 2)
        let declarationSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, declaration)
        let bodySymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, bodyUse)
        Assert.IsAssignableFrom[VariableSymbol](declarationSymbol)
        Assert.Same(declarationSymbol, bodySymbol)
    }

    @Fact
    func BindingScopeShadowsAndThenRestoresOuterLocal() {
        const Source = `func Run(maybe string?) {
    let value string? = maybe
    while let value = value {
        let inside = value
    }
    let after = value
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let outer Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        let initializerUse Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "value", occurrence: 3)
        )
        let bodyUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4))
        let afterUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5))
        Assert.NotSame(outer, binding)
        Assert.Same(outer, initializerUse)
        Assert.Same(binding, bodyUse)
        Assert.Same(outer, afterUse)
    }

    @Fact
    func NestedBindingsResolveToInnermostLoop() {
        const Source = `func Run(outerMaybe string?, innerMaybe string?) {
    while let value = outerMaybe {
        let before = value
        while let value = innerMaybe {
            let inside = value
        }
        let after = value
    }
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let outer Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let before Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        let inner Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        let inside Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4))
        let after Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5))
        Assert.Same(outer, before)
        Assert.NotSame(outer, inner)
        Assert.Same(inner, inside)
        Assert.Same(outer, after)
    }

    @Fact
    func BindingResolvesInsideInterpolationHole() {
        const Source = `func Run(maybe string?) {
    while let value = maybe {
        let message = "value=${value}"
        break
    }
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let declaration SyntaxToken? = IdentifierAt(tree, "value", occurrence: 1)
        let holeUse SyntaxToken? = IdentifierAt(tree, "value", occurrence: 2)
        Assert.Same(
            SemanticLookup.ResolveSymbol(compilation, declaration),
            SemanticLookup.ResolveSymbol(compilation, holeUse)
        )
    }

    shared {
        private func IdentifierAt(tree SyntaxTree, text string, occurrence int32) SyntaxToken? {
            var seen = 0
            for token in EnumerateTokens(tree.Root) {
                if token.Kind == SyntaxKind.IdentifierToken && token.Text == text && (seen += 1) == occurrence {
                    return token
                }
            }
            return nil
        }

        private func EnumerateTokens(node SyntaxNode) sequence[SyntaxToken] {
            if node is SyntaxToken token {
                yield token
                yield break
            }
            for child in node.GetChildren() {
                for childToken in EnumerateTokens(child) {
                    yield childToken
                }
            }
        }
    }
}
