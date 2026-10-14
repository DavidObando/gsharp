// <copyright file="Issue707WhileDoLabeledParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #707 / ADR-0070: parser-level tests for the new `while`,
/// `do`-`while`, and labeled `break`/`continue` shapes.
open class Issue707WhileDoLabeledParserTests {
    @Fact
    func Parses_BareWhile() {
        const source = `package P
var i = 0
while i < 3 { i = i + 1 }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[WhileStatementSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.WhileKeyword, stmt.WhileKeyword.Kind)
        Assert.NotNull(stmt.Condition)
        Assert.IsType[BlockStatementSyntax](stmt.Body)
    }

    @Fact
    func Parses_DoWhile() {
        const source = `package P
var i = 0
do { i = i + 1 } while i < 3`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[DoWhileStatementSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.DoKeyword, stmt.DoKeyword.Kind)
        Assert.Equal(SyntaxKind.WhileKeyword, stmt.WhileKeyword.Kind)
        Assert.IsType[BlockStatementSyntax](stmt.Body)
        Assert.NotNull(stmt.Condition)
    }

    @Fact
    func Parses_LabeledFor_AndLabeledBreak() {
        const source = `package P
outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        break outer
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        Assert.Equal("outer", labeled.LabelIdentifier.Text)
        Assert.IsType[ForClauseStatementSyntax](labeled.Statement)
    }

    @Fact
    func Parses_LabeledWhile() {
        const source = "package P\nouter: while true { break outer }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        Assert.IsType[WhileStatementSyntax](labeled.Statement)
    }

    @Fact
    func Parses_LabeledDoWhile() {
        const source = "package P\nspin: do { break spin } while true"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        Assert.IsType[DoWhileStatementSyntax](labeled.Statement)
    }

    @Fact
    func Parses_BreakWithoutLabel_ProducesNullLabel() {
        const source = "package P\nfor { break }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let infinite = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[ForInfiniteStatementSyntax]()
            .Single()
        let block = Assert.IsType[BlockStatementSyntax](infinite.Body)
        let br = Assert.IsType[BreakStatementSyntax](block.Statements.Single())
        Assert.Null(br.LabelIdentifier)
    }

    @Fact
    func Parses_BreakWithLabel_AttachesIdentifier() {
        const source = "package P\nouter: for { break outer }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        let loop = Assert.IsType[ForInfiniteStatementSyntax](labeled.Statement)
        let block = Assert.IsType[BlockStatementSyntax](loop.Body)
        let br = Assert.IsType[BreakStatementSyntax](block.Statements.Single())
        Assert.NotNull(br.LabelIdentifier)
        Assert.Equal("outer", br.LabelIdentifier!!.Text)
    }

    @Fact
    func Parses_ContinueWithLabel_AttachesIdentifier() {
        const source = "package P\nouter: for { continue outer }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        let loop = Assert.IsType[ForInfiniteStatementSyntax](labeled.Statement)
        let block = Assert.IsType[BlockStatementSyntax](loop.Body)
        let cn = Assert.IsType[ContinueStatementSyntax](block.Statements.Single())
        Assert.NotNull(cn.LabelIdentifier)
        Assert.Equal("outer", cn.LabelIdentifier!!.Text)
    }

    @Fact
    func BreakLabel_OnNextLine_IsNotConsumed() {
        // ADR-0070: the optional label must be on the same source line as
        // the `break` keyword so we don't accidentally swallow a following
        // statement. This mirrors how `return value` is parsed.
        const source = `package P
outer: for {
    break
    outer = 0
}`
        let tree = SyntaxTree.Parse(source)
        // The follow-up `outer = 0` is malformed since `outer` is a label,
        // not a variable — but the key invariant we're asserting is that
        // `break` did *not* swallow the identifier on the next line. The
        // bound `BreakStatementSyntax` must therefore carry a null label
        // and the following statement is parsed independently.
        let labeled = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LabeledStatementSyntax]()
            .Single()
        let loop = Assert.IsType[ForInfiniteStatementSyntax](labeled.Statement)
        let block = Assert.IsType[BlockStatementSyntax](loop.Body)
        let br = Assert.IsType[BreakStatementSyntax](block.Statements.First())
        Assert.Null(br.LabelIdentifier)
    }

    @Fact
    func DoKeyword_IsReserved() {
        // ADR-0070: `do` and `while` are reserved keywords (not contextual).
        // Using `do` as an identifier inside a function fails at parse time
        // with the standard unexpected-token cascade.
        const source = `package P
func F() {
    var do = 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func WhileKeyword_IsReserved() {
        const source = `package P
func F() {
    var while = 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }
}
