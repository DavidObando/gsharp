// <copyright file="Issue707WhileDoLabeledParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #707 / ADR-0070: parser-level tests for the new <c>while</c>,
/// <c>do</c>-<c>while</c>, and labeled <c>break</c>/<c>continue</c> shapes.
/// </summary>
public class Issue707WhileDoLabeledParserTests
{
    [Fact]
    public void Parses_BareWhile()
    {
        const string source = """
            package P
            var i = 0
            while i < 3 { i = i + 1 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<WhileStatementSyntax>()
            .Single();
        Assert.Equal(SyntaxKind.WhileKeyword, stmt.WhileKeyword.Kind);
        Assert.NotNull(stmt.Condition);
        Assert.IsType<BlockStatementSyntax>(stmt.Body);
    }

    [Fact]
    public void Parses_DoWhile()
    {
        const string source = """
            package P
            var i = 0
            do { i = i + 1 } while i < 3
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<DoWhileStatementSyntax>()
            .Single();
        Assert.Equal(SyntaxKind.DoKeyword, stmt.DoKeyword.Kind);
        Assert.Equal(SyntaxKind.WhileKeyword, stmt.WhileKeyword.Kind);
        Assert.IsType<BlockStatementSyntax>(stmt.Body);
        Assert.NotNull(stmt.Condition);
    }

    [Fact]
    public void Parses_LabeledFor_AndLabeledBreak()
    {
        const string source = """
            package P
            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    break outer
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        Assert.Equal("outer", labeled.LabelIdentifier.Text);
        Assert.IsType<ForClauseStatementSyntax>(labeled.Statement);
    }

    [Fact]
    public void Parses_LabeledWhile()
    {
        const string source = """
            package P
            outer: while true { break outer }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        Assert.IsType<WhileStatementSyntax>(labeled.Statement);
    }

    [Fact]
    public void Parses_LabeledDoWhile()
    {
        const string source = """
            package P
            spin: do { break spin } while true
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        Assert.IsType<DoWhileStatementSyntax>(labeled.Statement);
    }

    [Fact]
    public void Parses_BreakWithoutLabel_ProducesNullLabel()
    {
        const string source = """
            package P
            for { break }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var infinite = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<ForInfiniteStatementSyntax>()
            .Single();
        var block = Assert.IsType<BlockStatementSyntax>(infinite.Body);
        var br = Assert.IsType<BreakStatementSyntax>(block.Statements.Single());
        Assert.Null(br.LabelIdentifier);
    }

    [Fact]
    public void Parses_BreakWithLabel_AttachesIdentifier()
    {
        const string source = """
            package P
            outer: for { break outer }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        var loop = Assert.IsType<ForInfiniteStatementSyntax>(labeled.Statement);
        var block = Assert.IsType<BlockStatementSyntax>(loop.Body);
        var br = Assert.IsType<BreakStatementSyntax>(block.Statements.Single());
        Assert.NotNull(br.LabelIdentifier);
        Assert.Equal("outer", br.LabelIdentifier.Text);
    }

    [Fact]
    public void Parses_ContinueWithLabel_AttachesIdentifier()
    {
        const string source = """
            package P
            outer: for { continue outer }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        var loop = Assert.IsType<ForInfiniteStatementSyntax>(labeled.Statement);
        var block = Assert.IsType<BlockStatementSyntax>(loop.Body);
        var cn = Assert.IsType<ContinueStatementSyntax>(block.Statements.Single());
        Assert.NotNull(cn.LabelIdentifier);
        Assert.Equal("outer", cn.LabelIdentifier.Text);
    }

    [Fact]
    public void BreakLabel_OnNextLine_IsNotConsumed()
    {
        // ADR-0070: the optional label must be on the same source line as
        // the `break` keyword so we don't accidentally swallow a following
        // statement. This mirrors how `return value` is parsed.
        const string source = """
            package P
            outer: for {
                break
                outer = 0
            }
            """;
        var tree = SyntaxTree.Parse(source);

        // The follow-up `outer = 0` is malformed since `outer` is a label,
        // not a variable — but the key invariant we're asserting is that
        // `break` did *not* swallow the identifier on the next line. The
        // bound `BreakStatementSyntax` must therefore carry a null label
        // and the following statement is parsed independently.
        var labeled = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<LabeledStatementSyntax>()
            .Single();
        var loop = Assert.IsType<ForInfiniteStatementSyntax>(labeled.Statement);
        var block = Assert.IsType<BlockStatementSyntax>(loop.Body);
        var br = Assert.IsType<BreakStatementSyntax>(block.Statements.First());
        Assert.Null(br.LabelIdentifier);
    }

    [Fact]
    public void DoKeyword_IsReserved()
    {
        // ADR-0070: `do` and `while` are reserved keywords (not contextual).
        // Using `do` as an identifier inside a function fails at parse time
        // with the standard unexpected-token cascade.
        const string source = """
            package P
            func F() {
                var do = 1
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void WhileKeyword_IsReserved()
    {
        const string source = """
            package P
            func F() {
                var while = 1
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }
}
