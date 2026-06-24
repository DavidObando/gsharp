// <copyright file="StaticVirtualInterfaceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0089 / issue #755 (issue #865 revision): parser surface tests for
/// static-virtual interface members. Verifies that the parser accepts the
/// <c>shared { … }</c> form inside an <c>interface</c> body for both abstract
/// (body-less) and default-body shapes, that the syntax tree marks those
/// methods as static, and that the removed <c>static func</c> modifier form is
/// rejected.
/// </summary>
public class StaticVirtualInterfaceParserTests
{
    [Fact]
    public void Abstract_SharedFunc_Parses()
    {
        const string source = "package P\ninterface IFoo {\n  shared {\n    func F() int32;\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Default_SharedFunc_WithBody_Parses()
    {
        const string source = "package P\ninterface IFoo {\n  shared {\n    func F() int32 { return 1 }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Abstract_SharedFunc_CarriesStaticModifierInSyntax()
    {
        const string source = "package P\ninterface IFoo {\n  shared {\n    func F() int32;\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IFoo");
        var method = iface.Methods.Single();
        Assert.True(method.HasStaticModifier);
        Assert.Equal("shared", method.StaticModifier!.Text);
        Assert.Null(method.Body);
    }

    [Fact]
    public void Default_SharedFunc_CarriesStaticModifierAndBody()
    {
        const string source = "package P\ninterface IFoo {\n  shared {\n    func F() int32 { return 1 }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IFoo");
        var method = iface.Methods.Single();
        Assert.True(method.HasStaticModifier);
        Assert.Equal("shared", method.StaticModifier!.Text);
        Assert.NotNull(method.Body);
    }

    [Fact]
    public void StaticAndInstance_Methods_CanCoexistInInterface()
    {
        const string source = """
            package P
            interface IBoth {
                shared {
                    func S() int32;
                }
                func I() int32;
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IBoth");
        var methods = iface.Methods.ToArray();
        Assert.Equal(2, methods.Length);
        var staticMethod = methods.Single(m => m.HasStaticModifier);
        var instanceMethod = methods.Single(m => !m.HasStaticModifier);
        Assert.Equal("S", staticMethod.Identifier.Text);
        Assert.Equal("I", instanceMethod.Identifier.Text);
    }

    [Fact]
    public void PrivateSharedFunc_CarriesStaticAndPrivateModifiers()
    {
        const string source = """
            package P
            interface IFoo {
                shared {
                    private func Helper() int32 { return 0 }
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var iface = FindInterface(tree, "IFoo");
        var method = iface.Methods.Single();
        Assert.True(method.HasStaticModifier);
        Assert.NotNull(method.AccessibilityModifier);
        Assert.Equal("private", method.AccessibilityModifier!.Text);
    }

    [Fact]
    public void RemovedStaticFuncModifier_IsRejected()
    {
        // Issue #865 revision: `static` is no longer a contextual keyword on
        // interface members. The old `static func` form now falls through to
        // the generic "unexpected token" parser error (GS0005).
        const string source = "package P\ninterface IFoo {\n  static func F() int32\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void NonFunc_InInterfaceSharedBlock_ReportsGS0330()
    {
        // Issue #1030: `var`/`let`/`const` interface static state and `prop`
        // static-virtual properties parse cleanly inside a shared block. A
        // non-field, non-func, non-prop member (e.g. `event`) is still
        // rejected with GS0330.
        const string source = """
            package P
            interface IFoo {
                shared {
                    event Changed System.Action
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0330");
    }

    [Fact]
    public void StaticFieldVarLetConst_InInterfaceSharedBlock_ParsesCleanly()
    {
        // Issue #1030: interface static *state* — `var`/`let`/`const` fields
        // in an interface shared block parse without diagnostics.
        const string source = """
            package P
            interface ICounter {
                shared {
                    var Count int32
                    let Label string = "c"
                    const Max int32 = 100
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0330");
        var iface = FindInterface(tree, "ICounter");
        Assert.Equal(3, iface.StaticFields.Length);
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
