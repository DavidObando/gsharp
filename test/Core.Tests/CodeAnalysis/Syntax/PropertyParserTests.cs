// <copyright file="PropertyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0051 Phase 8: parser tests for property declaration syntax.
/// Validates that various property forms are accepted without diagnostics.
/// </summary>
public class PropertyParserTests
{
    [Fact]
    public void ParsesAutoProperty()
    {
        const string source = "package P\ntype Foo class {\n  prop Name string\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesReadOnlyAutoProperty()
    {
        const string source = "package P\ntype Foo class {\n  prop X int32 { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesFullProperty_WithGetAndSetBodies()
    {
        const string source = "package P\ntype Foo class {\n  prop X int32 { get { return 0 } set(v) { } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesInterfaceProperty()
    {
        const string source = "package P\ntype Named interface {\n  prop Name string { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyWithPrivateAccessibility()
    {
        const string source = "package P\ntype Foo class {\n  private prop secret int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesOpenProperty()
    {
        const string source = "package P\ntype Foo open class {\n  open prop X int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesOverrideProperty()
    {
        const string source = "package P\ntype Base open class {\n  open prop X int32\n}\ntype D class : Base {\n  override prop X int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesMultipleProperties()
    {
        const string source = "package P\ntype Person class {\n  prop Name string\n  prop Age int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyWithGetAndSet_NoBody()
    {
        const string source = "package P\ntype Foo class {\n  prop X int32 { get; set; }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyOnInterface_GetAndSet()
    {
        const string source = "package P\ntype Mutable interface {\n  prop Value int32 { get set }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AutoPropertyInDataStruct_ParsesButBinderReportsGS0189()
    {
        // The parser accepts prop in data struct; the binder reports GS0189.
        const string source = "package P\ntype P data struct {\n  var X int32\n  prop Y int32\n}\n";
        var tree = SyntaxTree.Parse(source);

        // Parser should not fail — diagnostic comes from binder.
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void PropertyDeclaration_HasCorrectSyntaxKind()
    {
        const string source = "package P\ntype Foo class {\n  prop Name string\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(structDecl.Properties);
        Assert.Equal(SyntaxKind.PropertyDeclaration, structDecl.Properties[0].Kind);
        Assert.Equal("Name", structDecl.Properties[0].Identifier.Text);
    }

    [Fact]
    public void ReadOnlyProperty_HasGetAccessor()
    {
        const string source = "package P\ntype Foo class {\n  prop X int32 { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        Assert.Single(propDecl.Accessors);
        Assert.True(propDecl.Accessors[0].IsGetter);
    }
}
