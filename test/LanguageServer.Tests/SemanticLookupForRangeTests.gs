// <copyright file="SemanticLookupForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import System.Collections.Generic
import Xunit

open class SemanticLookupForRangeTests {
    @Fact
    func ForInLoopVariable_ResolvesInHeaderAndBody_InsideFunction() {
        const source = `func main() {
    var collectionItems = []int32{1, 2, 3}
    for loopItem in collectionItems {
        var copy = loopItem
    }
}
`
        let (compilation, tree) = Compile(source)
        let loopDeclaration SyntaxToken? = IdentifierAt(tree, "loopItem", occurrence: 1)
        let loopBodyUse SyntaxToken? = IdentifierAt(tree, "loopItem", occurrence: 2)
        let collectionDeclaration SyntaxToken? = IdentifierAt(tree, "collectionItems", occurrence: 1)
        let collectionInHeader SyntaxToken? = IdentifierAt(tree, "collectionItems", occurrence: 2)
        let declarationSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, loopDeclaration)
        let bodySymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, loopBodyUse)
        let collectionDeclarationSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, collectionDeclaration)
        let collectionHeaderSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, collectionInHeader)
        Assert.IsAssignableFrom[VariableSymbol](declarationSymbol)
        Assert.Same(declarationSymbol, bodySymbol)
        Assert.IsAssignableFrom[VariableSymbol](collectionHeaderSymbol)
        Assert.Same(collectionDeclarationSymbol, collectionHeaderSymbol)
    }

    @Fact
    func ForInLoopVariable_ResolvesInBody_AtTopLevel() {
        const source = `var collectionItems = []int32{1, 2, 3}
for loopItem in collectionItems {
    var copy = loopItem
}
`
        let (compilation, tree) = Compile(source)
        let loopDeclaration SyntaxToken? = IdentifierAt(tree, "loopItem", occurrence: 1)
        let loopBodyUse SyntaxToken? = IdentifierAt(tree, "loopItem", occurrence: 2)
        let collectionDeclaration SyntaxToken? = IdentifierAt(tree, "collectionItems", occurrence: 1)
        let collectionInHeader SyntaxToken? = IdentifierAt(tree, "collectionItems", occurrence: 2)
        let declarationSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, loopDeclaration)
        let bodySymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, loopBodyUse)
        let collectionDeclarationSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, collectionDeclaration)
        let collectionHeaderSymbol Symbol? = SemanticLookup.ResolveSymbol(compilation, collectionInHeader)
        Assert.IsAssignableFrom[VariableSymbol](declarationSymbol)
        Assert.Same(declarationSymbol, bodySymbol)
        Assert.IsAssignableFrom[VariableSymbol](collectionHeaderSymbol)
        Assert.Same(collectionDeclarationSymbol, collectionHeaderSymbol)
    }

    shared {
        private func Compile(source string)(Compilation Compilation, Tree SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return (Compilation(tree), tree)
        }

        private func IdentifierAt(tree SyntaxTree, text string, occurrence int32) SyntaxToken? {
            var seen = 0
            for token in EnumerateTokens(tree.Root) {
                if token.Kind == SyntaxKind.IdentifierToken && token.Text == text {
                    seen++
                    if seen == occurrence {
                        return token
                    }
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
                for inner in EnumerateTokens(child) {
                    yield inner
                }
            }
        }
    }
}
