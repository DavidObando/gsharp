// <copyright file="SemanticLookupIfLetGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import Xunit

/// Issue #4961 / ADR-0200: the LSP symbol mapping (hover, definition,
/// references) for an `if let` guard. In both forms, the bound name in the
/// guard and in the then-region resolves to the binding's own symbol, and a
/// same-named outer local is what the else branch and the code after it see.
class SemanticLookupIfLetGuardTests {
    @Fact
    func Statement_GuardAndThenUses_ResolveToTheBinding_ElseAndAfterToTheOuterLocal() {
        const Source = `func Run(maybe string?) int32 {
    let value = 0
    if let value = maybe && value.Length > 0 {
        let inside = value
    } else {
        let otherwise = value
    }
    return value
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let outer Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        let guardUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        let thenUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4))
        let elseUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5))
        let afterUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 6))
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.NotSame(outer, binding)
        Assert.Same(binding, guardUse)
        Assert.Same(binding, thenUse)
        Assert.Same(outer, elseUse)
        Assert.Same(outer, afterUse)
    }

    @Fact
    func Expression_GuardAndThenUses_ResolveToTheBinding() {
        const Source = `func Run(maybe string?) int32 {
    return if let value = maybe && value.Length > 0 { value.Length } else { 0 }
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let guardUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        let thenUse Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.Same(binding, guardUse)
        Assert.Same(binding, thenUse)
    }

    @Fact
    func Statement_LaterInitializerUse_ResolvesToTheEarlierBinding() {
        const Source = `func Len(s string) int32? { return s.Length }
func Run(maybe string?) int32 {
    if let text = maybe, let n = Len(text) && n > 0 {
        return n
    }
    return 0
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "text", occurrence: 1))
        let initializerUse Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "text", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.Same(binding, initializerUse)
    }

    @Fact
    func MixedNesting_ResolvesTheInnermostBinding_InBothOrders() {
        const IfLetOutside = `func Run(outer string?, inner string?) {
    if let value = outer {
        while let value = inner {
            let use = value
            break
        }
        let after = value
    }
}`
        let first = SyntaxTree.Parse(IfLetOutside)
        let firstCompilation = Compilation(first)
        let ifBinding Symbol? = SemanticLookup.ResolveSymbol(
            firstCompilation,
            IdentifierAt(first, "value", occurrence: 1)
        )
        let whileBinding Symbol? = SemanticLookup.ResolveSymbol(
            firstCompilation,
            IdentifierAt(first, "value", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](ifBinding)
        Assert.IsAssignableFrom[VariableSymbol](whileBinding)
        Assert.NotSame(ifBinding, whileBinding)
        Assert.Same(
            whileBinding,
            SemanticLookup.ResolveSymbol(firstCompilation, IdentifierAt(first, "value", occurrence: 3))
        )
        Assert.Same(
            ifBinding,
            SemanticLookup.ResolveSymbol(firstCompilation, IdentifierAt(first, "value", occurrence: 4))
        )
        const WhileLetOutside = `func Run(outer string?, inner string?) {
    while let value = outer {
        if let value = inner {
            let use = value
        }
        let after = value
        break
    }
}`
        let second = SyntaxTree.Parse(WhileLetOutside)
        let secondCompilation = Compilation(second)
        let outerBinding Symbol? = SemanticLookup.ResolveSymbol(
            secondCompilation,
            IdentifierAt(second, "value", occurrence: 1)
        )
        let innerBinding Symbol? = SemanticLookup.ResolveSymbol(
            secondCompilation,
            IdentifierAt(second, "value", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](outerBinding)
        Assert.IsAssignableFrom[VariableSymbol](innerBinding)
        Assert.NotSame(outerBinding, innerBinding)
        Assert.Same(
            innerBinding,
            SemanticLookup.ResolveSymbol(secondCompilation, IdentifierAt(second, "value", occurrence: 3))
        )
        Assert.Same(
            outerBinding,
            SemanticLookup.ResolveSymbol(secondCompilation, IdentifierAt(second, "value", occurrence: 4))
        )
    }

    @Fact
    func NestedOrdinaryLocal_ShadowsTheBinding_InsideItsBlock() {
        const Source = `func Run(maybe string?) int32 {
    if let value = maybe {
        let before = value
        {
            let value = 1
            let inside = value
        }
    }
    return 0
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let local Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2)))
        Assert.NotSame(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4)))
        Assert.Same(local, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4)))
    }

    @Fact
    func ForInLoopVariable_InsideOrAroundTheBinding_ResolvesToTheInnermost() {
        const IfLetOutside = `func Run(maybe string?) {
    if let value = maybe {
        for value in []int32{1} {
            let use = value
        }
        let after = value
    }
}`
        let first = SyntaxTree.Parse(IfLetOutside)
        let firstCompilation = Compilation(first)
        let binding Symbol? = SemanticLookup.ResolveSymbol(
            firstCompilation,
            IdentifierAt(first, "value", occurrence: 1)
        )
        let loopVariable Symbol? = SemanticLookup.ResolveSymbol(
            firstCompilation,
            IdentifierAt(first, "value", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.IsAssignableFrom[VariableSymbol](loopVariable)
        Assert.NotSame(binding, loopVariable)
        Assert.Same(
            loopVariable,
            SemanticLookup.ResolveSymbol(firstCompilation, IdentifierAt(first, "value", occurrence: 3))
        )
        Assert.Same(
            binding,
            SemanticLookup.ResolveSymbol(firstCompilation, IdentifierAt(first, "value", occurrence: 4))
        )
        const LoopOutside = `func Run(items []string?) {
    for value in items {
        if let value = value {
            let use = value
        }
    }
}`
        let second = SyntaxTree.Parse(LoopOutside)
        let secondCompilation = Compilation(second)
        let outerLoop Symbol? = SemanticLookup.ResolveSymbol(
            secondCompilation,
            IdentifierAt(second, "value", occurrence: 1)
        )
        let innerBinding Symbol? = SemanticLookup.ResolveSymbol(
            secondCompilation,
            IdentifierAt(second, "value", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](innerBinding)
        Assert.NotSame(outerLoop, innerBinding)
        Assert.Same(
            outerLoop,
            SemanticLookup.ResolveSymbol(secondCompilation, IdentifierAt(second, "value", occurrence: 3))
        )
        Assert.Same(
            innerBinding,
            SemanticLookup.ResolveSymbol(secondCompilation, IdentifierAt(second, "value", occurrence: 4))
        )
    }

    @Fact
    func HeaderAndBlockExpressionLocals_ShadowOnlyInsideTheirOwnScope() {
        const Source = `func Run(maybe string?) int32 {
    if let value = maybe {
        if var value = 1; value > 0 {
            let inHeaderScope = value
        }
        let n = if value.Length > 0 {
            let value = 2
            value
        } else {
            0
        }
        let after = value
    }
    return 0
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let binding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        Assert.IsAssignableFrom[VariableSymbol](binding)
        // Inside the `if var value = 1; …` header scope the header local wins.
        Assert.NotSame(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3)))
        Assert.NotSame(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4)))
        // The if-expression condition is outside the branch block: still the binding.
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5)))
        // Inside the branch block expression its own local wins.
        Assert.NotSame(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 7)))
        // After both inner scopes end, the binding is back in effect.
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 8)))
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
