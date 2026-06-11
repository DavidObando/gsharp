// <copyright file="Issue708IfLetGuardLetParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #708 / ADR-0071: parser-level tests for the new <c>if let</c> and
/// <c>guard let</c> binding shapes.
/// </summary>
public class Issue708IfLetGuardLetParserTests
{
    [Fact]
    public void Parses_BareIfLet()
    {
        const string source = """
            package P
            func F(s string?) {
                if let v = s { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfLetStatementSyntax>(tree);
        Assert.Equal(SyntaxKind.IfKeyword, stmt.IfKeyword.Kind);
        Assert.Null(stmt.ElseClause);
        Assert.IsType<BlockStatementSyntax>(stmt.ThenStatement);

        var binding = Assert.Single(stmt.Bindings);
        Assert.Equal(SyntaxKind.LetKeyword, binding.LetKeyword.Kind);
        Assert.Equal("v", binding.Identifier.Text);
        Assert.Null(binding.TypeClause);
    }

    [Fact]
    public void Parses_IfLet_WithElse()
    {
        const string source = """
            package P
            func F(s string?) {
                if let v = s { } else { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfLetStatementSyntax>(tree);
        Assert.NotNull(stmt.ElseClause);
        Assert.IsType<BlockStatementSyntax>(stmt.ElseClause!.ElseStatement);
    }

    [Fact]
    public void Parses_IfLet_WithTypeClause()
    {
        const string source = """
            package P
            func F(s string?) {
                if let v string = s { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfLetStatementSyntax>(tree);
        var binding = Assert.Single(stmt.Bindings);
        Assert.NotNull(binding.TypeClause);
        Assert.Equal("v", binding.Identifier.Text);
    }

    [Fact]
    public void Parses_IfLet_MultipleBindings()
    {
        const string source = """
            package P
            func F(a string?, b string?) {
                if let x = a, let y = b { } else { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfLetStatementSyntax>(tree);
        Assert.Equal(2, stmt.Bindings.Count);
        Assert.Equal("x", stmt.Bindings[0].Identifier.Text);
        Assert.Equal("y", stmt.Bindings[1].Identifier.Text);
        Assert.NotNull(stmt.ElseClause);
    }

    [Fact]
    public void Parses_GuardLet()
    {
        const string source = """
            package P
            func F(s string?) {
                guard let v = s else {
                    return
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<GuardLetStatementSyntax>(tree);
        Assert.Equal(SyntaxKind.GuardKeyword, stmt.GuardKeyword.Kind);
        Assert.Equal(SyntaxKind.ElseKeyword, stmt.ElseKeyword.Kind);
        Assert.IsType<BlockStatementSyntax>(stmt.ElseStatement);

        var binding = Assert.Single(stmt.Bindings);
        Assert.Equal("v", binding.Identifier.Text);
    }

    [Fact]
    public void Parses_GuardLet_MultipleBindings()
    {
        const string source = """
            package P
            func F(a string?, b string?) {
                guard let x = a, let y = b else {
                    return
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<GuardLetStatementSyntax>(tree);
        Assert.Equal(2, stmt.Bindings.Count);
    }

    [Fact]
    public void GuardLet_RequiresElseKeyword()
    {
        const string source = """
            package P
            func F(s string?) {
                guard let v = s {
                    return
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void IfLet_RequiresInitializerExpression()
    {
        const string source = """
            package P
            func F() {
                if let v = { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void GuardIdentifierStillUsableAsIdentifier_IsRejected()
    {
        // `guard` is now a reserved keyword; using it as an identifier is
        // a parse error rather than a binder-only diagnostic.
        const string source = """
            package P
            var guard = 1
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        return Walk(tree.Root).OfType<T>().First();
    }

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var c in node.GetChildren())
        {
            if (c is SyntaxNode sn)
            {
                foreach (var d in Walk(sn))
                {
                    yield return d;
                }
            }
        }
    }
}
