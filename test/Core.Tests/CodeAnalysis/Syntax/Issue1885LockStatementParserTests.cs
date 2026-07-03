// <copyright file="Issue1885LockStatementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1885: parser-level tests for the new <c>lock target { body }</c>
/// statement.
/// </summary>
public class Issue1885LockStatementParserTests
{
    [Fact]
    public void Parses_BareLock()
    {
        const string source = """
            package P
            var gate = 0
            lock gate { gate = gate + 1 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LockStatementSyntax>()
            .Single();
        Assert.Equal(SyntaxKind.LockKeyword, stmt.LockKeyword.Kind);
        Assert.NotNull(stmt.Expression);
        Assert.IsType<BlockStatementSyntax>(stmt.Body);
    }

    [Fact]
    public void Parses_LockWithSingleStatementBody()
    {
        const string source = """
            package P
            var gate = 0
            lock gate
                gate = gate + 1
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LockStatementSyntax>()
            .Single();
        Assert.IsType<ExpressionStatementSyntax>(stmt.Body);
    }
}
