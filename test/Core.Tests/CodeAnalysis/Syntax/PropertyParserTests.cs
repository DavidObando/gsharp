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
        const string source = "package P\nclass Foo {\n  prop Name string\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesReadOnlyAutoProperty()
    {
        const string source = "package P\nclass Foo {\n  prop X int32 { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesFullProperty_WithGetAndSetBodies()
    {
        const string source = "package P\nclass Foo {\n  prop X int32 { get { return 0 } set(v) { } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesInterfaceProperty()
    {
        const string source = "package P\ninterface Named {\n  prop Name string { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyWithPrivateAccessibility()
    {
        const string source = "package P\nclass Foo {\n  private prop secret int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesOpenProperty()
    {
        const string source = "package P\nopen class Foo {\n  open prop X int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesOverrideProperty()
    {
        const string source = "package P\nopen class Base {\n  open prop X int32\n}\nclass D : Base {\n  override prop X int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesMultipleProperties()
    {
        const string source = "package P\nclass Person {\n  prop Name string\n  prop Age int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyWithGetAndSet_NoBody()
    {
        const string source = "package P\nclass Foo {\n  prop X int32 { get; set; }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesPropertyOnInterface_GetAndSet()
    {
        const string source = "package P\ninterface Mutable {\n  prop Value int32 { get set }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AutoPropertyInDataStruct_ParsesButBinderReportsGS0189()
    {
        // The parser accepts prop in data struct; the binder reports GS0189.
        const string source = "package P\ndata struct P {\n  var X int32\n  prop Y int32\n}\n";
        var tree = SyntaxTree.Parse(source);

        // Parser should not fail — diagnostic comes from binder.
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void PropertyDeclaration_HasCorrectSyntaxKind()
    {
        const string source = "package P\nclass Foo {\n  prop Name string\n}\n";
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
        const string source = "package P\nclass Foo {\n  prop X int32 { get }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        Assert.Single(propDecl.Accessors);
        Assert.True(propDecl.Accessors[0].IsGetter);
    }

    [Fact]
    public void ParsesGetOnlyIndexerDeclaration()
    {
        // ADR-0118 / issue #944: `prop this[i int32] T { get {...} }`.
        const string source = "package P\nclass Repo {\n  prop this[index int32] int32 { get { return 0 } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ParsesGetSetIndexerDeclaration()
    {
        const string source = "package P\nclass Repo {\n  prop this[index int32] int32 { get { return 0 } set { } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void IndexerDeclaration_IsMarkedAsIndexer()
    {
        const string source = "package P\nclass Repo {\n  prop this[index int32] int32 { get { return 0 } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        Assert.True(propDecl.IsIndexer);
        Assert.Single(propDecl.Parameters);
        Assert.Equal("index", propDecl.Parameters[0].Identifier.Text);
    }

    [Fact]
    public void IndexerDeclaration_OnGenericClass_Parses()
    {
        const string source = "package P\nclass Repo[T] {\n  prop this[index int32] T { get { return _items[index] } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(structDecl.Properties.Single().IsIndexer);
    }

    [Fact]
    public void NonIndexerProperty_IsNotMarkedAsIndexer()
    {
        const string source = "package P\nclass Foo {\n  prop Name string\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        Assert.False(propDecl.IsIndexer);
        Assert.Empty(propDecl.Parameters);
    }
}
