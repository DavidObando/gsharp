// <copyright file="Adr0174GoBlockParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0174 D14: `go { … }` parses as a go statement whose operand is an
/// invocation of a zero-parameter function literal over the block — the same
/// shape `go func() { … }()` produces — with the block's tokens real and the
/// synthesized `func ( ) ( )` tokens zero-width at the block's edges.
open class Adr0174GoBlockParserTests {
    @Fact
    func GoBlock_ParsesAsAnInvokedLiteral() {
        let tree = SyntaxTree.Parse(`package P
let ch = chan[int32](1)
go {
    ch <- 1
}`)
        Assert.Empty(tree.Diagnostics)
        let go_ = tree.Root.DescendantNodes().OfType[GoStatementSyntax]().Single()
        let call = Assert.IsType[CallExpressionSyntax](go_.Expression)
        Assert.Empty(call.Arguments)
        let literal = Assert.IsType[FunctionLiteralExpressionSyntax](call.Callee)
        Assert.Empty(literal.Parameters)
        Assert.Null(literal.ReturnTypeClause)
        Assert.Single(literal.Body.Statements)
        Assert.Equal(0, literal.FuncKeyword.Span.Length)
        Assert.Equal(literal.Body.Span.Start, literal.FuncKeyword.Span.Start)
    }

    @Fact
    func GoCall_StillParsesAsBefore() {
        let tree = SyntaxTree.Parse(`package P
func work() {
}
go work()`)
        Assert.Empty(tree.Diagnostics)
        let go_ = tree.Root.DescendantNodes().OfType[GoStatementSyntax]().Single()
        let call = Assert.IsType[CallExpressionSyntax](go_.Expression)
        Assert.Equal("work", call.Identifier.Text)
    }
}
