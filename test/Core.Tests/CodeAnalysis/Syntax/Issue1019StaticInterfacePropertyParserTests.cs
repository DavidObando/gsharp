// <copyright file="Issue1019StaticInterfacePropertyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0089 / issue #1019: parser surface tests for static-virtual interface
/// *properties*. Verifies that the parser accepts a <c>prop</c> declaration
/// inside an interface <c>shared { … }</c> block in the bare, get-only, and
/// get/set forms, and marks it with the <c>shared</c> static modifier.
/// </summary>
public class Issue1019StaticInterfacePropertyParserTests
{
    [Fact]
    public void BareStaticProperty_Parses()
    {
        const string source = "package P\ninterface IData {\n  shared {\n    prop Name string;\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GetOnlyStaticProperty_Parses()
    {
        const string source = "package P\ninterface IData {\n  shared {\n    prop SizeInBytes int32 { get; }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GetSetStaticProperty_Parses()
    {
        const string source = "package P\ninterface IData {\n  shared {\n    prop Tag int32 { get; set }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void StaticProperty_CarriesStaticModifierInSyntax()
    {
        const string source = "package P\ninterface IData {\n  shared {\n    prop Name string { get; }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IData");
        var prop = iface.Properties.Single();
        Assert.True(prop.HasStaticModifier);
        Assert.Equal("shared", prop.StaticModifier!.Text);
        Assert.Equal("Name", prop.Identifier.Text);
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
