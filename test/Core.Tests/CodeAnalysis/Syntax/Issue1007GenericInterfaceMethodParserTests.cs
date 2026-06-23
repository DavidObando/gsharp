// <copyright file="Issue1007GenericInterfaceMethodParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1007: a generic method declared inside an interface body — e.g.
/// <c>func IsPrim[T]() bool;</c> — failed to parse with GS0005 ("unexpected
/// token <c>[</c>, expected <c>(</c>"), even though generic methods parse fine
/// on classes and as free functions. The interface-member method parser now
/// reuses the same optional type-parameter-list parsing the class / free
/// function path uses. These tests pin the parser-level shape: the
/// type-parameter list is captured on
/// <see cref="FunctionDeclarationSyntax.TypeParameterList"/> with no
/// diagnostics.
/// </summary>
public class Issue1007GenericInterfaceMethodParserTests
{
    [Fact]
    public void GenericInterfaceMethod_SingleTypeParameter_ParsesWithoutDiagnostics()
    {
        const string source = """
            package t
            interface A { func IsPrim[T]() bool; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var method = tree.Root.Members
            .OfType<InterfaceDeclarationSyntax>()
            .Single()
            .Methods
            .Single();

        Assert.True(method.IsGeneric);
        Assert.NotNull(method.TypeParameterList);
        Assert.Equal(1, method.TypeParameterList.Parameters.Count);
        Assert.Equal("T", method.TypeParameterList.Parameters[0].Identifier.Text);
    }

    [Fact]
    public void GenericInterfaceMethod_MultipleTypeParameters_ParsesWithoutDiagnostics()
    {
        const string source = """
            package t
            interface A { func Pair[T, U](a T, b U) U; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var method = tree.Root.Members
            .OfType<InterfaceDeclarationSyntax>()
            .Single()
            .Methods
            .Single();

        Assert.True(method.IsGeneric);
        Assert.Equal(2, method.TypeParameterList.Parameters.Count);
        Assert.Equal("T", method.TypeParameterList.Parameters[0].Identifier.Text);
        Assert.Equal("U", method.TypeParameterList.Parameters[1].Identifier.Text);
    }

    [Fact]
    public void NonGenericInterfaceMethod_HasNoTypeParameterList()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var method = tree.Root.Members
            .OfType<InterfaceDeclarationSyntax>()
            .Single()
            .Methods
            .Single();

        Assert.False(method.IsGeneric);
        Assert.Null(method.TypeParameterList);
    }
}
