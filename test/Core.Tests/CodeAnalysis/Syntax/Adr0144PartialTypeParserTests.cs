// <copyright file="Adr0144PartialTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0144 / issue #2201: the <c>partial</c> contextual modifier joins the
/// existing contextual-identifier modifier family (<c>data</c>/<c>inline</c>/
/// <c>ref</c>/<c>unsafe</c>). It requires no lexer change and no new SyntaxKind,
/// and is only special inside an aggregate declaration head. It is valid on
/// <c>class</c>, <c>struct</c>, and <c>interface</c>, and rejected on
/// <c>enum</c> (GS0484). These tests pin the SYNTAX layer only.
/// </summary>
public class Adr0144PartialTypeParserTests
{
    [Fact]
    public void PartialClass_Parses_WithIsPartialSet()
    {
        const string source = "package p\npartial class C { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var classDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(classDecl.IsPartial);
    }

    [Fact]
    public void PartialStruct_Parses_WithIsPartialSet()
    {
        const string source = "package p\npartial struct S { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var structDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(structDecl.IsPartial);
    }

    [Fact]
    public void PartialInterface_Parses_WithIsPartialSet()
    {
        const string source = "package p\npartial interface I { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var interfaceDecl = root.Members.OfType<InterfaceDeclarationSyntax>().Single();
        Assert.True(interfaceDecl.IsPartial);
    }

    [Theory]
    [InlineData("package p\npublic open partial class C { }\n")]
    [InlineData("package p\npartial open class C { }\n")]
    [InlineData("package p\nopen partial class C { }\n")]
    public void PartialComposesWithClassModifiers_InAnyOrder(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var classDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(classDecl.IsPartial);
        Assert.True(classDecl.IsOpen);
    }

    [Fact]
    public void PartialComposesWithData_OnStruct()
    {
        const string source = "package p\npublic partial data struct S { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var structDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(structDecl.IsPartial);
        Assert.True(structDecl.IsData);
    }

    [Fact]
    public void NonPartialClass_HasIsPartialFalse()
    {
        const string source = "package p\nclass C { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var classDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.False(classDecl.IsPartial);
    }

    [Fact]
    public void PartialEnum_ReportsGS0484()
    {
        const string source = "package p\npartial enum E { A }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0484");
    }

    [Fact]
    public void DuplicatePartial_RecoversLikeSiblingContextualModifiers()
    {
        // `partial` is a contextual identifier modifier, so it behaves exactly
        // like the sibling `data`/`inline`/`ref`/`unsafe` modifiers on a
        // duplicate. TryDetectAggregateDeclarationHead's `saw` HashSet bails on
        // the second occurrence, so the leading `partial` is swallowed as an
        // expression statement and the trailing `partial class C { }` still
        // parses as a valid partial class — no crash, no cascade. (Cf.
        // `data data struct S { }`, which recovers identically.)
        const string source = "package p\npartial partial class C { }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var root = (CompilationUnitSyntax)tree.Root;
        var classDecl = root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(classDecl.IsPartial);
    }

    [Fact]
    public void Partial_RemainsUsableAsAnOrdinaryIdentifier()
    {
        // `partial` is contextual: it is only special inside an aggregate
        // declaration head where a trailing kind keyword disambiguates. A local
        // named `partial` must still parse cleanly.
        const string source = "package p\nimport System\nvar partial = 3\nConsole.WriteLine(partial)\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
