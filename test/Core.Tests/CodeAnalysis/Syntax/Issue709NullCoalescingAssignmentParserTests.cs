// <copyright file="Issue709NullCoalescingAssignmentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #709 / ADR-0072: parser-level coverage for the new
/// <c>??=</c> null-coalescing compound assignment statement.
/// </summary>
public class Issue709NullCoalescingAssignmentParserTests
{
    private static NullCoalescingAssignmentStatementSyntax GetSingleAssignmentInBlock(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // The parser wraps a top-level `??=` statement in a GlobalStatement.
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<NullCoalescingAssignmentStatementSyntax>()
            .Single();
        return stmt;
    }

    [Fact]
    public void Parses_LocalVariable_LHS()
    {
        const string source = """
            package P
            var x string? = nil
            x ??= "v"
            """;
        var stmt = GetSingleAssignmentInBlock(source);
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, stmt.OperatorToken.Kind);
        Assert.IsType<NameExpressionSyntax>(stmt.Target);
        Assert.NotNull(stmt.Value);
    }

    [Fact]
    public void Parses_MemberField_LHS()
    {
        const string source = """
            package P
            import System
            class Box {
                var Name string?
            }
            func main() {
                var b = Box{}
                b.Name ??= "v"
            }
            main()
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fnBody = tree.Root.Members
            .OfType<FunctionDeclarationSyntax>()
            .Single(f => f.Identifier.Text == "main")
            .Body;
        var stmt = fnBody.Statements
            .OfType<NullCoalescingAssignmentStatementSyntax>()
            .Single();
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, stmt.OperatorToken.Kind);
        Assert.IsType<AccessorExpressionSyntax>(stmt.Target);
    }

    [Fact]
    public void Parses_Indexer_LHS()
    {
        const string source = """
            package P
            import System
            func main() {
                var m = map[string,string?]{}
                m["k"] ??= "v"
            }
            main()
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fnBody = tree.Root.Members
            .OfType<FunctionDeclarationSyntax>()
            .Single(f => f.Identifier.Text == "main")
            .Body;
        var stmt = fnBody.Statements
            .OfType<NullCoalescingAssignmentStatementSyntax>()
            .Single();
        Assert.IsType<IndexExpressionSyntax>(stmt.Target);
    }

    [Fact]
    public void Parses_RhsAsExpression()
    {
        // RHS may be any expression — ensure precedence works out so that
        // `a ??= b ?: c` parses as `a ??= (b ?: c)` (the `?:` is a
        // higher-precedence binary expression bound left-to-right).
        const string source = """
            package P
            var x string? = nil
            var y string? = nil
            x ??= y ?: "fallback"
            """;
        var stmt = GetSingleAssignmentInBlock(source);
        Assert.NotNull(stmt.Value);
        Assert.IsNotType<NullCoalescingAssignmentStatementSyntax>(stmt.Value);
    }

    [Fact]
    public void Reports_Diagnostic_OnBareQuestionQuestion_WithoutEquals()
    {
        // G# does not introduce a bare `??` token; the lexer emits two
        // `?` tokens. Parsing `a ?? b` as a statement must surface at
        // least one parser diagnostic instead of silently accepting it.
        const string source = """
            package P
            var x string? = nil
            x ?? "v"
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }
}
