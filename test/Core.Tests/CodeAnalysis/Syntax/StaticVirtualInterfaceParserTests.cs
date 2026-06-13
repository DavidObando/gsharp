// <copyright file="StaticVirtualInterfaceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0089 / issue #755: parser surface tests for static-virtual
/// interface members. Verifies that the parser accepts the new
/// <c>static func</c> form inside an <c>interface</c> body for both
/// abstract (body-less) and default-body shapes, and that the syntax
/// tree carries the <c>static</c> modifier.
/// </summary>
public class StaticVirtualInterfaceParserTests
{
    [Fact]
    public void Abstract_StaticFunc_Parses()
    {
        const string source = "package P\ninterface IFoo {\n  static func F() int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Default_StaticFunc_WithBody_Parses()
    {
        const string source = "package P\ninterface IFoo {\n  static func F() int32 { return 1 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Abstract_StaticFunc_CarriesStaticModifierInSyntax()
    {
        const string source = "package P\ninterface IFoo {\n  static func F() int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IFoo");
        var method = iface.Methods.Single();
        Assert.NotNull(method.StaticModifier);
        Assert.Equal("static", method.StaticModifier!.Text);
        Assert.Null(method.Body);
    }

    [Fact]
    public void Default_StaticFunc_CarriesStaticModifierAndBody()
    {
        const string source = "package P\ninterface IFoo {\n  static func F() int32 { return 1 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IFoo");
        var method = iface.Methods.Single();
        Assert.NotNull(method.StaticModifier);
        Assert.Equal("static", method.StaticModifier!.Text);
        Assert.NotNull(method.Body);
    }

    [Fact]
    public void StaticAndInstance_Methods_CanCoexistInInterface()
    {
        const string source = """
            package P
            interface IBoth {
                static func S() int32
                func I() int32
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IBoth");
        var methods = iface.Methods.ToArray();
        Assert.Equal(2, methods.Length);
        var staticMethod = methods.Single(m => m.StaticModifier != null);
        var instanceMethod = methods.Single(m => m.StaticModifier == null);
        Assert.Equal("S", staticMethod.Identifier.Text);
        Assert.Equal("I", instanceMethod.Identifier.Text);
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
