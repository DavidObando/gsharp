// <copyright file="Issue709NullCoalescingAssignmentBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #709 / ADR-0072: binder-level coverage for <c>??=</c>. Validates
/// the new diagnostics (GS0298 non-nullable LHS, GS0299 non-assignable LHS),
/// re-uses GS0127 for readonly LHS, accepts nullable reference / nullable
/// value-type / field / property / indexer LHS shapes, and surfaces the
/// usual RHS-conversion diagnostics.
/// </summary>
public class Issue709NullCoalescingAssignmentBindingTests
{
    [Fact]
    public void Accepts_NullableString_Local()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var x string? = nil
                x ??= "v"
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Accepts_NullableInt32_Local()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var x int32? = nil
                x ??= 42
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Reports_GS0298_When_LHS_Is_NonNullable_String()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var x = "hello"
                x ??= "v"
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0298");
    }

    [Fact]
    public void Reports_GS0298_When_LHS_Is_NonNullable_Int32()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var x = 1
                x ??= 2
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0298");
    }

    [Fact]
    public void Reports_GS0127_When_LHS_Is_ReadOnly_Local()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                let x string? = nil
                x ??= "v"
            }
            """);
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Reports_GS0298_OnRhs_When_LHS_Is_NonNullable_Field()
    {
        var diagnostics = Bind("""
            package P
            type Box class {
                var Name string
            }
            func F() {
                var b = Box{Name: "x"}
                b.Name ??= "v"
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0298");
    }

    [Fact]
    public void Accepts_Nullable_Field_LHS()
    {
        var diagnostics = Bind("""
            package P
            type Box class {
                var Name string?
            }
            func F() {
                var b = Box{}
                b.Name ??= "v"
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Accepts_Nullable_Property_LHS()
    {
        var diagnostics = Bind("""
            package P
            type Person class {
                prop Name string?
            }
            func F() {
                var p = Person{}
                p.Name ??= "Alice"
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Accepts_Nullable_Indexer_LHS()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var m = map[string]string?{}
                m["k"] = nil
                m["k"] ??= "v"
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Reports_Conversion_When_Rhs_DoesNotConvert()
    {
        // RHS is int — does not convert to string?. The conversion path
        // surfaces the usual GS0129 / GS0030 family of diagnostics.
        var diagnostics = Bind("""
            package P
            func F() {
                var x string? = nil
                x ??= 42
            }
            """);
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void Accepts_Rhs_Of_UnderlyingType_LiftsToNullable()
    {
        // Author can write `string` on the RHS even when LHS is `string?`;
        // the implicit `T -> T?` conversion lifts it.
        var diagnostics = Bind("""
            package P
            func F() {
                var x string? = nil
                x ??= "lifted"
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Accepts_Rhs_Of_Nullable_Type_Directly()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var x string? = nil
                var y string? = nil
                x ??= y
            }
            """);
        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any(d => d.IsError))
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any(d => d.IsError))
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
