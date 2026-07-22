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
    public void AutoPropertyInDataStruct_Parses()
    {
        const string source = "package P\ndata struct P {\n  var X int32\n  prop Y int32\n}\n";
        var tree = SyntaxTree.Parse(source);

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
    public void FatArrowGetter_ReportsDiagnostic()
    {
        // Issue #1273: G# has no fat-arrow `=>` expression-bodied accessor (that
        // is C# syntax). `get => e` must be a syntax error, not silently
        // accepted or desugared.
        const string source = "package P\nclass Foo {\n  prop X int32 { get => 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void ArrowGetter_ParsesCleanly()
    {
        // Issue #1278 / ADR-0131: the G# lambda arrow `->` is now a valid
        // accessor expression-body form: `get -> e` desugars to `{ return e }`.
        const string source = "package P\nclass Foo {\n  prop X int32 { get -> 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ArrowGetterAndSetter_ParseCleanly()
    {
        // Issue #1278 / ADR-0131: `get -> e` and `set -> e` are expression-bodied
        // accessors; a setter body may use the implicit `value` parameter.
        const string source = "package P\nclass Foo {\n  var n int32\n  prop X int32 { get -> this.n set -> this.n = value }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void PropertyLevelArrow_ParsesCleanly()
    {
        // Issue #1278 / ADR-0131: `prop Name T -> expr` is an expression-bodied
        // read-only property that desugars to a single get-only accessor.
        const string source = "package P\nclass Foo {\n  var n int32\n  prop Doubled int32 -> this.n * 2\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var propDecl = structDecl.Properties.Single();
        var accessor = Assert.Single(propDecl.Accessors);
        Assert.True(accessor.IsGetter);
        Assert.NotNull(accessor.Body);
    }

    [Fact]
    public void IndexerLevelArrow_ParsesCleanly()
    {
        // Issue #1278 / ADR-0131: `prop this[i T] U -> expr` is an
        // expression-bodied read-only indexer.
        const string source = "package P\nclass Repo {\n  var data []int32\n  prop this[i int32] int32 -> this.data[i]\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void FatArrowSetter_ReportsDiagnostic()
    {
        // Issue #1273: `set => e` is rejected just like the fat-arrow getter.
        const string source = "package P\nclass Foo {\n  var n int32\n  prop X int32 { get { return this.n } set => this.n = value }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void FatArrowGetterOnInterface_ReportsDiagnostic()
    {
        // Issue #1273: the rejection applies on interfaces too.
        const string source = "package P\ninterface I {\n  prop X int32 { get => 5 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void BlockBodiedAndBareAccessors_ParseCleanly()
    {
        // Issue #1273: a block body and a bare (auto) accessor remain the only
        // valid accessor forms and parse without diagnostics.
        const string source = "package P\nclass Foo {\n  var n int32\n  prop X int32 { get { return this.n } set(v) { this.n = v } }\n  prop Y int32 { get; set; }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
