// <copyright file="Issue3352WhileLetParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for issue #3352 / ADR-0163.</summary>
public sealed class Issue3352WhileLetParserTests
{
    [Fact]
    public void ParsesSingleBinding()
    {
        var tree = SyntaxTree.Parse("""
            func Run(value string?) {
                while let text = value {
                    let length = text.Length
                }
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var statement = Assert.Single(Descendants(tree.Root).OfType<WhileLetStatementSyntax>());
        var binding = Assert.Single(statement.Bindings);
        Assert.Equal(SyntaxKind.WhileKeyword, statement.WhileKeyword.Kind);
        Assert.Equal("text", binding.Identifier.Text);
        Assert.Null(binding.TypeClause);
        Assert.IsType<BlockStatementSyntax>(statement.Body);
    }

    [Fact]
    public void ParsesMultipleBindingsAndTypeClauses()
    {
        var tree = SyntaxTree.Parse("""
            func Run(first string?, second string?) {
                while let a string = first, let b = second { }
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var statement = Assert.Single(Descendants(tree.Root).OfType<WhileLetStatementSyntax>());
        Assert.Equal(2, statement.Bindings.Count);
        Assert.NotNull(statement.Bindings[0].TypeClause);
        Assert.Equal("a", statement.Bindings[0].Identifier.Text);
        Assert.Equal("b", statement.Bindings[1].Identifier.Text);
    }

    [Fact]
    public void PlainAndLabeledWhileRemainUnambiguous()
    {
        var tree = SyntaxTree.Parse("""
            func Run(value string?) {
                while value != nil { break }
                retry: while let text = value { continue retry }
            }
            """);

        Assert.Empty(tree.Diagnostics);
        Assert.Single(Descendants(tree.Root).OfType<WhileStatementSyntax>());
        var labeled = Assert.Single(Descendants(tree.Root).OfType<LabeledStatementSyntax>());
        Assert.IsType<WhileLetStatementSyntax>(labeled.Statement);
    }

    [Fact]
    public void MissingInitializerReportsDiagnosticAndRecoversBody()
    {
        var tree = SyntaxTree.Parse("""
            func Run() {
                while let value = { }
                let after = 1
            }
            """);

        Assert.NotEmpty(tree.Diagnostics);
        Assert.Single(Descendants(tree.Root).OfType<WhileLetStatementSyntax>());
        Assert.Contains(
            Descendants(tree.Root).OfType<VariableDeclarationSyntax>(),
            declaration => declaration.Identifier.Text == "after");
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}
