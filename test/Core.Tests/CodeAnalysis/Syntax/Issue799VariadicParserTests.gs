// <copyright file="Issue799VariadicParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0101 / issue #799 — parser tests for variadic parameters. The
/// canonical G# spelling is `name ...T` (Go-style: the `...`
/// token sits between the parameter identifier and the element type);
/// inside the function body the parameter has type `[]T`. The
/// parser surfaces this through (cref:ParameterSyntax.EllipsisToken)
/// and the derived (cref:ParameterSyntax.IsVariadic) predicate.
/// The C# `params` keyword is intentionally rejected with GS0363
/// guiding the user at the canonical spelling.
open class Issue799VariadicParserTests {
    @Fact
    func Parses_VariadicParameter_OnTopLevelFunction() {
        const source = "package P\nfunc sum(nums ...int32) int32 { return 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
        Assert.NotNull(p.EllipsisToken)
        Assert.Equal(SyntaxKind.EllipsisToken, p.EllipsisToken!!.Kind)
        Assert.Equal("nums", p.Identifier!!.Text)
    }

    @Fact
    func Parses_VariadicAfterFixedParameters() {
        const source = "package P\nfunc f(a int32, b string, xs ...int32) int32 { return 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let func_ = FindFirst[FunctionDeclarationSyntax](tree)
        let parameters = func_.Parameters.ToList()
        Assert.Equal(3, parameters.Count)
        Assert.False(parameters[0].IsVariadic)
        Assert.False(parameters[1].IsVariadic)
        Assert.True(parameters[2].IsVariadic)
        Assert.Equal("xs", parameters[2].Identifier!!.Text)
    }

    @Fact
    func Parses_VariadicWithGenericElementType() {
        const source = "package P\nfunc Of[T](values ...T) []T { return values }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let func_ = FindFirst[FunctionDeclarationSyntax](tree)
        Assert.True(func_.Parameters.Single().IsVariadic)
    }

    @Fact
    func NonVariadicParameter_HasNullEllipsis() {
        const source = "package P\nfunc f(a int32) int32 { return a }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.False(p.IsVariadic)
        Assert.Null(p.EllipsisToken)
    }

    @Fact
    func ParamsKeyword_IsRejected_WithGS0363() {
        // The issue repro spelled the C# form `params values []T`. The G#
        // parser emits GS0363 pointing the user at the canonical `...T`
        // form and recovers by consuming the keyword.
        const source = "package P\nfunc bad(params values []int32) int32 { return 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0363")
    }

    @Fact
    func ParamsAsParameterName_RequiresNoFollowingIdentifier() {
        // `params` is contextual: the keyword interpretation only fires
        // when the next token is also an IdentifierToken. A parameter
        // literally named `params` parses cleanly when its type is a
        // non-identifier (e.g. a `[]T` slice or `T?` nullable) — the same
        // disambiguation rule applies to `scoped` / `ref` / `out` / `in`.
        const source = "package P\nfunc f(params []int32) int32 { return 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.Equal("params", p.Identifier!!.Text)
        Assert.False(p.IsVariadic)
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T -> Walk(tree.Root).OfType[T]().First()

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
