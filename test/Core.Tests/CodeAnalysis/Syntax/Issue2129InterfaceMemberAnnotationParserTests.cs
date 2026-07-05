// <copyright file="Issue2129InterfaceMemberAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #2129: the interface-member parse loop had no branch for a leading
/// <c>@</c> annotation, so an attribute applied to an interface property
/// (or event / method signature) fell through to the recovery arm and
/// reported GS0005 (<c>Unexpected token &lt;AtToken&gt;, expected
/// &lt;FuncKeyword&gt;</c>) — even though the identical attribute parses on a
/// class member. These tests verify that Kotlin-style <c>@annotations</c>
/// (ADR-0047) now parse without diagnostics on all three interface member
/// kinds and are attached to the produced syntax node.
/// </summary>
public class Issue2129InterfaceMemberAnnotationParserTests
{
    [Fact]
    public void AnnotationOnInterfaceProperty_ParsesWithoutDiagnostics()
    {
        const string Source = "package P\ninterface IPerson {\n  @Note(\"asin\")\n  prop Asin string\n}\n";
        var tree = SyntaxTree.Parse(Source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IPerson");
        var prop = iface.Properties.Single();
        Assert.Equal("Asin", prop.Identifier.Text);
        var annotation = Assert.Single(prop.Annotations);
        Assert.Equal("Note", annotation.NameSegments.Single().Text);
    }

    [Fact]
    public void AnnotationOnInterfaceEvent_ParsesWithoutDiagnostics()
    {
        const string Source = "package P\ninterface IPerson {\n  @Note(\"evt\")\n  event Changed Action\n}\n";
        var tree = SyntaxTree.Parse(Source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IPerson");
        var ev = iface.Events.Single();
        Assert.Equal("Changed", ev.Identifier.Text);
        Assert.Single(ev.Annotations);
    }

    [Fact]
    public void AnnotationOnInterfaceMethodSignature_ParsesWithoutDiagnostics()
    {
        const string Source = "package P\ninterface IPerson {\n  @Note(\"greet\")\n  func Greet() string;\n}\n";
        var tree = SyntaxTree.Parse(Source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IPerson");
        var method = iface.Methods.Single();
        Assert.Equal("Greet", method.Identifier.Text);
        Assert.Single(method.Annotations);
    }

    [Fact]
    public void MultipleAnnotationsOnInterfaceMembers_ParseWithoutDiagnostics()
    {
        const string Source =
            "package P\ninterface IPerson {\n"
            + "  @Note(\"a\")\n  @Note(\"b\")\n  prop Asin string\n"
            + "  @Note(\"c\")\n  func Greet() string;\n}\n";
        var tree = SyntaxTree.Parse(Source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IPerson");
        Assert.Equal(2, iface.Properties.Single().Annotations.Length);
        Assert.Single(iface.Methods.Single().Annotations);
    }

    private static InterfaceDeclarationSyntax FindInterface(SyntaxTree tree, string name)
    {
        var root = (CompilationUnitSyntax)tree.Root;
        foreach (var member in root.Members)
        {
            if (member is InterfaceDeclarationSyntax iface
                && iface.Identifier.Text == name)
            {
                return iface;
            }
        }

        throw new Xunit.Sdk.XunitException($"interface {name} not found");
    }
}
