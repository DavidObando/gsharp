// <copyright file="Issue818AnonymousFunctionTypeVariadicParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #818 — parser-level tests for variadic parameters in anonymous
/// function-type clauses `(T1, ...T2) -> R`, including the legacy
/// `func(T1, ...T2) R` spelling and the async arrow form
/// `async (T1, ...T2) -> R`. ADR-0102 deferred this site in #812;
/// ADR-0102 follow-up #818 closes the gap.
open class Issue818AnonymousFunctionTypeVariadicParserTests {
    @Fact
    func Parses_Variadic_OnArrowFunctionType_TrailingParameter() {
        const source = "package P\nvar f (int32, ...string) -> int32 = (a, args) -> a"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsArrowFunction)
        Assert.Equal(2, clause.FunctionParameterTypes!!.Count)
        Assert.False(clause.IsParameterVariadic(0))
        Assert.True(clause.IsParameterVariadic(1))
        Assert.Equal("string", clause.FunctionParameterTypes!![1].Identifier!!.Text)
        Assert.Equal(2, clause.FunctionParameterEllipsisTokens.Length)
        Assert.Null(clause.FunctionParameterEllipsisTokens[0])
        Assert.NotNull(clause.FunctionParameterEllipsisTokens[1])
        Assert.Equal(SyntaxKind.EllipsisToken, clause.FunctionParameterEllipsisTokens[1]!!.Kind)
    }

    @Fact
    func Parses_Variadic_OnArrowFunctionType_SingleParameter() {
        const source = "package P\nvar f (...int32) -> int32 = (xs) -> 0"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.Single(clause.FunctionParameterTypes!!)
        Assert.True(clause.IsParameterVariadic(0))
        Assert.Equal("int32", clause.FunctionParameterTypes!![0].Identifier!!.Text)
    }

    @Fact
    func Parses_Variadic_OnAsyncArrowFunctionType() {
        const source = "package P\nvar f async (int32, ...string) -> int32 = async (a, args) -> a"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First(
            (t TypeClauseSyntax) -> t.IsAsyncFunction && t.IsArrowFunction
        )
        Assert.True(clause.IsAsyncFunction)
        Assert.Equal(2, clause.FunctionParameterTypes!!.Count)
        Assert.False(clause.IsParameterVariadic(0))
        Assert.True(clause.IsParameterVariadic(1))
    }

    @Fact
    func Parses_Variadic_OnLegacyFuncTypeClause() {
        const source = "package P\nvar f func(int32, ...string) int32 = (a, args) -> a"
        let tree = SyntaxTree.Parse(source)
        // legacy func() emits a GS0303 deprecation warning but it should still parse.
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.IsError)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsLegacyFuncFunction)
        Assert.True(clause.IsLegacyFuncFunction)
        Assert.Equal(2, clause.FunctionParameterTypes!!.Count)
        Assert.False(clause.IsParameterVariadic(0))
        Assert.True(clause.IsParameterVariadic(1))
    }

    @Fact
    func Parses_Variadic_InFieldTypeClause() {
        const source = `package P
class Box {
  var Handler (int32, ...string) -> int32
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsParameterVariadic(1))
    }

    @Fact
    func Parses_Variadic_InMethodReturnTypeClause() {
        const source = "package P\nfunc Make() (int32, ...string) -> int32 { return (a, args) -> a }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsParameterVariadic(1))
    }

    @Fact
    func Parses_Variadic_InNestedFunctionType() {
        // Outer is a non-variadic function whose parameter is itself a
        // variadic anonymous function-type.
        const source = "package P\nvar f ((int32, ...string) -> int32) -> int32 = (g) -> 0"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let arrows = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        Assert.True(arrows.Count >= 2)
        // The inner arrow clause is the one with two parameter types.
        let inner = arrows.First((a TypeClauseSyntax) -> a.FunctionParameterTypes!!.Count == 2)
        Assert.False(inner.IsParameterVariadic(0))
        Assert.True(inner.IsParameterVariadic(1))
    }

    @Fact
    func Parses_NonVariadic_HasEmptyEllipsisArray() {
        const source = "package P\nvar f (int32, string) -> int32 = (a, b) -> a"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.False(clause.IsParameterVariadic(0))
        Assert.False(clause.IsParameterVariadic(1))
    }

    shared {
        private func FindAll[T SyntaxNode](tree SyntaxTree) IEnumerable[T] -> Walk(tree.Root).OfType[T]()

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                if child is SyntaxNode n {
                    for inner in Walk(n) {
                        yield inner
                    }
                }
            }
        }
    }
}
