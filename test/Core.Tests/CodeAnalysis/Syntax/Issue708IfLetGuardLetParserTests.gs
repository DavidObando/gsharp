// <copyright file="Issue708IfLetGuardLetParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #708 / ADR-0071: parser-level tests for the new `if let` and
/// `guard let` binding shapes.
open class Issue708IfLetGuardLetParserTests {
    @Fact
    func Parses_BareIfLet() {
        const source = `package P
func F(s string?) {
    if let v = s { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal(SyntaxKind.IfKeyword, stmt.IfKeyword.Kind)
        Assert.Null(stmt.ElseClause)
        Assert.IsType[BlockStatementSyntax](stmt.ThenStatement)
        let binding = Assert.Single(stmt.Bindings)
        Assert.Equal(SyntaxKind.LetKeyword, binding.LetKeyword.Kind)
        Assert.Equal("v", binding.Identifier.Text)
        Assert.Null(binding.TypeClause)
    }

    @Fact
    func Parses_IfLet_WithElse() {
        const source = `package P
func F(s string?) {
    if let v = s { } else { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.NotNull(stmt.ElseClause)
        Assert.IsType[BlockStatementSyntax](stmt.ElseClause!!.ElseStatement)
    }

    @Fact
    func Parses_IfLet_WithTypeClause() {
        const source = `package P
func F(s string?) {
    if let v string = s { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        let binding = Assert.Single(stmt.Bindings)
        Assert.NotNull(binding.TypeClause)
        Assert.Equal("v", binding.Identifier.Text)
    }

    @Fact
    func Parses_IfLet_MultipleBindings() {
        const source = `package P
func F(a string?, b string?) {
    if let x = a, let y = b { } else { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal(2, stmt.Bindings.Count)
        Assert.Equal("x", stmt.Bindings[0].Identifier.Text)
        Assert.Equal("y", stmt.Bindings[1].Identifier.Text)
        Assert.NotNull(stmt.ElseClause)
    }

    @Fact
    func Parses_GuardLet() {
        const source = `package P
func F(s string?) {
    guard let v = s else {
        return
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[GuardLetStatementSyntax](tree)
        Assert.Equal(SyntaxKind.GuardKeyword, stmt.GuardKeyword.Kind)
        Assert.Equal(SyntaxKind.ElseKeyword, stmt.ElseKeyword.Kind)
        Assert.IsType[BlockStatementSyntax](stmt.ElseStatement)
        let binding = Assert.Single(stmt.Bindings)
        Assert.Equal("v", binding.Identifier.Text)
    }

    @Fact
    func Parses_GuardLet_MultipleBindings() {
        const source = `package P
func F(a string?, b string?) {
    guard let x = a, let y = b else {
        return
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[GuardLetStatementSyntax](tree)
        Assert.Equal(2, stmt.Bindings.Count)
    }

    @Fact
    func GuardLet_RequiresElseKeyword() {
        const source = `package P
func F(s string?) {
    guard let v = s {
        return
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func IfLet_RequiresInitializerExpression() {
        const source = `package P
func F() {
    if let v = { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func GuardIdentifierStillUsableAsIdentifier_IsRejected() {
        // `guard` is now a reserved keyword; using it as an identifier is
        // a parse error rather than a binder-only diagnostic.
        const source = "package P\nvar guard = 1"
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                if c is SyntaxNode sn {
                    for d in Walk(sn) {
                        yield d
                    }
                }
            }
        }
    }
}
