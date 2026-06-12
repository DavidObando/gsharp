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
        const string source = "package P\nimport System\nclass Foo {\n  event Click (Object, EventArgs) -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesFieldLikeEvent_WithAccessibility()
    {
        const string source = "package P\nimport System\nclass Foo {\n  public event Click (Object, EventArgs) -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_WithExplicitAccessors()
    {
        const string source = "package P\nimport System\nclass Foo {\n  event Changed () -> void {\n    add { }\n    remove { }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_OnInterface()
    {
        const string source = "package P\ninterface INotify {\n  event Changed () -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesEvent_WithOpenModifier()
    {
        const string source = "package P\nopen class Base {\n  public open event Notify () -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesMultipleEvents()
    {
        const string source = "package P\nclass Foo {\n  event A () -> void\n  event B (int32) -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void EventDeclaration_HasCorrectSyntaxKind()
    {
        const string source = "package P\nclass Foo {\n  event Click () -> void\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(structDecl.Events);
        Assert.Equal(SyntaxKind.EventDeclaration, structDecl.Events[0].Kind);
        Assert.Equal("Click", structDecl.Events[0].Identifier.Text);
    }

    [Fact]
    public void ParsesEvent_WithRaiseAccessor()
    {
        const string source = "package P\nclass Foo {\n  event Changed () -> void {\n    add { }\n    remove { }\n    raise { }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var ev = structDecl.Events[0];
        Assert.Equal(3, ev.Accessors.Length);
        Assert.True(ev.Accessors[2].IsRaise);
    }

    [Fact]
    public void ParsesEvent_RaiseAccessorOnly_WithAddRemove()
    {
        const string source = "package P\nclass Foo {\n  event Notify (int32) -> void {\n    add { }\n    remove { }\n    raise { }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var ev = structDecl.Events[0];
        Assert.Single(ev.Accessors.Where(a => a.IsAdd));
        Assert.Single(ev.Accessors.Where(a => a.IsRemove));
        Assert.Single(ev.Accessors.Where(a => a.IsRaise));
    }
}
