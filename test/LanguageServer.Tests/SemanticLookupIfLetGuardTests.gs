// <copyright file="SemanticLookupIfLetGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import Xunit

/// Issue #4961 / ADR-0201: the LSP symbol mapping (hover, definition,
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

    @Fact
    func PatternVariables_ShadowTheBinding_OnlyInsideTheirStatement() {
        const Source = `func Use(x object) { }
func Nested(maybe string?, obj object) {
    if let value = maybe {
        if obj is int32 value {
            Use(value)
        }
        Use(value)
    }
}
func StatementGuard(maybe string?, obj object) {
    if let value = maybe && obj is int32 value {
        Use(value)
    }
}
func ExpressionGuard(maybe string?, obj object) int32 {
    return if let value = maybe && obj is string value { value.Length } else { 0 }
}`
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let firstBinding Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let nestedPattern Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "value", occurrence: 2)
        )
        Assert.IsAssignableFrom[VariableSymbol](firstBinding)
        Assert.IsAssignableFrom[VariableSymbol](nestedPattern)
        Assert.NotSame(firstBinding, nestedPattern)
        // Inside the nested `if`, the pattern variable; after it, the binding.
        Assert.Same(
            nestedPattern,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        )
        Assert.Same(firstBinding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4)))
        // A guard's pattern variable is what the then-region sees, in both forms.
        let statementBinding Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "value", occurrence: 5)
        )
        let guardPattern Symbol? = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 6))
        Assert.IsAssignableFrom[VariableSymbol](guardPattern)
        Assert.NotSame(statementBinding, guardPattern)
        Assert.Same(guardPattern, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 7)))
        let expressionBinding Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "value", occurrence: 8)
        )
        let expressionPattern Symbol? = SemanticLookup.ResolveSymbol(
            compilation,
            IdentifierAt(tree, "value", occurrence: 9)
        )
        Assert.IsAssignableFrom[VariableSymbol](expressionPattern)
        Assert.NotSame(expressionBinding, expressionPattern)
        Assert.Same(
            expressionPattern,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 10))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PatternFlowAndTupleLoops_SelectTheBoundSymbol(expressionForm bool) {
        let prefix = if expressionForm {
            "return "
        } else {
            ""
        }
        let tail = if expressionForm {
            "value.Length"
        } else {
            "return value.Length"
        }
        let otherwise = if expressionForm {
            "0"
        } else {
            "return 0"
        }
        let source = `func Use(x object) { }
func Run(maybe string?, obj object, pairs [](int32, int32)) int32 {
    PREFIXif let value = maybe {
        if obj !is int32 value {
            Use(value)
        } else {
            Use(value)
        }
        let nested = if obj is int32 value { value } else { value.Length }
        for (value, score) in pairs {
            Use(value)
        }
        Use(value)
        TAIL
    } else { OTHERWISE }
}`.Replace("PREFIX", prefix).Replace("TAIL", tail).Replace("OTHERWISE", otherwise)
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let binding = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let negativePattern = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        let positivePattern = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 5))
        let tupleLocal = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 8))
        Assert.IsAssignableFrom[VariableSymbol](binding)
        Assert.IsAssignableFrom[VariableSymbol](negativePattern)
        Assert.IsAssignableFrom[VariableSymbol](positivePattern)
        Assert.IsAssignableFrom[VariableSymbol](tupleLocal)
        Assert.NotSame(binding, negativePattern)
        Assert.NotSame(binding, positivePattern)
        Assert.NotSame(binding, tupleLocal)
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3)))
        Assert.Same(
            negativePattern,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4))
        )
        Assert.Same(
            positivePattern,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 6))
        )
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 7)))
        Assert.Same(tupleLocal, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 9)))
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 10)))
        Assert.Same(binding, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 11)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func GuardDelegateCallee_ResolvesThePatternVariable(expressionForm bool) {
        let prefix = if expressionForm {
            "return "
        } else {
            ""
        }
        let tail = if expressionForm {
            "1"
        } else {
            "return 1"
        }
        let otherwise = if expressionForm {
            "0"
        } else {
            "return 0"
        }
        let source = `import System
func Run(maybe string?, obj object) int32 {
    PREFIXif let value = maybe && obj is Action value {
        value()
        TAIL
    } else { OTHERWISE }
}`.Replace("PREFIX", prefix).Replace("TAIL", tail).Replace("OTHERWISE", otherwise)
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let binding = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let pattern = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        Assert.IsAssignableFrom[VariableSymbol](pattern)
        Assert.NotSame(binding, pattern)
        Assert.Same(pattern, SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ScriptBinding_DoesNotReplaceTheFunctionBindingDeclaration(expressionBody bool) {
        let function = if expressionBody {
            `func Run(s string?) string -> if let value = s { value } else { "" }`
        } else {
            `func Run(s string?) {
    if let value = s {
        let local = value
    }
}`
        }
        let source = function + `
let maybe string? = "script"
if let value = maybe {
    let script = value
}`
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let functionBinding = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 1))
        let scriptBinding = SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 3))
        Assert.IsAssignableFrom[VariableSymbol](functionBinding)
        Assert.IsAssignableFrom[VariableSymbol](scriptBinding)
        Assert.NotSame(functionBinding, scriptBinding)
        Assert.Same(
            functionBinding,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 2))
        )
        Assert.Same(
            scriptBinding,
            SemanticLookup.ResolveSymbol(compilation, IdentifierAt(tree, "value", occurrence: 4))
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
