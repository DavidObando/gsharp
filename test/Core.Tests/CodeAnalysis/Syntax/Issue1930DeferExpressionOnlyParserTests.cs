// <copyright file="Issue1930DeferExpressionOnlyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1930: the cs2gs code model/printer used to emit <c>defer { … }</c>
/// (a block body) while <c>Parser.ParseDeferStatement</c> only ever accepted
/// a single expression operand, per ADR-0030 ("Add <c>defer call(arg1,
/// arg2, …)</c> as a statement"). The fix keeps the parser as the source of
/// truth — a single call-expression operand — and updates the cs2gs code
/// model/printer to match instead of teaching the parser a statement-body
/// form. Issue #3355 later made a trailing-value block an expression in its
/// own right; that remains within defer's expression-only contract.
/// </summary>
public class Issue1930DeferExpressionOnlyParserTests
{
    [Fact]
    public void Parses_DeferWithCallExpression()
    {
        const string source = """
            package P
            func cleanup() { }
            {
                defer cleanup()
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var deferStmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<BlockStatementSyntax>()
            .SelectMany(b => b.Statements)
            .OfType<DeferStatementSyntax>()
            .Single();
        Assert.Equal(SyntaxKind.DeferKeyword, deferStmt.DeferKeyword.Kind);
        Assert.IsType<CallExpressionSyntax>(deferStmt.Expression);
    }

    [Fact]
    public void Parses_DeferWithBlockExpressionOperand()
    {
        const string source = """
            package P
            {
                defer {
                    let value = cleanup()
                    value
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var deferStmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<BlockStatementSyntax>()
            .SelectMany(b => b.Statements)
            .OfType<DeferStatementSyntax>()
            .Single();
        Assert.IsType<BlockExpressionSyntax>(deferStmt.Expression);
    }
}
