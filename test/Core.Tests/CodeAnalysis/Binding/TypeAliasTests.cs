// <copyright file="TypeAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.7: <c>type UserId = int</c> declares a name that resolves to
/// the underlying type. Aliases are erased — no CIL is emitted for them.
/// </summary>
public class TypeAliasTests
{
    [Fact]
    public void TypeAlias_To_Int_Binds_VariableDeclaration()
    {
        Assert.Empty(Bind("type UserId = int\nfunc F() {\n let id UserId = 7\n }\n"));
    }

    [Fact]
    public void TypeAlias_Allows_Chained_Aliases()
    {
        Assert.Empty(Bind("type A = int\ntype B = A\nfunc F() {\n let x B = 1\n }\n"));
    }

    [Fact]
    public void TypeAlias_AssignmentTypeIncompatible_Reports_Error()
    {
        var diagnostics = Bind("type UserId = int\nfunc F() {\n let id UserId = \"x\"\n }\n");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void TypeAlias_ToUnknownType_Reports_Error()
    {
        var diagnostics = Bind("type X = NotAType\n");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void TypeAlias_Cannot_Shadow_Primitive()
    {
        var diagnostics = Bind("type int = string\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("already declared", System.StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("byte")]
    [InlineData("sbyte")]
    [InlineData("short")]
    [InlineData("ushort")]
    [InlineData("uint")]
    [InlineData("long")]
    [InlineData("ulong")]
    [InlineData("nint")]
    [InlineData("nuint")]
    [InlineData("float32")]
    [InlineData("float64")]
    [InlineData("decimal")]
    [InlineData("char")]
    [InlineData("object")]
    public void TypeAlias_Cannot_Shadow_New_Primitives(string primitiveName)
    {
        // ADR-0044 / ADR-0045: each primitive added in issue #142 must be
        // rejected as a redeclaration target, matching the existing
        // bool/int/string behaviour.
        var diagnostics = Bind($"type {primitiveName} = string\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("already declared", System.StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("byte")]
    [InlineData("sbyte")]
    [InlineData("short")]
    [InlineData("ushort")]
    [InlineData("uint")]
    [InlineData("long")]
    [InlineData("ulong")]
    [InlineData("nint")]
    [InlineData("nuint")]
    [InlineData("float32")]
    [InlineData("float64")]
    [InlineData("decimal")]
    [InlineData("char")]
    [InlineData("object")]
    public void TypeClause_Resolves_New_Primitive_As_Alias_Target(string primitiveName)
    {
        // The new keywords must be reachable from any type-clause position.
        // A type alias to one of them is the smallest exercise that does not
        // depend on the Phase 3 conversion table.
        var diagnostics = Bind($"type X = {primitiveName}\n");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TypeAlias_Duplicate_Reports_Error()
    {
        var diagnostics = Bind("type A = int\ntype A = string\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("already declared", System.StringComparison.OrdinalIgnoreCase));
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
