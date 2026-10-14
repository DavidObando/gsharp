// <copyright file="Issue795DefaultExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0100 / issue #795 — parser tests for `default(T)` and the
/// bare `default` literal. Verifies both shapes surface as a
/// (cref:DefaultExpressionSyntax), that the bare form is
/// recognized in target-typed positions (let/var initializer with
/// explicit type, return, argument, ternary branch), and that the
/// existing `default` arm of a `switch`/`select` case is
/// still parsed as the arm leader rather than an expression.
open class Issue795DefaultExpressionParserTests {
    @Fact
    func Parses_DefaultOfInt32_InLetInitializer() {
        const source = "package P\nlet x int32 = default(int32)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.True(def.HasTypeClause)
        Assert.NotNull(def.OpenParenthesis)
        Assert.NotNull(def.CloseParenthesis)
        Assert.NotNull(def.TypeClause)
    }

    @Fact
    func Parses_DefaultOfGenericTypeParameter_InReturnStatement() {
        const source = `package P
func MakeZero[T]() T {
    return default(T)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.True(def.HasTypeClause)
        Assert.NotNull(def.TypeClause)
    }

    @Fact
    func Parses_BareDefault_InLetInitializerWithExplicitType() {
        const source = "package P\nlet x int32 = default"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.False(def.HasTypeClause)
        Assert.Null(def.OpenParenthesis)
        Assert.Null(def.CloseParenthesis)
        Assert.Null(def.TypeClause)
    }

    @Fact
    func Parses_BareDefault_InReturnStatement() {
        const source = `package P
func MakeZero[T]() T {
    return default
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.False(def.HasTypeClause)
    }

    @Fact
    func Parses_BareDefault_InCallArgument() {
        const source = `package P
import System
Console.WriteLine(default)`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.False(def.HasTypeClause)
    }

    @Fact
    func Parses_BareDefault_InTernaryBranch() {
        const source = "package P\nlet x = true ? 42 : default"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.False(def.HasTypeClause)
    }

    @Fact
    func Parses_DefaultOfNullable_InVariableDeclaration() {
        const source = "package P\nvar x = default(int32?)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.True(def.HasTypeClause)
    }

    @Fact
    func Parses_DefaultOfClass_PreservesSyntax() {
        const source = `package P
import System
var x = default(string)`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let def = FindFirst[DefaultExpressionSyntax](tree)
        Assert.True(def.HasTypeClause)
    }

    @Fact
    func SwitchStatement_DefaultArm_StillParses_AsArmLeader() {
        // Regression guard: the `default` arm-leader keyword of a switch
        // statement is matched in ParseSwitchCase before falling through
        // to expression parsing. This test ensures the new
        // ParseDefaultExpression dispatch does not steal the arm.
        const source = `package P
import System
switch 1 {
case 1 { Console.WriteLine("one") }
default { Console.WriteLine("other") }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let sw = FindFirst[SwitchStatementSyntax](tree)
        Assert.True(sw.Cases.Any((c SwitchCaseSyntax) -> c.IsDefault))
        // And there should be NO DefaultExpressionSyntax — the keyword
        // was consumed as the arm leader.
        Assert.Empty(Walk(tree.Root).OfType[DefaultExpressionSyntax]())
    }

    @Fact
    func SwitchExpression_DefaultArm_StillParses_AsArmLeader() {
        const source = `package P
let x = switch 1 {
case 1: "one"
default: "other"
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let sw = FindFirst[SwitchExpressionSyntax](tree)
        Assert.True(sw.Arms.Any((a SwitchExpressionArmSyntax) -> a.IsDefault))
        Assert.Empty(Walk(tree.Root).OfType[DefaultExpressionSyntax]())
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
