// <copyright file="EventParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0052: parser tests for event declaration syntax.
/// </summary>
public class EventParserTests
{
    [Fact]
    public void ParsesFieldLikeEvent()
    {
        const string source = "package P\nimport System\ntype Foo class {\n  event Click func(Object, EventArgs)\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesFieldLikeEvent_WithAccessibility()
    {
        const string source = "package P\nimport System\ntype Foo class {\n  public event Click func(Object, EventArgs)\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_WithExplicitAccessors()
    {
        const string source = "package P\nimport System\ntype Foo class {\n  event Changed func() {\n    add { }\n    remove { }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_OnInterface()
    {
        const string source = "package P\ntype INotify interface {\n  event Changed func()\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_WithOpenModifier()
    {
        const string source = "package P\ntype Base open class {\n  public open event Notify func()\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesMultipleEvents()
    {
        const string source = "package P\ntype Foo class {\n  event A func()\n  event B func(int32)\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void EventDeclaration_HasCorrectSyntaxKind()
    {
        const string source = "package P\ntype Foo class {\n  event Click func()\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(structDecl.Events);
        Assert.Equal(SyntaxKind.EventDeclaration, structDecl.Events[0].Kind);
        Assert.Equal("Click", structDecl.Events[0].Identifier.Text);
    }
}
