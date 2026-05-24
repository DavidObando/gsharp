// <copyright file="EnumDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Phase 6.8 parser coverage for <c>type Name enum { ... }</c> declarations.
/// </summary>
public class EnumDeclarationParserTests
{
    [Fact]
    public void EnumDeclaration_ParsesMembers()
    {
        var tree = SyntaxTree.Parse("type Color enum { Red, Green, Blue }");

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members.OfType<EnumDeclarationSyntax>().Single();
        Assert.Equal("Color", declaration.Identifier.Text);
        Assert.Equal(3, declaration.Members.Count);
        Assert.Equal("Red", declaration.Members[0].Identifier.Text);
        Assert.Equal("Green", declaration.Members[1].Identifier.Text);
        Assert.Equal("Blue", declaration.Members[2].Identifier.Text);
    }

    [Fact]
    public void EnumDeclaration_AllowsTrailingComma()
    {
        var tree = SyntaxTree.Parse("type Color enum { Red, Green, Blue, }");

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members.OfType<EnumDeclarationSyntax>().Single();
        Assert.Equal(3, declaration.Members.Count);
    }

    [Fact]
    public void EnumDeclaration_EmptyBody_Diagnoses()
    {
        var tree = SyntaxTree.Parse("type Color enum { }");

        Assert.Contains(tree.Diagnostics, d => d.Message.Contains("must declare at least one member", System.StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("data")]
    [InlineData("open")]
    [InlineData("sealed")]
    public void EnumDeclaration_IllegalModifiers_Diagnose(string modifier)
    {
        var tree = SyntaxTree.Parse($"type Color {modifier} enum {{ Red }}");

        Assert.NotEmpty(tree.Diagnostics);
    }
}
