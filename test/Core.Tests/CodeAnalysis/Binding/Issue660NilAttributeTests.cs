// <copyright file="Issue660NilAttributeTests.cs" company="GSharp">
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
/// Issue #660: tests for nil/null behaviour in attribute arguments.
/// </summary>
public class Issue660NilAttributeTests
{
    [Fact]
    public void Nil_In_Obsolete_Attribute_Succeeds()
    {
        // nil as a string argument to @Obsolete should work since string accepts null.
        var source = """
            import System

            @Obsolete(nil)
            func Helper() {
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.Empty(globalScope.Diagnostics);
    }

    [Fact]
    public void Null_Identifier_Reports_GS0273_Instead_Of_GS0125()
    {
        // Using C# spelling 'null' should produce GS0273 (friendly "use nil" message)
        // instead of the generic GS0125 "Variable 'null' doesn't exist".
        var source = """
            import System

            @Obsolete(null)
            func Helper() {
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        var diags = globalScope.Diagnostics.ToList();
        Assert.Contains(diags, d => d.Id == "GS0273");
        Assert.DoesNotContain(diags, d => d.Id == "GS0125");
    }

    [Fact]
    public void Null_Identifier_Message_Suggests_Nil()
    {
        var source = """
            import System

            @Obsolete(null)
            func Helper() {
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        var diag = globalScope.Diagnostics.First(d => d.Id == "GS0273");
        Assert.Contains("nil", diag.Message);
    }

    [Fact]
    public void Nil_In_Attribute_ParamsArray_Succeeds()
    {
        // nil in a params string[] attribute arg (like @MemberNotNull)
        var source = """
            import System.Diagnostics.CodeAnalysis

            type Box class {
                @MemberNotNull(nil)
                func Setup() {
                }
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.Empty(globalScope.Diagnostics);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
