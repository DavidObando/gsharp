// <copyright file="Adr0174GoBlockParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0174 D14: <c>go { … }</c> parses as a go statement whose operand is an
/// invocation of a zero-parameter function literal over the block — the same
/// shape <c>go func() { … }()</c> produces — with the block's tokens real and the
/// synthesized <c>func ( ) ( )</c> tokens zero-width at the block's edges.
/// </summary>
public class Adr0174GoBlockParserTests
{
    [Fact]
    public void GoBlock_ParsesAsAnInvokedLiteral()
    {
        var tree = SyntaxTree.Parse("""
            package P
            let ch = chan[int32](1)
            go {
                ch <- 1
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var go = tree.Root.DescendantNodes().OfType<GoStatementSyntax>().Single();
        var call = Assert.IsType<CallExpressionSyntax>(go.Expression);
        Assert.Empty(call.Arguments);
        var literal = Assert.IsType<FunctionLiteralExpressionSyntax>(call.Callee);
        Assert.Empty(literal.Parameters);
        Assert.Null(literal.ReturnTypeClause);
        Assert.Single(literal.Body.Statements);
        Assert.Equal(0, literal.FuncKeyword.Span.Length);
        Assert.Equal(literal.Body.Span.Start, literal.FuncKeyword.Span.Start);
    }

    [Fact]
    public void GoCall_StillParsesAsBefore()
    {
        var tree = SyntaxTree.Parse("""
            package P
            func work() {
            }
            go work()
            """);

        Assert.Empty(tree.Diagnostics);
        var go = tree.Root.DescendantNodes().OfType<GoStatementSyntax>().Single();
        var call = Assert.IsType<CallExpressionSyntax>(go.Expression);
        Assert.Equal("work", call.Identifier.Text);
    }
}
