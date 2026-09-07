// <copyright file="Issue4080ForClauseBraceExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #4080: a C-style <c>for</c> condition is terminated by its second
/// semicolon, so braces inside that expression must not be mistaken for the
/// loop body.
/// </summary>
public sealed class Issue4080ForClauseBraceExpressionParserTests
{
    [Fact]
    public void EmptyPropertyPatternInConditionParsesBeforeSemicolon()
    {
        const string source = """
            package p
            class Node { var Next Node? }
            class C {
                func F(current Node) {
                    for var steps = 0; steps < 64 && current.Next is { } next; steps++ {
                        current = next
                    }
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var statement = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        var pattern = Descendants(statement.Condition).OfType<PropertyPatternSyntax>().Single();
        Assert.Empty(pattern.Fields);
        Assert.Equal("next", pattern.Designation?.Text);
        Assert.IsType<BlockStatementSyntax>(statement.Body);
    }

    [Fact]
    public void ObjectInitializerInConditionParsesBeforeSemicolon()
    {
        const string source = """
            package p
            class Box { var Value int32 }
            class C {
                func F() {
                    for var i = 0; Box() { Value = i }.Value < 4; i++ { }
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var statement = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.Contains(Descendants(statement.Condition), node => node is ObjectCreationExpressionSyntax);
        Assert.IsType<BlockStatementSyntax>(statement.Body);
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode? node)
    {
        if (node == null)
        {
            yield break;
        }

        foreach (var child in node.GetChildren())
        {
            yield return child;
            foreach (var descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}
