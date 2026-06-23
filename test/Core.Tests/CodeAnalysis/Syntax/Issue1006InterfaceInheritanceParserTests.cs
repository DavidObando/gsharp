// <copyright file="Issue1006InterfaceInheritanceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1006: an <c>interface</c> may declare one or more base interfaces via
/// a <c>: A, B</c> clause directly after the identifier, mirroring
/// <c>interface B : A</c> in C#. Before this change the parser rejected the
/// colon with GS0005 (unexpected token, expected <c>{</c>). These tests pin the
/// parser-level shape: the base-interface clause is captured on
/// <see cref="InterfaceDeclarationSyntax.BaseTypeClauses"/> with no diagnostics.
/// </summary>
public class Issue1006InterfaceInheritanceParserTests
{
    [Fact]
    public void InterfaceSingleBase_ParsesWithoutDiagnostics()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var b = tree.Root.Members.OfType<InterfaceDeclarationSyntax>().Single(i => i.Identifier.Text == "B");
        Assert.True(b.HasBaseInterfaces);
        Assert.Equal(1, b.BaseTypeClauses.Count);
        Assert.Equal("A", b.BaseTypeClauses[0].Identifier.Text);
    }

    [Fact]
    public void InterfaceMultipleBases_ParsesWithoutDiagnostics()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface C { func H() int32; }
            interface B : A, C { func G() int32; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var b = tree.Root.Members.OfType<InterfaceDeclarationSyntax>().Single(i => i.Identifier.Text == "B");
        Assert.True(b.HasBaseInterfaces);
        Assert.Equal(2, b.BaseTypeClauses.Count);
        Assert.Equal("A", b.BaseTypeClauses[0].Identifier.Text);
        Assert.Equal("C", b.BaseTypeClauses[1].Identifier.Text);
    }

    [Fact]
    public void InterfaceWithoutBase_HasNoBaseClause()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var a = tree.Root.Members.OfType<InterfaceDeclarationSyntax>().Single();
        Assert.False(a.HasBaseInterfaces);
        Assert.Equal(0, a.BaseTypeClauses.Count);
    }
}
