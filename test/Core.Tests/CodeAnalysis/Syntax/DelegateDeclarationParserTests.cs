// <copyright file="DelegateDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0059 / issue #255: parser tests for named delegate type declarations.
/// </summary>
public class DelegateDeclarationParserTests
{
    [Fact]
    public void ParsesVoidDelegate()
    {
        const string source = "package P\ntype Greeter = delegate func(name string)\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var decl = Assert.IsType<DelegateDeclarationSyntax>(
            tree.Root.Members.First(m => m is DelegateDeclarationSyntax));
        Assert.Equal("Greeter", decl.Identifier.Text);
        Assert.Single(decl.Parameters);
        Assert.Null(decl.ReturnType);
    }

    [Fact]
    public void ParsesValueReturningDelegate()
    {
        const string source = "package P\ntype Combine = delegate func(a int32, b int32) int32\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var decl = Assert.IsType<DelegateDeclarationSyntax>(
            tree.Root.Members.First(m => m is DelegateDeclarationSyntax));
        Assert.Equal("Combine", decl.Identifier.Text);
        Assert.Equal(2, decl.Parameters.Count);
        Assert.NotNull(decl.ReturnType);
    }

    [Fact]
    public void Reports_GS0233_WhenFuncKeywordMissing()
    {
        const string source = "package P\ntype Bad = delegate int32\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0233");
    }
}
