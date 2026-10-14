// <copyright file="Issue1885LockStatementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1885: parser-level tests for the new `lock target { body }`
/// statement.
open class Issue1885LockStatementParserTests {
    @Fact
    func Parses_BareLock() {
        const source = `package P
var gate = 0
lock gate { gate = gate + 1 }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LockStatementSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.LockKeyword, stmt.LockKeyword.Kind)
        Assert.NotNull(stmt.Expression)
        Assert.IsType[BlockStatementSyntax](stmt.Body)
    }

    @Fact
    func Parses_LockWithSingleStatementBody() {
        const source = `package P
var gate = 0
lock gate
    gate = gate + 1`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[LockStatementSyntax]()
            .Single()
        Assert.IsType[ExpressionStatementSyntax](stmt.Body)
    }
}
