// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public class Issue4219GenericLocalRecursionTests
{
    [Fact]
    public void Formatting_PreservesConsecutiveGenericDeclarationRegion()
    {
        const string source = "let first[T]=func(x T,n int32) T {return second[T](x,n)}\n// sibling\nlet second[U]=func(x U,n int32) U {if n==0{return x}\nreturn first(x,n-1)}\n";
        var before = SyntaxTree.Parse(source);
        Assert.Empty(before.Diagnostics);
        var formatted = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(formatted.Diagnostics);
        var after = SyntaxTree.Parse(formatted.Text!);
        Assert.Empty(after.Diagnostics);
        Assert.Equal(Tokens(before.Root), Tokens(after.Root));
        Assert.False(GSharpFormatter.Format(formatted.Text!).Changed);
    }

    private static string[] Tokens(SyntaxNode node)
        => node is SyntaxToken token
            ? new[] { token.Kind + ":" + token.Text }
            : node.GetChildren().SelectMany(Tokens).ToArray();
}
