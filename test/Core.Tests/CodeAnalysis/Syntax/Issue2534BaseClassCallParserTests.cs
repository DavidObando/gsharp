// <copyright file="Issue2534BaseClassCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Issue #2534: parser coverage for canonical <c>base.M(...)</c> calls.</summary>
public class Issue2534BaseClassCallParserTests
{
    [Fact]
    public void BaseCall_UsesDedicatedSyntax()
    {
        var tree = SyntaxTree.Parse("base.Describe()");

        Assert.Empty(tree.Diagnostics);
        var call = FindFirst<BaseClassCallExpressionSyntax>(tree.Root);
        Assert.NotNull(call);
        Assert.Equal(SyntaxKind.BaseClassCallExpression, call.Kind);
        Assert.Equal("base", call.BaseKeyword.Text);
        Assert.Equal("Describe", call.Call.Identifier.Text);
    }

    [Fact]
    public void BaseCall_ResultChain_KeepsBaseCallAsReceiver()
    {
        var tree = SyntaxTree.Parse("base.Describe().ToUpperInvariant()");

        Assert.Empty(tree.Diagnostics);
        var outer = FindFirst<AccessorExpressionSyntax>(tree.Root);
        var call = Assert.IsType<BaseClassCallExpressionSyntax>(outer.LeftPart);
        Assert.Equal("Describe", call.Call.Identifier.Text);
        Assert.Equal("ToUpperInvariant", Assert.IsType<CallExpressionSyntax>(outer.RightPart).Identifier.Text);
    }

    private static T FindFirst<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T match)
        {
            return match;
        }

        foreach (var child in root.GetChildren())
        {
            var found = FindFirst<T>(child);
            if (found != null)
            {
                return found;
            }
        }

        return null;
    }
}
