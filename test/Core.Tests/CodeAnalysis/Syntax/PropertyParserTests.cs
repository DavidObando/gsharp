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

    [Fact]
    public void ParsesAutoInitProperty()
    {
        // Issue #946: `{ get; init; }` bodyless init accessor.
        const string source = "package P\nclass Foo {\n  prop Name string { get; init; }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        Assert.Equal(2, propDecl.Accessors.Length);
        Assert.True(propDecl.Accessors[0].IsGetter);
        Assert.True(propDecl.Accessors[1].IsInit);
        Assert.True(propDecl.Accessors[1].IsSetterOrInit);
        Assert.False(propDecl.Accessors[1].IsSetter);
    }

    [Fact]
    public void ParsesInitProperty_WithBody()
    {
        // Issue #946: `init { ... }` accessor with a block body.
        const string source = "package P\nclass Foo {\n  var raw int32\n  prop X int32 { get { return raw } init { raw = value } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        var initAccessor = propDecl.Accessors.Single(a => a.IsInit);
        Assert.NotNull(initAccessor.Body);
    }

    [Fact]
    public void ParsesInitProperty_WithExplicitParameterName()
    {
        // Issue #946: `init(v) { ... }` mirrors `set(v) { ... }`.
        const string source = "package P\nclass Foo {\n  var raw int32\n  prop X int32 { get { return raw } init(v) { raw = v } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        var initAccessor = propDecl.Accessors.Single(a => a.IsInit);
        Assert.Equal("v", initAccessor.ParameterIdentifier.Text);
    }

    [Fact]
    public void InitConstructor_NotConfusedWithInitAccessor()
    {
        // Issue #946: `init(...)` at member level is still a constructor, not a
        // property accessor; both coexist in one class.
        const string source = "package P\nclass Foo {\n  prop Name string { get; init; }\n  init(name string) {\n    this.Name = name\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(structDecl.Constructors);
        var propDecl = structDecl.Properties.Single();
        Assert.True(propDecl.Accessors.Single(a => a.IsInit).IsInit);
    }

    [Fact]
    public void ParsesExpressionBodiedGetter_NoDiagnostics()
    {
        // Issue #1270: `prop P T { get => e }` is an expression-bodied getter.
        const string source = "package P\nclass Foo {\n  prop X int32 { get => 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ExpressionBodiedGetter_DesugarsToBlockWithReturn()
    {
        // Issue #1270: the parser desugars `get => e` into a synthesized block
        // `{ return e }` so binding/emit reuse the existing accessor-body path.
        const string source = "package P\nclass Foo {\n  prop X int32 { get => 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var accessor = structDecl.Properties.Single().Accessors.Single();
        Assert.True(accessor.IsGetter);
        Assert.NotNull(accessor.Body);
        var statement = Assert.Single(accessor.Body.Statements);
        Assert.IsType<ReturnStatementSyntax>(statement);
    }

    [Fact]
    public void ExpressionBodiedSetter_DesugarsToBlockWithExpressionStatement()
    {
        // Issue #1270: a `set => e` desugars to `{ e }` (an expression
        // statement), NOT an implicit return, because the setter is void.
        const string source = "package P\nclass Foo {\n  var n int32\n  prop X int32 { get => this.n  set => this.n = value }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var setter = structDecl.Properties.Single().Accessors.Single(a => a.IsSetter);
        Assert.NotNull(setter.Body);
        var statement = Assert.Single(setter.Body.Statements);
        Assert.IsType<ExpressionStatementSyntax>(statement);
    }

    [Fact]
    public void ParsesExpressionBodiedGetterOnInterface_NoDiagnostics()
    {
        // Issue #1270: default interface getter via expression body.
        const string source = "package P\ninterface I {\n  prop X int32 { get => 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
