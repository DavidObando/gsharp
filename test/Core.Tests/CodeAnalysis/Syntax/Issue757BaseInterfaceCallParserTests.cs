// <copyright file="Issue757BaseInterfaceCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0091 / issue #757: parser surface tests for the explicit-base
/// interface-call expression <c>base[IFoo].Method(args)</c>. Verifies
/// that the new shape parses cleanly, that the existing constructor
/// chaining form (<c>init(...) : base(args)</c>) and ordinary uses of
/// the identifier <c>base</c> are unaffected, and that ill-formed shapes
/// produce parser diagnostics rather than silently mis-parsing.
/// </summary>
public class Issue757BaseInterfaceCallParserTests
{
    [Fact]
    public void BaseInterfaceCall_Parses()
    {
        const string source = """
            package P
            interface IFoo {
                func M() int32 { return 1 }
            }
            class C : IFoo {
                func M() int32 {
                    return base[IFoo].M()
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void BaseInterfaceCall_WithArguments_Parses()
    {
        const string source = """
            package P
            interface IFoo {
                func M(x int32, y int32) int32 { return x + y }
            }
            class C : IFoo {
                func M(x int32, y int32) int32 {
                    return base[IFoo].M(x, y)
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void BaseInterfaceCall_Chaining_Parses()
    {
        const string source = """
            package P
            interface IA {
                func M() int32 { return 1 }
            }
            interface IB {
                func M() int32 { return 2 }
            }
            class C : IA, IB {
                func M() int32 {
                    return base[IA].M() + base[IB].M()
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ConstructorChaining_BaseCall_StillParses()
    {
        // ADR-0091: the `init(...) : base(args)` shape must remain
        // unaffected by the contextual `base[` recognition — `base(`
        // (paren) is the chain form, `base[` (bracket) is the new form.
        const string source = """
            package P
            class B {
                init(x int32) { }
            }
            class D {
                init(x int32) : base(x) { }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void IdentifierNamedBase_StillParses()
    {
        // `base` is a contextual identifier — using it as a local
        // variable name must still work outside the `base[...]` shape.
        const string source = """
            package P
            func F() int32 {
                var base = 5
                return base
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void BaseInterfaceCall_NodeShape_IsBaseInterfaceCallExpression()
    {
        // Verifies the bracketed form lands on a
        // BaseInterfaceCallExpressionSyntax node, not on the generic
        // IndexExpression path.
        const string source = """
            package P
            interface IFoo {
                func M() int32 { return 1 }
            }
            class C : IFoo {
                func M() int32 {
                    return base[IFoo].M()
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var found = FindFirst<BaseInterfaceCallExpressionSyntax>(tree.Root);

        Assert.NotNull(found);
        Assert.Equal(SyntaxKind.BaseInterfaceCallExpression, found.Kind);
        Assert.Equal("base", found.BaseKeyword.Text);
        Assert.Equal("M", found.MethodIdentifier.Text);
        Assert.Empty(found.Arguments);
    }

    private static T FindFirst<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T match)
        {
            return match;
        }

        foreach (var child in root.GetChildren())
        {
            var found = FindFirst<T>(child);
            if (found != null)
            {
                return found;
            }
        }

        return null;
    }
}
