// <copyright file="Adr0174SuspendFuncParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0174 D4: <c>suspend</c> is a reserved keyword that takes the same
/// modifier slot as <c>async</c> before <c>func</c> — on top-level functions,
/// class and struct methods, <c>shared</c> methods, and receiver-clause
/// functions — and a declaration is exactly one of <c>async</c> or
/// <c>suspend</c>.
/// </summary>
public class Adr0174SuspendFuncParserTests
{
    [Fact]
    public void Suspend_IsAKeyword()
    {
        Assert.Equal(SyntaxKind.SuspendKeyword, SyntaxFacts.GetKeywordKind("suspend"));
        Assert.Equal("suspend", SyntaxFacts.GetText(SyntaxKind.SuspendKeyword));
    }

    [Fact]
    public void TopLevelFunction_ParsesWithSuspendModifier()
    {
        var tree = SyntaxTree.Parse("""
            package P
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.DescendantNodes().OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(function.IsSuspend);
        Assert.False(function.IsAsync);
        Assert.Equal(SyntaxKind.SuspendKeyword, function.AsyncModifier?.Kind);
    }

    [Fact]
    public void AccessibilityAndUnsafe_ComposeWithSuspend()
    {
        var tree = SyntaxTree.Parse("""
            package P
            private suspend func a() {
            }
            unsafe suspend func b() {
            }
            public unsafe suspend func c() int32 {
                return 1
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var functions = tree.Root.DescendantNodes().OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(3, functions.Length);
        Assert.All(functions, f => Assert.True(f.IsSuspend));
        Assert.True(functions[1].IsUnsafe);
        Assert.True(functions[2].IsUnsafe);
    }

    [Fact]
    public void ClassMethods_ParseWithSuspendModifier()
    {
        var tree = SyntaxTree.Parse("""
            package P
            class Pump {
                var ch chan[int32]
                suspend func Take() int32 {
                    return <-ch
                }
                public suspend func Put(v int32) {
                    ch <- v
                }
                shared {
                    suspend func Make() int32 {
                        return 1
                    }
                }
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var methods = tree.Root.DescendantNodes().OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(3, methods.Length);
        Assert.All(methods, m => Assert.True(m.IsSuspend));
    }

    [Fact]
    public void ReceiverClauseFunction_ParsesWithSuspendModifier()
    {
        var tree = SyntaxTree.Parse("""
            package P
            struct Box {
                var ch chan[int32]
            }
            suspend func (b Box) Take() int32 {
                return <-b.ch
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.DescendantNodes().OfType<FunctionDeclarationSyntax>().Single(f => f.Receiver != null);
        Assert.True(function.IsSuspend);
    }

    [Fact]
    public void AsyncSuspend_IsRejected()
    {
        var tree = SyntaxTree.Parse("""
            package P
            async suspend func f() {
            }
            """);

        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Suspend_IsNotAnIdentifier()
    {
        var tree = SyntaxTree.Parse("""
            package P
            let suspend = 1
            """);

        Assert.NotEmpty(tree.Diagnostics);
    }
}
