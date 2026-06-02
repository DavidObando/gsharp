// <copyright file="DocumentationAttacherTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0057 §7: Tests the position-based attachment of doc blocks to declarations.
/// </summary>
public class DocumentationAttacherTests
{
    [Fact]
    public void DocAttaches_ToImmediatelyFollowingFunction()
    {
        var source = "/// Adds two numbers.\nfunc Add(a int32, b int32) int32 { return a + b }";
        var tree = SyntaxTree.Parse(source);
        var funcDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(funcDecl);
        Assert.Equal("Adds two numbers.", doc);
    }

    [Fact]
    public void MultiLineDoc_ConcatenatesLines()
    {
        var source = "/// Line one.\n/// Line two.\nfunc Foo() {}";
        var tree = SyntaxTree.Parse(source);
        var funcDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(funcDecl);
        Assert.Contains("Line one.", doc);
        Assert.Contains("Line two.", doc);
    }

    [Fact]
    public void GapBetweenDocAndDeclaration_NoAttachment()
    {
        // A blank line between doc and declaration breaks attachment
        var source = "/// Orphan doc.\n\nfunc Foo() {}";
        var tree = SyntaxTree.Parse(source);
        var funcDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(funcDecl);
        Assert.Null(doc);
    }

    [Fact]
    public void NoDocComment_ReturnsNull()
    {
        var source = "func Bar() {}";
        var tree = SyntaxTree.Parse(source);
        var funcDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(funcDecl);
        Assert.Null(doc);
    }

    [Fact]
    public void RegularComment_DoesNotAttach()
    {
        var source = "// Not a doc comment\nfunc Baz() {}";
        var tree = SyntaxTree.Parse(source);
        var funcDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(funcDecl);
        Assert.Null(doc);
    }

    [Fact]
    public void MultipleFunctions_EachGetsOwnDoc()
    {
        var source = "/// Doc for A.\nfunc A() {}\n/// Doc for B.\nfunc B() {}";
        var tree = SyntaxTree.Parse(source);
        var a = tree.Root.Members[0];
        var b = tree.Root.Members[1];
        Assert.Equal("Doc for A.", tree.GetDocumentation(a));
        Assert.Equal("Doc for B.", tree.GetDocumentation(b));
    }

    [Fact]
    public void DocOnEnum_Attaches()
    {
        var source = "/// My enum.\ntype Color enum { Red, Green, Blue }";
        var tree = SyntaxTree.Parse(source);
        var enumDecl = tree.Root.Members[0];
        var doc = tree.GetDocumentation(enumDecl);
        Assert.Equal("My enum.", doc);
    }
}
