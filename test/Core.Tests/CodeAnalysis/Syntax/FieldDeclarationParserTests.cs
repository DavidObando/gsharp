// <copyright file="FieldDeclarationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0067 / issue #694: parser tests for the `var`/`let` requirement on
/// field declarations inside type bodies.
/// </summary>
public class FieldDeclarationParserTests
{
    [Fact]
    public void ParsesVarField()
    {
        const string source = "package P\nclass Counter {\n  var Value int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var field = Assert.Single(structDecl.Fields);
        Assert.Equal("Value", field.Identifier.Text);
        Assert.False(field.IsReadOnly);
        Assert.NotNull(field.VarOrLetKeyword);
        Assert.Equal(SyntaxKind.VarKeyword, field.VarOrLetKeyword.Kind);
    }

    [Fact]
    public void ParsesVarField_WithInitializer()
    {
        const string source = "package P\nclass Counter {\n  var Value int32 = 0\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var field = Assert.Single(structDecl.Fields);
        Assert.False(field.IsReadOnly);
        Assert.NotNull(field.Initializer);
    }

    [Fact]
    public void ParsesLetField()
    {
        const string source = "package P\nclass Counter {\n  let Name string\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var field = Assert.Single(structDecl.Fields);
        Assert.Equal("Name", field.Identifier.Text);
        Assert.True(field.IsReadOnly);
        Assert.Equal(SyntaxKind.LetKeyword, field.VarOrLetKeyword.Kind);
    }

    [Fact]
    public void ParsesLetField_WithInitializer()
    {
        const string source = "package P\nclass Counter {\n  let Name string = \"x\"\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var field = Assert.Single(structDecl.Fields);
        Assert.True(field.IsReadOnly);
        Assert.NotNull(field.Initializer);
    }

    [Fact]
    public void ParsesVarField_WithAccessibility()
    {
        const string source = "package P\nclass Counter {\n  public var Value int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var field = Assert.Single(structDecl.Fields);
        Assert.NotNull(field.AccessibilityModifier);
        Assert.Equal("public", field.AccessibilityModifier.Text);
        Assert.False(field.IsReadOnly);
    }

    [Fact]
    public void BareField_ReportsGS0288()
    {
        const string source = "package P\nclass Counter {\n  Value int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        var diagnostic = Assert.Single(tree.Diagnostics);
        Assert.Equal("GS0288", diagnostic.Id);
        Assert.Contains("var", diagnostic.Message);
        Assert.Contains("let", diagnostic.Message);
    }

    [Fact]
    public void BareField_WithAccessibility_ReportsGS0288()
    {
        const string source = "package P\nclass Counter {\n  public Value int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        var diagnostic = Assert.Single(tree.Diagnostics);
        Assert.Equal("GS0288", diagnostic.Id);
    }

    [Fact]
    public void ParsesMixedVarAndLetFields()
    {
        const string source = "package P\nclass Counter {\n  var Mutable int32\n  let Constant string = \"x\"\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Equal(2, structDecl.Fields.Length);
        Assert.False(structDecl.Fields[0].IsReadOnly);
        Assert.True(structDecl.Fields[1].IsReadOnly);
    }

    [Fact]
    public void ParsesVarField_InStruct()
    {
        const string source = "package P\nstruct Point {\n  var X int32\n  var Y int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Equal(2, structDecl.Fields.Length);
    }

    [Fact]
    public void ParsesVarField_InSharedBlock()
    {
        const string source = "package P\nclass Counter {\n  shared {\n    var Instances int32 = 0\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
