// <copyright file="Issue1007GenericInterfaceMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1007: a generic method declared inside an interface body
/// (<c>func IsPrim[T]() bool;</c>) failed to parse and therefore never bound.
/// The interface-member binding path now binds the method's generic
/// type-parameter list (mirroring class methods), producing a
/// <see cref="FunctionSymbol"/> with arity &gt; 0. An implementing class can
/// satisfy the generic slot, and a generic-arity mismatch is still rejected
/// with GS0187.
/// </summary>
public class Issue1007GenericInterfaceMethodTests
{
    [Fact]
    public void GenericInterfaceMethod_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            interface A { func IsPrim[T]() bool; }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenericInterfaceMethod_RecordsTypeParametersOnMethodSymbol()
    {
        const string source = """
            package t
            interface A { func IsPrim[T]() bool; }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var iface = compilation.GlobalScope.Interfaces.Single(i => i.Name == "A");
        var method = iface.Methods.Single(m => m.Name == "IsPrim");
        Assert.True(method.IsGeneric);
        Assert.Single(method.TypeParameters);
        Assert.Equal("T", method.TypeParameters[0].Name);
    }

    [Fact]
    public void GenericInterfaceMethod_MultipleTypeParameters_RecordsArityTwo()
    {
        const string source = """
            package t
            interface A { func Pair[T, U](a T, b U) U; }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var iface = compilation.GlobalScope.Interfaces.Single(i => i.Name == "A");
        var method = iface.Methods.Single(m => m.Name == "Pair");
        Assert.True(method.IsGeneric);
        Assert.Equal(2, method.TypeParameters.Length);
        Assert.Equal("T", method.TypeParameters[0].Name);
        Assert.Equal("U", method.TypeParameters[1].Name);
    }

    [Fact]
    public void ClassImplementingGenericInterfaceMethod_SatisfiesContract()
    {
        const string source = """
            package t
            interface A { func Echo[T](x T) T; }
            class C : A {
                func Echo[T](x T) T { return x }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ClassImplementingGenericInterfaceMethod_MultipleTypeParameters_SatisfiesContract()
    {
        const string source = """
            package t
            interface A { func Pair[T, U](a T, b U) U; }
            class C : A {
                func Pair[T, U](a T, b U) U { return b }
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ClassWithNonGenericMethod_DoesNotSatisfyGenericInterfaceMethod_ReportsGS0187()
    {
        // A same-name non-generic class method has a different arity and must
        // not be treated as implementing the generic interface slot.
        const string source = """
            package t
            interface A { func Echo[T](x T) T; }
            class C : A {
                func Echo(x int32) int32 { return x }
            }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    [Fact]
    public void CallingGenericInterfaceMethodWithExplicitTypeArg_BindsCleanly()
    {
        const string source = """
            package t
            import System
            interface A { func Echo[T](x T) T; }
            class C : A {
                func Echo[T](x T) T { return x }
            }
            var a A = C()
            Console.WriteLine(a.Echo[int32](42))
            """;
        Assert.Empty(Bind(source));
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
