// <copyright file="Issue3785MixedInitializerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class Issue3785MixedInitializerFormattingTests
{
    [Theory]
    [InlineData("let x=Bag(){.Capacity:10,1,...rows,.Tag:2,}\n")]
    [InlineData("let x=Bag[int32](4){...rows,key:2,\"c\":3,[key]=4,.Capacity:10,}\n")]
    [InlineData("let x=Node(){.Name:\"root\",Node(){.Name:\"child\"},}\n")]
    [InlineData("let x=Node{Width:1,Child(),...rows,Height:2,}\n")]
    [InlineData("let x=Target{...source,Name:\"override\",}\n")]
    public void Formatting_PreservesEveryTokenAndIsIdempotent(string source)
    {
        var before = SyntaxTree.Parse(source);
        Assert.Empty(before.Diagnostics);
        var formatted = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(formatted.Diagnostics);
        var after = SyntaxTree.Parse(formatted.Text!);
        Assert.Empty(after.Diagnostics);
        Assert.Equal(Tokens(before.Root), Tokens(after.Root));

        var twice = GSharpFormatter.Format(formatted.Text!);
        Assert.Empty(twice.Diagnostics);
        Assert.False(twice.Changed);
        Assert.Equal(formatted.Text!.ToString(), twice.Text!.ToString());
    }

    private static string[] Tokens(SyntaxNode node)
        => node is SyntaxToken token
            ? new[] { token.Kind + ":" + token.Text }
            : node.GetChildren().SelectMany(Tokens).ToArray();
}
